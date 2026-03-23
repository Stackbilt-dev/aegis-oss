import { askGroq } from '../../groq.js';
import { normalizeTopic, factHash } from './semantic.js';
import { extractNodes, createEdges } from './graph.js';

// ─── Memory Consolidation ───────────────────────────────────

const CONSOLIDATION_SYSTEM = `You are AEGIS memory consolidation. Analyze recent episodes against existing memory and produce structured operations.

Operations:
- ADD: a genuinely new fact not covered by existing memory
- UPDATE: an existing fact that needs correction or has new information (reference its id via supersedes_id)
- DELETE: an existing fact that is no longer accurate (reference its id via target_id, provide reason)
- NOOP: nothing to do — return []

Rules:
1. Every fact MUST contain at least one specific detail: a name, date, number, ID, URL, or version. Never write vague observations.
2. If episodes merely confirm existing facts, return [].
3. Prefer UPDATE over ADD when a fact evolves (e.g., "Phase 2 planned" → "Phase 2 complete").
4. DELETE facts that are provably wrong or obsolete based on episode evidence.
5. Max 3 operations per run. Quality over quantity.
6. Good facts: "Delaware PBC franchise tax filed 2026-03-03, 2 days late" or "BizOps dashboard_summary tool fails when org has no projects (undefined.id)".
7. Bad facts: "Financial metrics are important" or "Document gaps exist and require attention".

KNOWN TOPICS — reuse these whenever the fact fits. Only create a new topic if genuinely none of these apply:
- aegis: cognitive kernel internals, architecture, infrastructure, versioning, deployment
- img_forge: img-forge product, economics, integrations, API
- bizops: BizOps tool, MCP tools, operational improvements
- content: roundtable, dispatch, column generation pipelines
- self_improvement: self-improvement analysis, outcomes, patterns
- organization: org-level priorities, governance, go-to-market
- auth: auth product, Better Auth, API key formats, middleware chain, auth-contract
- product_strategy: product positioning, competitive landscape
- compliance: legal, tax, compliance deadlines, regulatory
- finance: financial metrics, costs, revenue, billing
- operator_preferences: operator preferences, workflow choices
- milestones: key dates, launches, completed phases
- mcp_strategy: MCP protocol, OAuth, remote MCP, tool design

Return ONLY a JSON array (no markdown):
[
  { "operation": "ADD", "topic": "aegis", "fact": "specific fact", "confidence": 0.8 },
  { "operation": "UPDATE", "supersedes_id": 42, "topic": "auth", "fact": "updated fact", "confidence": 0.9 },
  { "operation": "DELETE", "target_id": 37, "reason": "no longer accurate" }
]

Return [] if nothing needs to change.`;

