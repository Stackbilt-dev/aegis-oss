// Stub — full implementation not yet extracted to OSS

import { recordMemory } from './index.js';

export type InsightType = 'pattern' | 'heuristic' | 'procedure' | 'principle';

export interface InsightPayload {
  fact: string;
  insight_type: InsightType;
  origin_repo: string;
  keywords: string[];
  confidence: number;
}

// ─── Context-specific detection ─────────────────────────────

const CONTEXT_PATTERNS = [
  /\/home\/|\/Users\/|\/tmp\/|[A-Z]:\\/i,              // hardcoded paths
  /\$[A-Z_]+/,                                          // env vars like $CLOUDFLARE_API_TOKEN
  /process\.env\./,                                      // process.env references
];

const GENERAL_PATTERN_SIGNALS = [
  /always/i, /never/i, /when using/i, /to prevent/i, /best practice/i,
  /validate.*before/i, /ensure/i,
];

function isContextSpecific(fact: string): boolean {
  const hasContextMarker = CONTEXT_PATTERNS.some(p => p.test(fact));
  if (!hasContextMarker) {
    // Check for single-file references without general pattern language
    const fileRef = /\b\w+\.\w{1,4}\b/.test(fact) && /line \d+|off-by-one|bug found in/i.test(fact);
    if (fileRef) {
      const hasGeneralLanguage = GENERAL_PATTERN_SIGNALS.some(p => p.test(fact));
      return !hasGeneralLanguage;
    }
    return false;
  }
  return true;
}

