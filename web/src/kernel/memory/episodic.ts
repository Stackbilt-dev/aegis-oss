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
