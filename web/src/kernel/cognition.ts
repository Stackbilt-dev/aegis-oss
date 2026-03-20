// ─── Cognitive Layer: Narratives, State Precomputation, Warm Boot ─────
//
// Phase 1: Narrative maintenance + CognitiveState precomputation
// Phase 2: Knowledge graph (kg_nodes/kg_edges) — tables exist, code TBD
// Phase 3: Metacognitive memos + deep consolidation — tables exist, code TBD

import { askGroq } from '../groq.js';
import { PROPOSED_ACTION_PREFIX } from './memory/index.js';
import { activateGraph } from './memory/graph.js';
import { recallForQuery } from './memory/recall.js';
import type { CognitiveState } from './types.js';
import type { MemoryServiceBinding } from '../types.js';

// ─── Constants ───────────────────────────────────────────────

const MAX_ACTIVE_NARRATIVES = 10;
const NARRATIVE_STALE_DAYS = 7;

// ─── Narrative Arc Hash (djb2, same pattern as factHash) ─────

function arcHash(arc: string): string {
  const s = arc.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// ─── Narrative Maintenance Prompt ────────────────────────────

const NARRATIVE_SYSTEM = `You maintain narrative arcs for a persistent AI agent's memory. A narrative is NOT a fact — it's a thread: an ongoing situation with tension, progress, and resolution.

Good narratives: "LLC formation blocked on EIN wait", "OAuth migration across products", "Cost optimization push"
Bad narratives: "Operator uses Cloudflare" (fact, not story), "Had a conversation about billing" (event, not arc)

Given recent episodes and existing narratives, return a JSON array of operations:

Operations:
- UPDATE_BEAT: New development on existing narrative. Include id, summary, last_beat, tension.
- CREATE: Genuinely new multi-session story arc. Include arc (short_label), title, summary, tension, related_topics.
- RESOLVE: Arc reached conclusion. Include id, last_beat.
- STALL: No progress evident. Include id.
- NOOP: Nothing changed — return [].

Rules:
1. Max 2 operations per run.
2. Prefer UPDATE_BEAT over CREATE — don't fragment related events.
3. CREATE only for genuinely new threads spanning multiple sessions.
4. Narratives need tension — something unresolved. No tension = not a narrative.
5. Summaries: 2-4 sentences. last_beat: 1 sentence.
6. related_topics: use canonical memory topic names.

Return ONLY a JSON array, no markdown fences.`;

// ─── Narrative Maintenance ───────────────────────────────────

interface NarrativeOp {
  op: string;
  id?: number;
  arc?: string;
  title?: string;
  summary?: string;
  tension?: string;
  last_beat?: string;
  related_topics?: string[];
}

export async function maintainNarratives(
  db: D1Database,
  groqApiKey: string,
  groqModel: string,
  groqBaseUrl?: string,
): Promise<void> {
  // High-water mark (independent from episodic consolidation)
  const lastRun = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_narrative_at'"
  ).first<{ received_at: string }>();
  const since = lastRun?.received_at
    ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const episodes = await db.prepare(
    "SELECT intent_class, summary, outcome FROM episodic_memory WHERE created_at > ? AND channel != 'internal' ORDER BY created_at DESC LIMIT 15"
  ).bind(since).all<{ intent_class: string; summary: string; outcome: string }>();

  if (episodes.results.length < 3) return;

  const existing = await db.prepare(
    "SELECT id, arc, title, summary, tension, status FROM narratives WHERE status IN ('active', 'stalled') ORDER BY updated_at DESC LIMIT ?"
  ).bind(MAX_ACTIVE_NARRATIVES).all<{
    id: number; arc: string; title: string; summary: string; tension: string | null; status: string;
  }>();

  const narrativeCtx = existing.results.length > 0
    ? `\n\nExisting narratives:\n${existing.results.map(n =>
        `- [id=${n.id}] [${n.status}] "${n.title}": ${n.summary}${n.tension ? ` | Tension: ${n.tension}` : ''}`
      ).join('\n')}`
    : '\n\nNo existing narratives yet.';

  const userPrompt = `Recent episodes:\n${episodes.results.map((e, i) =>
    `${i + 1}. [${e.intent_class}/${e.outcome}] ${e.summary}`
  ).join('\n')}${narrativeCtx}`;

  let raw: string;
  try {
    raw = await askGroq(groqApiKey, groqModel, NARRATIVE_SYSTEM, userPrompt, groqBaseUrl);
  } catch (err) {
    console.warn('[cognition] Narrative maintenance Groq call failed:', err instanceof Error ? err.message : String(err));
    return;
  }

  if (!raw) return;
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let ops: NarrativeOp[];
  try {
    ops = JSON.parse(cleaned);
    if (!Array.isArray(ops)) return;
  } catch {
    console.warn('[cognition] Failed to parse narrative ops:', cleaned.slice(0, 200));
    return;
  }

  for (const op of ops.slice(0, 2)) {
    try {
      switch (op.op) {
        case 'CREATE': {
          if (!op.arc || !op.title || !op.summary) continue;
          const arc = String(op.arc).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
          const hash = arcHash(arc);

          // Dedup: skip if arc already exists
          const dup = await db.prepare(
            "SELECT id FROM narratives WHERE arc_hash = ? AND status IN ('active', 'stalled') LIMIT 1"
          ).bind(hash).first();
          if (dup) continue;

          // Cap: don't exceed max active narratives
          if (existing.results.length >= MAX_ACTIVE_NARRATIVES) continue;

          const topics = Array.isArray(op.related_topics) ? JSON.stringify(op.related_topics) : '[]';
          await db.prepare(
            'INSERT INTO narratives (arc, arc_hash, title, summary, tension, related_topics) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(arc, hash, String(op.title), String(op.summary), op.tension ? String(op.tension) : null, topics).run();
          console.log(`[cognition] Created narrative: "${op.title}"`);
          break;
        }
        case 'UPDATE_BEAT': {
          if (!op.id || !op.summary) continue;
          await db.prepare(
            `UPDATE narratives SET summary = ?, last_beat = ?, tension = ?,
             beat_count = beat_count + 1, updated_at = datetime('now')
             WHERE id = ? AND status IN ('active', 'stalled')`
          ).bind(
            String(op.summary),
            op.last_beat ? String(op.last_beat) : null,
            op.tension ? String(op.tension) : null,
            Number(op.id),
          ).run();
          console.log(`[cognition] Updated narrative #${op.id}`);
          break;
        }
        case 'RESOLVE': {
          if (!op.id) continue;
          await db.prepare(
            `UPDATE narratives SET status = 'resolved', last_beat = ?,
             resolved_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ? AND status IN ('active', 'stalled')`
          ).bind(op.last_beat ? String(op.last_beat) : 'Resolved', Number(op.id)).run();
          console.log(`[cognition] Resolved narrative #${op.id}`);
          break;
        }
        case 'STALL': {
          if (!op.id) continue;
          await db.prepare(
            "UPDATE narratives SET status = 'stalled', updated_at = datetime('now') WHERE id = ? AND status = 'active'"
          ).bind(Number(op.id)).run();
          console.log(`[cognition] Stalled narrative #${op.id}`);
          break;
        }
      }
    } catch (err) {
      console.warn(`[cognition] Narrative op ${op.op} failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Advance high-water mark
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_narrative_at', datetime('now'))"
  ).run();
}

// ─── Auto-stall Detection ────────────────────────────────────

export async function detectStaleNarratives(db: D1Database): Promise<void> {
  const staleDate = new Date(Date.now() - NARRATIVE_STALE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  await db.prepare(
    "UPDATE narratives SET status = 'stalled', updated_at = datetime('now') WHERE status = 'active' AND updated_at < ?"
  ).bind(staleDate).run();
}

// ─── Narrative Pruning (called from pruneMemory) ─────────────

export async function pruneNarratives(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  await db.prepare(
    "DELETE FROM narratives WHERE status IN ('resolved', 'abandoned') AND updated_at < ?"
  ).bind(cutoff).run();
}

// ─── CognitiveState Precomputation ───────────────────────────

export interface ProductPortfolioEntry {
  name: string;
  description: string;
  model: string;
  status: string;
  revenue?: string;
}

export async function precomputeCognitiveState(db: D1Database, productPortfolio?: ProductPortfolioEntry[], memoryBinding?: MemoryServiceBinding, mindspringFetcher?: Fetcher, mindspringToken?: string): Promise<void> {
  const start = Date.now();

  // Parallel reads — memory count from Memory Worker, rest from D1
  const [narrativesResult, openThreads, proposedActions, memoryHealthResult, episodeCount, heartbeatRow, recentEpisodeSummaries] = await Promise.all([
    db.prepare(
      "SELECT arc, title, summary, status, tension, last_beat, beat_count FROM narratives WHERE status IN ('active', 'stalled') ORDER BY updated_at DESC LIMIT ?"
    ).bind(MAX_ACTIVE_NARRATIVES).all<{
      arc: string; title: string; summary: string; status: string;
      tension: string | null; last_beat: string | null; beat_count: number;
    }>(),
    db.prepare(
      "SELECT COUNT(*) as cnt FROM agent_agenda WHERE status = 'active'"
    ).first<{ cnt: number }>(),
    db.prepare(
      `SELECT COUNT(*) as cnt FROM agent_agenda WHERE status = 'active' AND item LIKE ?`
    ).bind(`${PROPOSED_ACTION_PREFIX}%`).first<{ cnt: number }>(),
    memoryBinding
      ? memoryBinding.health().then(h => h.active_fragments).catch(() => 0)
      : db.prepare('SELECT COUNT(*) as cnt FROM memory_entries WHERE valid_until IS NULL').first<{ cnt: number }>().then(r => r?.cnt ?? 0),
    db.prepare(
      "SELECT COUNT(*) as cnt FROM episodic_memory WHERE created_at > datetime('now', '-24 hours')"
    ).first<{ cnt: number }>(),
    db.prepare(
      'SELECT severity FROM heartbeat_results ORDER BY created_at DESC LIMIT 1'
    ).first<{ severity: string }>(),
    // Fetch recent episode summaries for graph activation context
    db.prepare(
      "SELECT summary FROM episodic_memory WHERE created_at > datetime('now', '-6 hours') ORDER BY created_at DESC LIMIT 5"
    ).all<{ summary: string }>(),
  ]);

  // Phase 2: Recall pipeline — Blocks → Graph → Memory Worker → RRF Fusion
  let activatedNodes: Array<{ label: string; type: string; activation: number }> = [];
  try {
    const episodeSummaries = recentEpisodeSummaries?.results?.map(e => e.summary) ?? [];
    if (episodeSummaries.length > 0) {
      const queryContext = episodeSummaries.join(' ').slice(0, 500);
      const recallResult = await recallForQuery(queryContext, { db, memoryBinding, mindspringFetcher, mindspringToken }, { includeGraph: true });
      // Map graph expansions back to activated_nodes format for CognitiveState
      // Use activateGraph directly for the node type info (recall pipeline doesn't carry types)
      activatedNodes = await activateGraph(db, queryContext, 2);
      console.log(`[cognition] Recall pipeline: ${recallResult.facts.length} facts, ${recallResult.graphExpansions.length} expansions, timing=${JSON.stringify(recallResult.timing)}`);
    }
  } catch (err) {
    console.warn('[cognition] Recall pipeline failed:', err instanceof Error ? err.message : String(err));
  }

  const state: CognitiveState = {
    version: Date.now(),
    computed_at: new Date().toISOString(),
    narratives: narrativesResult.results.map(n => ({
      arc: n.arc,
      title: n.title,
      summary: n.summary,
      status: n.status as 'active' | 'stalled',
      tension: n.tension,
      last_beat: n.last_beat,
      beat_count: n.beat_count,
    })),
    open_threads: openThreads?.cnt ?? 0,
    proposed_actions: proposedActions?.cnt ?? 0,
    activated_nodes: activatedNodes,
    active_projects: [],      // Phase 2
    product_portfolio: productPortfolio ?? await loadCachedProductPortfolio(db),
    latest_metacog: null,     // Phase 3
    memory_count: typeof memoryHealthResult === 'number' ? memoryHealthResult : (memoryHealthResult ?? 0),
    episode_count_24h: episodeCount?.cnt ?? 0,
    last_heartbeat_severity: heartbeatRow?.severity ?? null,
  };

  const elapsed = Date.now() - start;

  await db.prepare(
    `INSERT INTO cognitive_state (id, state_json, version, computed_at, compute_ms)
     VALUES (1, ?, ?, datetime('now'), ?)
     ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, version = excluded.version, computed_at = excluded.computed_at, compute_ms = excluded.compute_ms`
  ).bind(JSON.stringify(state), state.version, elapsed).run();

  console.log(`[cognition] CognitiveState precomputed in ${elapsed}ms (${narrativesResult.results.length} narratives, ${state.memory_count} memories)`);
}

// ─── Cached product portfolio from previous state ────────────

async function loadCachedProductPortfolio(db: D1Database): Promise<ProductPortfolioEntry[]> {
  try {
    const prev = await getCognitiveState(db);
    return prev?.product_portfolio ?? [];
  } catch {
    return [];
  }
}

// ─── CognitiveState Retrieval (warm boot) ────────────────────

export async function getCognitiveState(db: D1Database): Promise<CognitiveState | null> {
  const row = await db.prepare(
    'SELECT state_json FROM cognitive_state WHERE id = 1'
  ).first<{ state_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.state_json) as CognitiveState;
  } catch {
    return null;
  }
}

// ─── Format CognitiveState for System Prompt ─────────────────

export function formatCognitiveContext(state: CognitiveState): string {
  // Self-model and product portfolio now live in memory blocks (identity, operator_profile, active_context).
  // This function renders only the dynamic cognitive state that isn't in blocks yet:
  // narratives, operational pulse, active concepts, project status, metacog.
  // Once active_context block is populated by consolidation, this becomes a fallback.
  const parts: string[] = [];

  if (state.narratives.length > 0) {
    parts.push('\n## Active Narratives');
    for (const n of state.narratives) {
      const tag = n.status === 'stalled' ? ' [STALLED]' : '';
      parts.push(`\n### ${n.title}${tag}`);
      parts.push(n.summary);
      if (n.tension) parts.push(`**Tension**: ${n.tension}`);
      if (n.last_beat) parts.push(`**Latest**: ${n.last_beat}`);
    }
  }

  parts.push('\n## Operational Pulse');
  parts.push(`- Memory: ${state.memory_count} active entries`);
  parts.push(`- Last 24h: ${state.episode_count_24h} episodes`);
  parts.push(`- Agenda: ${state.open_threads} open threads, ${state.proposed_actions} pending actions`);
  if (state.last_heartbeat_severity) {
    parts.push(`- Last heartbeat: ${state.last_heartbeat_severity}`);
  }

  // Phase 2: activated graph nodes
  if (state.activated_nodes.length > 0) {
    parts.push('\n## Active Concepts');
    for (const node of state.activated_nodes) {
      parts.push(`- ${node.label} (${node.type}, activation: ${node.activation.toFixed(2)})`);
    }
  }

  // Phase 2: project models
  if (state.active_projects.length > 0) {
    parts.push('\n## Project Status');
    for (const p of state.active_projects) {
      parts.push(`- **${p.project}** [${p.status}]${p.top_blocker ? ` — blocked: ${p.top_blocker}` : ''}`);
    }
  }

  // Phase 3: metacognitive insight
  if (state.latest_metacog) {
    parts.push(`\n## Self-Insight\n${state.latest_metacog}`);
  }

  return parts.join('\n');
}
