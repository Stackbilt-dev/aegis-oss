import { askGroq } from '../../groq.js';
import { extractNodes, createEdges } from './graph.js';
import { writeDreamFact } from './dream-write.js';
import type { WikiClientEnv } from '../../wiki/client.js';

// ─── Memory Consolidation ───────────────────────────────────
// Redesigned for the #457 wiki unification (aegis-oss#78): writes go to
// the wiki's `dreams` scope instead of the memory-worker fragment store.
// Dreams are additive, provisional pages (confidence: drifting) with their
// own lifecycle rules (promote on corroboration, archive if stale) — that
// supersedes the old ADD/UPDATE/DELETE-by-id fragment model, which relied
// on reading back an existing fragment list to pick a target id. There is
// no equivalent "patch this specific prior fact" operation for wiki pages
// written this way; letting the dreams lifecycle handle staleness is the
// same tradeoff PRISM's synthesis.ts already makes in production.

const CONSOLIDATION_SYSTEM = `You are AEGIS memory consolidation. Analyze recent agent episodes and extract genuinely new, specific facts worth remembering long-term.

Rules:
1. Every fact MUST contain at least one specific detail: a name, date, number, ID, URL, or version. Never write vague observations.
2. Max 3 facts per run. Quality over quantity.
3. Good facts: "Delaware PBC franchise tax filed 2026-03-03, 2 days late" or "BizOps dashboard_summary tool fails when org has no projects (undefined.id)".
4. Bad facts: "Financial metrics are important" or "Document gaps exist and require attention".
5. If episodes contain nothing worth remembering, return [].

Return ONLY a JSON array (no markdown):
[
  { "topic": "aegis", "fact": "specific fact", "confidence": 0.8 }
]

Return [] if nothing needs to change.`;

export async function consolidateEpisodicToSemantic(
  db: D1Database,
  groqApiKey: string,
  groqModel: string,
  groqBaseUrl?: string,
  wikiEnv?: WikiClientEnv,
): Promise<void> {
  if (!wikiEnv?.wikiBinding || !wikiEnv.wikiToken) return;

  // High-water mark: only process episodes since last consolidation (not a rolling 24h window)
  const lastRun = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_consolidation_at'"
  ).first<{ received_at: string }>();
  const since = lastRun?.received_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const result = await db.prepare(
    'SELECT id, intent_class, channel, summary, outcome, cost FROM episodic_memory WHERE created_at > ? ORDER BY created_at DESC LIMIT 20'
  ).bind(since).all();

  const episodes = result.results as unknown as Array<{
    id: number;
    intent_class: string;
    channel: string;
    summary: string;
    outcome: string;
    cost: number;
  }>;

  // Guard: skip if not enough new signal
  if (episodes.length < 3) return;

  const userPrompt = `Recent agent episodes (since last consolidation):\n\n${episodes.map((e, i) =>
    `${i + 1}. [${e.intent_class}/${e.outcome}] ${e.summary}`
  ).join('\n')}`;

  let rawResponse: string;
  try {
    rawResponse = await askGroq(groqApiKey, groqModel, CONSOLIDATION_SYSTEM, userPrompt, groqBaseUrl);
  } catch {
    return; // Groq failure — skip silently, will retry next cron cycle
  }

  if (!rawResponse) return;
  const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let facts: Array<{ topic?: string; fact?: string; confidence?: number }>;
  try {
    facts = JSON.parse(cleaned);
    if (!Array.isArray(facts)) return;
  } catch {
    return;
  }

  for (const item of facts.slice(0, 3)) { // Hard cap: max 3 per run
    if (!item.fact || item.fact.length < 30) continue;
    if (!/\d/.test(item.fact) && !/[A-Z][a-z]/.test(item.fact.slice(1))) continue;

    const topic = item.topic || 'aegis';
    const confidence = item.confidence ?? 0.7;
    await writeDreamFact(wikiEnv, { fact: item.fact, confidence, source: 'episodic_consolidation' });
    console.log(`[consolidation] Wrote dream fact [${topic}] "${item.fact.slice(0, 80)}" (conf:${confidence})`);

    // Knowledge graph extraction — decoupled from storage backend, keep as-is
    try {
      const nodeIds = await extractNodes(db, item.fact, topic);
      if (nodeIds.length >= 2) {
        await createEdges(db, nodeIds);
      }
    } catch (err) {
      console.warn('[consolidation] Graph extraction failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Advance the high-water mark — these episodes won't be re-processed
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_consolidation_at', datetime('now'))"
  ).run();
}
