import type { EpisodicEntry } from '../types.js';
import { EPISODIC_OUTCOMES, isValidEnum, type EpisodicOutcome } from '../../schema-enums.js';

// ─── Outcome Sanitization ───────────────────────────────────
// D1 CHECK constraints only allow specific values.
// Guard at the DB boundary so rogue values never reach SQLite.

/** Map any outcome to a valid episodic_memory value. */
export function sanitizeEpisodicOutcome(raw: string | null | undefined): EpisodicOutcome {
  if (isValidEnum(EPISODIC_OUTCOMES, raw)) return raw;
  // partial_failure, error, blocked, empty string, null → failure
  return 'failure';
}

// ─── Episodic Memory ─────────────────────────────────────────

export async function recordEpisode(db: D1Database, entry: Omit<EpisodicEntry, 'id' | 'created_at'>): Promise<void> {
  const safeOutcome = sanitizeEpisodicOutcome(entry.outcome);
  await db.prepare(
    'INSERT INTO episodic_memory (intent_class, channel, summary, outcome, cost, latency_ms, near_miss, classifier_confidence, reclassified, thread_id, executor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    entry.intent_class, entry.channel, entry.summary, safeOutcome,
    entry.cost, entry.latency_ms, entry.near_miss ?? null,
    entry.classifier_confidence ?? null, entry.reclassified ? 1 : 0,
    entry.thread_id ?? null, entry.executor ?? null,
  ).run();
}

/** Retroactively mark the last episode in a thread as a semantic failure */
export async function retrogradeEpisode(db: D1Database, threadId: string): Promise<EpisodicEntry | null> {
  const last = await db.prepare(
    "SELECT * FROM episodic_memory WHERE thread_id = ? AND outcome = 'success' ORDER BY created_at DESC LIMIT 1"
  ).bind(threadId).first<EpisodicEntry>();
  if (!last) return null;

  await db.prepare(
    "UPDATE episodic_memory SET outcome = 'failure' WHERE id = ?"
  ).bind(last.id).run();

  return last;
}