function hashFact(fact: string): string {
  let hash = 0;
  for (let i = 0; i < fact.length; i++) {
    const char = fact.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── publishInsight ─────────────────────────────────────────

export async function publishInsight(
  db: D1Database,
  payload: InsightPayload,
  memBinding?: any,
): Promise<{ published: boolean; reason?: string }> {
  if (payload.confidence < 0.75) {
    return { published: false, reason: 'confidence too low (min 0.75)' };
  }

  if (isContextSpecific(payload.fact)) {
    return { published: false, reason: 'context-specific insight rejected' };
  }

  const factHash = hashFact(payload.fact);

  // Check for duplicates
  const existing = await db.prepare(
    'SELECT id FROM memory WHERE fact_hash = ?'
  ).bind(factHash).first();

  if (existing) {
    return { published: false, reason: 'duplicate insight (hash match)' };
  }

  if (memBinding) {
    await memBinding.store('default', [{
      fact: payload.fact,
      keywords: payload.keywords,
      confidence: payload.confidence,
    }]);
    await db.prepare(
      'INSERT INTO memory (fact_hash, fact, confidence) VALUES (?, ?, ?)'
    ).bind(factHash, payload.fact, payload.confidence).run();
  } else {
    await recordMemory(db, 'insight', payload.fact, payload.confidence, 'insights');
  }

  return { published: true };
}

// ─── validateInsight ────────────────────────────────────────

const TERMINAL_STAGES = ['canonical', 'refuted'];
const STAGE_ORDER = ['candidate', 'validated', 'expert', 'canonical', 'refuted'];

export async function validateInsight(
  db: D1Database,
  factHash: string,
  repo: string,
  confirmed: boolean,
): Promise<{ stage: string; transitioned: boolean }> {
  const row = await db.prepare(
    'SELECT id, validation_stage, validators, fact FROM memory WHERE fact_hash = ?'
  ).bind(factHash).first<{ id: number; validation_stage: string; validators: string; fact: string }>();

  if (!row) {
    return { stage: 'candidate', transitioned: false };
  }

  if (TERMINAL_STAGES.includes(row.validation_stage)) {
    return { stage: row.validation_stage, transitioned: false };
  }

  let validators: Array<{ repo: string; confirmed: boolean; date: string }> = [];
  try {
    validators = JSON.parse(row.validators);
    if (!Array.isArray(validators)) validators = [];
  } catch {
    validators = [];
  }

  if (!confirmed) {
    await db.prepare(
      'UPDATE memory SET validation_stage = ?, validators = ? WHERE id = ?'
    ).bind('refuted', JSON.stringify([...validators, { repo, confirmed, date: new Date().toISOString().slice(0, 10) }]), row.id).run();
    return { stage: 'refuted', transitioned: true };
  }

  validators.push({ repo, confirmed: true, date: new Date().toISOString().slice(0, 10) });
  const confirmedCount = validators.filter(v => v.confirmed).length;

  let newStage = row.validation_stage;
  let transitioned = false;

  if (row.validation_stage === 'candidate') {
    newStage = 'validated';
    transitioned = true;
  } else if (row.validation_stage === 'validated' && confirmedCount >= 2) {
    newStage = 'expert';
    transitioned = true;
  }

  await db.prepare(
    'UPDATE memory SET validation_stage = ?, validators = ? WHERE id = ?'
  ).bind(newStage, JSON.stringify(validators), row.id).run();

  return { stage: newStage, transitioned };
}

// ─── promoteInsight ─────────────────────────────────────────

export async function promoteInsight(
  db: D1Database,
  factHash: string,
  targetStage: string,
): Promise<{ success: boolean; reason?: string }> {
  const row = await db.prepare(
    'SELECT id, validation_stage FROM memory WHERE fact_hash = ?'
  ).bind(factHash).first<{ id: number; validation_stage: string }>();

  if (!row) {
    return { success: false, reason: 'Insight not found' };
  }

  const currentIdx = STAGE_ORDER.indexOf(row.validation_stage);
  const targetIdx = STAGE_ORDER.indexOf(targetStage);

  if (targetIdx <= currentIdx) {
    return { success: false, reason: 'Can only promote forward' };
  }

  if (targetStage === 'canonical' && row.validation_stage !== 'expert') {
    return { success: false, reason: 'canonical promotion requires expert stage' };
  }

  await db.prepare(
    'UPDATE memory SET validation_stage = ? WHERE id = ?'
  ).bind(targetStage, row.id).run();

  return { success: true };
}

// ─── listInsights ───────────────────────────────────────────

export async function listInsights(
  db: D1Database,
  opts?: { stage?: string },
): Promise<Array<{
  id: number;
  fact: string;
  fact_hash: string;
  validation_stage: string;
  confidence: number;
  insight_type: string | null;
  origin_repo: string | null;
  validators: Array<{ repo: string; confirmed: boolean; date: string }>;
  created_at: string;
}>> {
  try {
    let query = 'SELECT id, fact, fact_hash, validation_stage, confidence, validators, created_at FROM memory';
    const bindings: unknown[] = [];

    if (opts?.stage) {
      query += ' WHERE validation_stage = ?';
      bindings.push(opts.stage);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = db.prepare(query);
    const result = bindings.length > 0
      ? await stmt.bind(...bindings).all<any>()
      : await stmt.all<any>();

    return result.results.map((r: any) => ({
      ...r,
      insight_type: r.insight_type ?? null,
      origin_repo: r.origin_repo ?? null,
      validators: (() => {
        try { const v = JSON.parse(r.validators); return Array.isArray(v) ? v : []; } catch { return []; }
      })(),
    }));
  } catch {
    return [];
  }
}

// ─── getInsightDetail ───────────────────────────────────────

export async function getInsightDetail(
  db: D1Database,
  factHash: string,
): Promise<{
  id: number;
  fact: string;
  fact_hash: string;
  validation_stage: string;
  confidence: number;
  validators: Array<{ repo: string; confirmed: boolean; date: string }>;
  created_at: string;
} | null> {
  const row = await db.prepare(
    'SELECT id, fact, fact_hash, validation_stage, confidence, validators, created_at FROM memory WHERE fact_hash = ?'
  ).bind(factHash).first<any>();

  if (!row) return null;

  let validators: any[] = [];
  try {
    const parsed = JSON.parse(row.validators);
    validators = Array.isArray(parsed) ? parsed : [];
  } catch {
    validators = [];
  }

  return { ...row, validators };
}

// ─── getInsightStats ────────────────────────────────────────

export async function getInsightStats(
  db: D1Database,
): Promise<{
  total: number;
  by_stage: Record<string, number>;
  pending_review: number;
  new_since_last_week: number;
}> {
  try {
    const totalRow = await db.prepare(
      'SELECT COUNT(*) as cnt FROM memory'
    ).first<{ cnt: number }>();

    const newRow = await db.prepare(
      "SELECT COUNT(*) as cnt FROM memory WHERE created_at > datetime('now', '-7 days')"
    ).first<{ cnt: number }>();

    const byStageRows = await db.prepare(
      'SELECT validation_stage, COUNT(*) as cnt FROM memory GROUP BY validation_stage'
    ).all<{ validation_stage: string; cnt: number }>();

    const by_stage: Record<string, number> = {};
    for (const row of byStageRows.results) {
      by_stage[row.validation_stage] = row.cnt;
    }

    return {
      total: totalRow?.cnt ?? 0,
      by_stage,
      pending_review: by_stage['validated'] ?? 0,
      new_since_last_week: newRow?.cnt ?? 0,
    };
  } catch {
    return { total: 0, by_stage: {}, pending_review: 0, new_since_last_week: 0 };
  }
}

// ─── archiveInsight ─────────────────────────────────────────

export async function archiveInsight(
  db: D1Database,
  factHash: string,
  reason: string,
): Promise<{ success: boolean }> {
  try {
    const result = await db.prepare(
      "UPDATE memory SET validation_stage = 'archived', archive_reason = ? WHERE fact_hash = ?"
    ).bind(reason, factHash).run();
    return { success: (result.meta as any)?.changes > 0 };
  } catch {
    return { success: false };
  }
}