export async function consolidateEpisodicToSemantic(
  db: D1Database,
  groqApiKey: string,
  groqModel: string,
  groqBaseUrl?: string,
  memoryBinding?: import('../../types.js').MemoryServiceBinding,
): Promise<void> {
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

  // Fetch existing active memory with IDs so the model can reference them for UPDATE/DELETE
  // Memory Worker is the sole knowledge store — D1 reads removed
  let existingMemoryList: Array<{ id: string | number; topic: string; fact: string }> = [];
  if (memoryBinding) {
    try {
      const fragments = await memoryBinding.recall('aegis', { limit: 40 });
      existingMemoryList = fragments.map(f => ({ id: f.id, topic: f.topic, fact: f.content }));
    } catch (err) {
      console.error('[consolidation] Memory Worker recall failed:', err instanceof Error ? err.message : String(err));
    }
  }

  const memoryContext = existingMemoryList.length > 0
    ? `\n\nExisting memory (reference by id for UPDATE/DELETE operations):\n${existingMemoryList.map(m => `- [id=${m.id}] [${m.topic}] ${m.fact}`).join('\n')}`
    : '';

  const userPrompt = `Recent agent episodes (since last consolidation):\n\n${episodes.map((e, i) =>
    `${i + 1}. [${e.intent_class}/${e.outcome}] ${e.summary}`
  ).join('\n')}${memoryContext}`;

  let rawResponse: string;
  try {
    rawResponse = await askGroq(groqApiKey, groqModel, CONSOLIDATION_SYSTEM, userPrompt, groqBaseUrl);
  } catch {
    return; // Groq failure — skip silently, will retry next cron cycle
  }

  if (!rawResponse) return;
  const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let ops: Array<{
    operation: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
    topic?: string; fact?: string; confidence?: number;
    supersedes_id?: string | number;
    target_id?: string | number; reason?: string;
  }>;
  try {
    ops = JSON.parse(cleaned);
    if (!Array.isArray(ops)) return;
  } catch {
    return;
  }

  for (const op of ops.slice(0, 3)) { // Hard cap: max 3 per run
    switch (op.operation) {
      case 'ADD': {
        if (!op.topic || !op.fact) continue;
        if (op.fact.length < 30) continue;
        if (!/\d/.test(op.fact) && !/[A-Z][a-z]/.test(op.fact.slice(1))) continue;
        if (!memoryBinding) continue;
        await memoryBinding.store('aegis', [{ content: op.fact, topic: op.topic, confidence: op.confidence ?? 0.7, source: 'episodic_consolidation' }]);
        console.log(`[consolidation] ADD [${normalizeTopic(op.topic)}] "${op.fact.slice(0, 80)}" (conf:${op.confidence ?? 0.7})`);
        // Phase 2: Extract knowledge graph nodes + edges from new fact
        try {
          const nodeIds = await extractNodes(db, op.fact, normalizeTopic(op.topic));
          if (nodeIds.length >= 2) {
            await createEdges(db, nodeIds);
          }
        } catch (err) {
          console.warn('[consolidation] Graph extraction failed:', err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case 'UPDATE': {
        if (!op.supersedes_id || !op.topic || !op.fact) continue;
        if (op.fact.length < 30) continue;
        if (!/\d/.test(op.fact) && !/[A-Z][a-z]/.test(op.fact.slice(1))) continue;
        if (memoryBinding) {
          // Forget old → store new
          await memoryBinding.forget('aegis', { ids: [String(op.supersedes_id)] });
          await memoryBinding.store('aegis', [{ content: op.fact, topic: op.topic, confidence: op.confidence ?? 0.8, source: 'episodic_consolidation' }]);
        } else {
          await db.prepare(
            "UPDATE memory_entries SET valid_until = datetime('now'), updated_at = datetime('now') WHERE id = ? AND valid_until IS NULL"
          ).bind(op.supersedes_id).run();
          const topic = normalizeTopic(op.topic);
          const hash = factHash(topic, op.fact);
          const insertResult = await db.prepare(
            'INSERT INTO memory_entries (topic, fact, fact_hash, confidence, source, superseded_by) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(topic, op.fact, hash, op.confidence ?? 0.8, 'episodic_consolidation', op.supersedes_id).run();
          if (insertResult.meta.last_row_id) {
            await db.prepare(
              'UPDATE memory_entries SET superseded_by = ? WHERE id = ?'
            ).bind(insertResult.meta.last_row_id, op.supersedes_id).run();
          }
        }
        console.log(`[consolidation] UPDATE ${op.supersedes_id} → [${normalizeTopic(op.topic)}] "${op.fact.slice(0, 80)}" (conf:${op.confidence ?? 0.8})`);
        // Phase 2: Extract knowledge graph nodes + edges from updated fact
        try {
          const nodeIds = await extractNodes(db, op.fact, normalizeTopic(op.topic));
          if (nodeIds.length >= 2) {
            await createEdges(db, nodeIds);
          }
        } catch (err) {
          console.warn('[consolidation] Graph extraction failed:', err instanceof Error ? err.message : String(err));
        }
        break;
      }
      case 'DELETE': {
        if (!op.target_id) continue;
        if (memoryBinding) {
          await memoryBinding.forget('aegis', { ids: [String(op.target_id)] });
        } else {
          await db.prepare(
            "UPDATE memory_entries SET valid_until = datetime('now'), updated_at = datetime('now') WHERE id = ? AND valid_until IS NULL"
          ).bind(op.target_id).run();
        }
        console.log(`[consolidation] Soft-deleted memory ${op.target_id}: ${op.reason ?? 'no reason'}`);
        break;
      }
      // NOOP — skip
    }
  }

  // Advance the high-water mark — these episodes won't be re-processed
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_consolidation_at', datetime('now'))"
  ).run();
}