export async function getRecentEpisodes(db: D1Database, intentClass: string, limit: number = 5): Promise<EpisodicEntry[]> {
  const result = await db.prepare(
    'SELECT * FROM episodic_memory WHERE intent_class = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(intentClass, limit).all();
  return result.results as unknown as EpisodicEntry[];
}

export async function getEpisodeStats(db: D1Database, intentClass: string): Promise<{
  count: number;
  successRate: number;
  avgCost: number;
  avgLatency: number;
} | null> {
  const row = await db.prepare(`
    SELECT
      COUNT(*) as count,
      AVG(CASE WHEN outcome = 'success' THEN 1.0 ELSE 0.0 END) as success_rate,
      AVG(cost) as avg_cost,
      AVG(latency_ms) as avg_latency
    FROM episodic_memory WHERE intent_class = ?
  `).bind(intentClass).first<{ count: number; success_rate: number; avg_cost: number; avg_latency: number }>();

  if (!row || row.count === 0) return null;
  return {
    count: row.count,
    successRate: row.success_rate,
    avgCost: row.avg_cost,
    avgLatency: row.avg_latency,
  };
}

// ─── Stats by (intent_class, complexity_tier) — derived-stats path ──
// aegis#563 + aegis#564: stats keyed by (intent_class, complexity_tier) —
// matches procedural_memory's procedureKey shape so the projection-source
// path can derive procedural aggregates at read time.
//
// The helpers rely on episodic_memory.complexity_tier (added in the same
// schema migration that adds these functions). Rows without a tier value
// are excluded from derived results by the WHERE complexity_tier IS NOT
// NULL guard. Consumers that want stricter protection against retroactive
// backfills can add their own time-based filter in a wrapper.

export async function getEpisodeStatsByComplexity(
  db: D1Database,
  intentClass: string,
  complexityTier: string,
): Promise<{
  count: number;
  successCount: number;
  successRate: number;
  avgCost: number;
  avgLatency: number;
  lastUsed: string | null;
} | null> {
  // SUM(CASE outcome='success' ...) returns an exact integer — don't
  // reconstruct successCount from count * avgSuccessRate downstream (FP
  // rounding on ugly rates would break strict-equality drift checks).
  const row = await db.prepare(`
    SELECT
      COUNT(*) as count,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success_count,
      AVG(cost) as avg_cost,
      AVG(latency_ms) as avg_latency,
      MAX(created_at) as last_used
    FROM episodic_memory
    WHERE intent_class = ?
      AND complexity_tier = ?
  `).bind(intentClass, complexityTier).first<{
    count: number;
    success_count: number;
    avg_cost: number;
    avg_latency: number;
    last_used: string | null;
  }>();

  if (!row || row.count === 0) return null;
  return {
    count: row.count,
    successCount: row.success_count,
    successRate: row.count > 0 ? row.success_count / row.count : 0,
    avgCost: row.avg_cost,
    avgLatency: row.avg_latency,
    lastUsed: row.last_used,
  };
}

// aegis#564 Phase 2: bulk variant for dashboard / observability / decision-docs.
// One GROUP BY intent_class, complexity_tier scan covers both the derived
// slice (non-null tier) and the pre-tier ghost slice (NULL tier) so callers
// avoid N+1 queries. Returns a Map keyed on intent_class with nested
// derived-by-tier and the pre-tier count.
export interface EpisodeStatsAggregate {
  derived: Record<string, {
    count: number;
    successCount: number;
    failCount: number;
    avgCost: number;
    avgLatency: number;
    lastUsed: string | null;
  }>;
  preTierCount: number;
}

export async function getAllEpisodeStatsByComplexity(
  db: D1Database,
): Promise<Map<string, EpisodeStatsAggregate>> {
  // Single scan: grouping on (intent_class, complexity_tier) folds both
  // derived (non-null tier) and pre-tier (NULL tier) rows into one query.
  const result = await db.prepare(`
    SELECT
      intent_class,
      complexity_tier,
      COUNT(*) as count,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success_count,
      AVG(cost) as avg_cost,
      AVG(latency_ms) as avg_latency,
      MAX(created_at) as last_used
    FROM episodic_memory
    GROUP BY intent_class, complexity_tier
  `).all<{
    intent_class: string;
    complexity_tier: string | null;
    count: number;
    success_count: number;
    avg_cost: number;
    avg_latency: number;
    last_used: string | null;
  }>();

  const byClass = new Map<string, EpisodeStatsAggregate>();
  for (const row of result.results) {
    const entry = byClass.get(row.intent_class) ?? { derived: {}, preTierCount: 0 };
    if (row.complexity_tier === null) {
      entry.preTierCount = row.count;
    } else {
      entry.derived[row.complexity_tier] = {
        count: row.count,
        successCount: row.success_count,
        failCount: row.count - row.success_count,
        avgCost: row.avg_cost,
        avgLatency: row.avg_latency,
        lastUsed: row.last_used,
      };
    }
    byClass.set(row.intent_class, entry);
  }
  return byClass;
}

// ─── Conversation History ───────────────────────────────────

export async function getConversationHistory(
  db: D1Database,
  conversationId: string,
  limit: number = 20,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const result = await db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?'
  ).bind(conversationId, limit).all();
  return result.results as unknown as Array<{ role: 'user' | 'assistant'; content: string }>;
}

// ─── Token-aware history budgeting ──────────────────────────

// chars / 3.5 — matches Claude's ~3.5 chars per token empirically; no tokenizer needed on edge
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const MAX_CONTEXT_TOKENS = 200_000;  // Claude Sonnet context window
const OUTPUT_RESERVE    =   4_096;  // max_tokens in the API call
const OVERHEAD_RESERVE  =   8_000;  // system prompt + tools schema + buffer

export function budgetConversationHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxContextTokens = MAX_CONTEXT_TOKENS,
  overheadReserveTokens = OVERHEAD_RESERVE,
  outputReserveTokens = OUTPUT_RESERVE,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const available = maxContextTokens - overheadReserveTokens - outputReserveTokens;
  const result = [...history];
  let total = result.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const tokensBefore = total;

  while (total > available && result.length >= 2) {
    const dropped = result.splice(0, 2); // drop oldest user+assistant pair
    total -= dropped.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  const droppedPairs = (history.length - result.length) / 2;
  if (droppedPairs > 0) {
    console.warn(
      `[memory] history trimmed: dropped ${droppedPairs} turn${droppedPairs !== 1 ? 's' : ''} ` +
      `(~${tokensBefore} → ~${total} estimated tokens)`
    );
  }

  return result;
}
