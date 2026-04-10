// ─── Memory Worker Adapter ──────────────────────────────────
// Wraps Stackbilt Memory Worker RPC calls with AEGIS's existing
// function signatures for minimal call-site disruption.
// All functions take a MemoryServiceBinding (from env.MEMORY or config.memoryBinding).
//
// Memory Worker is the sole semantic store. D1 is for operational state only.

import type { MemoryServiceBinding, MemoryFragmentResult, MemoryStatsResult, MemoryStoreRequest } from '../types.js';
import { estimateTokens } from './memory/episodic.js';
import { classifyMemoryTopic, type MemoryTopicClassification } from './classify-memory-topic.js';

const TENANT = 'aegis';
const MEMORY_CONTEXT_LIMIT = 50;
const MEMORY_TOKEN_BUDGET = 800;
// Jaccard similarity floor for treating a write as an update of an existing
// entry. Was 0.55 until Stackbilt-dev/aegis#437 — that threshold was aggressive
// enough to silently catch genuine content updates (e.g. replacing a fact that
// kept ~60% of the original words) and, combined with the old "skip write and
// return existing id" logic, caused silent data loss. Raised to 0.85 so only
// near-identical paraphrases are treated as updates; borderline cases store
// as new entries and the consolidation cycle can merge them later if needed.
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

type MB = MemoryServiceBinding;

// ─── Jaccard token similarity ───────────────────────────────
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length > 2));
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

// ─── recordMemory (Memory Worker only) ──────────────────────
export interface RecordMemoryResult {
  fragment_id: string;
  /**
   * True when this call superseded an existing near-identical entry. The new
   * content is stored under `fragment_id`; the superseded entry is forgotten.
   * See Stackbilt-dev/aegis#437 for the bug this field exists to surface.
   */
  updated?: boolean;
  /** When `updated` is true, the id of the entry that was superseded. */
  superseded_id?: string;
}

export async function recordMemory(
  mem: MB, topic: string, fact: string, confidence: number, source: string,
): Promise<RecordMemoryResult> {
  try {
    // Pre-write dedup: find an existing entry that's near-identical to the
    // incoming fact. If found, we'll treat this call as an update — store
    // the new content first, then forget the old entry. This preserves
    // operator upsert semantics without losing data if the forget step fails.
    //
    // Uses keyword recall + Jaccard similarity to catch rephrasings that the
    // Memory Worker's hash-based dedup misses.
    let existingMatch: { id: string; lifecycle: string } | null = null;
    try {
      const keywords = [...tokenize(fact)].slice(0, 5).join(' ');
      if (keywords) {
        const existing = await mem.recall(TENANT, { keywords, topic, limit: 5 });
        for (const entry of existing) {
          const sim = jaccardSimilarity(fact, entry.content);
          if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
            existingMatch = { id: entry.id, lifecycle: entry.lifecycle };
            break;
          }
        }
      }
    } catch {
      // Dedup check failed — proceed with write anyway. Worst case: a duplicate
      // lands in the store and consolidation cleans it up later. That's a much
      // better failure mode than silently dropping the caller's write.
    }

    // Store the new content first. If this fails, the old entry (if any) is
    // still intact — no data loss. Preserve lifecycle=core on upserts so
    // persona/identity facts don't silently demote and get decayed away.
    const storeReq: MemoryStoreRequest = { content: fact, topic, confidence, source };
    if (existingMatch?.lifecycle === 'core') {
      storeReq.lifecycle = 'core';
    }
    const result = await mem.store(TENANT, [storeReq]);
    const newId = result.fragment_ids?.[0] ?? 'unknown';

    // If we matched an existing entry and the store succeeded, forget the
    // old one now that the replacement is safely in place. If forget fails
    // here, log loudly but don't throw — the operator has their new content
    // under a fresh id, and the stale entry can be cleaned up manually. This
    // is strictly better than the old behavior, where the write was silently
    // skipped and the operator thought their update landed.
    if (existingMatch && newId !== existingMatch.id && newId !== 'unknown') {
      try {
        await mem.forget(TENANT, { ids: [existingMatch.id] });
        console.log(`[memory-adapter] upsert: ${newId} superseded ${existingMatch.id}`);
      } catch (err) {
        console.error(
          `[memory-adapter] upsert: store ok but forget failed (stale entry ${existingMatch.id} remains): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { fragment_id: newId, updated: true, superseded_id: existingMatch.id };
    }

    return { fragment_id: newId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[memory-adapter] recordMemory failed:', errorMessage);
    throw new Error(`Memory write failed: ${errorMessage}`);
  }
}

// ─── recordMemoryWithAutoTopic ──────────────────────────────
// Opt-in convenience wrapper: classify the fact via TarotScript's
// memory-topic-classify spread, then write with the inferred topic.
//
// Callers pass the tarotscript service binding alongside the memory binding.
// If the classifier returns 'general' via the fallback path (classifier
// down, low confidence, unknown topic), the wrapper still writes the fact
// but with the 'general' topic — the caller can filter on the returned
// `classification.source === 'fallback'` to decide whether to re-tag later.
//
// Rollout note: this is additive, not a replacement for recordMemory. Existing
// call sites that pass an explicit topic continue to work unchanged. Callers
// wanting auto-topic opt in explicitly by switching to this wrapper. The
// feature flag lives at the call site (not in this helper) so each caller
// can independently decide when to flip on auto-topic inference.

export interface RecordMemoryWithTopicResult extends RecordMemoryResult {
  classification: MemoryTopicClassification;
}

export async function recordMemoryWithAutoTopic(
  mem: MB,
  tarotscriptFetcher: Fetcher,
  fact: string,
  confidence: number,
  source: string,
  opts: { seed?: number } = {},
): Promise<RecordMemoryWithTopicResult> {
  const classification = await classifyMemoryTopic(tarotscriptFetcher, fact, opts);
  const record = await recordMemory(mem, classification.topic, fact, confidence, source);
  return { ...record, classification };
}

// ─── getMemoryEntries ───────────────────────────────────────
export async function getMemoryEntries(
  mem: MB, topic?: string, limit = 50,
): Promise<MemoryFragmentResult[]> {
  try {
    return await mem.recall(TENANT, { topic, limit });
  } catch (err) {
    console.error('[memory-adapter] getMemoryEntries failed:', err);
    return [];
  }
}

// ─── searchMemoryByKeywords (Memory Worker only) ─────────────
export async function searchMemoryByKeywords(
  mem: MB, query: string, limit = 10,
): Promise<Array<{ id: string; topic: string; fact: string; confidence: number }>> {
  try {
    const fragments = await mem.recall(TENANT, { keywords: query, limit });
    return fragments.map(f => ({ id: f.id, topic: f.topic, fact: f.content, confidence: f.confidence }));
  } catch (err) {
    console.error('[memory-adapter] searchMemoryByKeywords failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ─── getAllMemoryForContext (Memory Worker only) ─────────────
// Two-pass recall: core fragments (persona, identity) + general fragments.
// Memory Worker is the sole knowledge store — no D1 reads.
// Exocortex v2: TOON serialization + token budget cap + query-aware ranking.
const CORE_LIMIT = 15;
const GENERAL_LIMIT = MEMORY_CONTEXT_LIMIT - CORE_LIMIT; // 35

export async function getAllMemoryForContext(
  mem: MB,
  query?: string,
): Promise<{ text: string; ids: string[] }> {
  let coreFragments: MemoryFragmentResult[] = [];
  let workerGeneral: MemoryFragmentResult[] = [];

  // Fire both reads in parallel: Worker core + Worker general
  // When query is provided, use keywords for relevance-ranked recall
  const workerCorePromise = mem.recall(TENANT, { lifecycle: ['core'], limit: CORE_LIMIT })
    .then(r => { coreFragments = r; })
    .catch(err => {
      console.error('[memory-adapter] getAllMemoryForContext core failed:', err instanceof Error ? err.message : String(err));
    });

  const generalRecallOpts = query
    ? { keywords: query, limit: GENERAL_LIMIT + 10 }
    : { limit: GENERAL_LIMIT + 10 };
  const workerGeneralPromise = mem.recall(TENANT, generalRecallOpts)
    .then(r => { workerGeneral = r; })
    .catch(err => {
      console.error('[memory-adapter] getAllMemoryForContext general failed:', err instanceof Error ? err.message : String(err));
    });

  await Promise.all([workerCorePromise, workerGeneralPromise]);

  // Dedupe: remove core IDs from worker general
  const coreIds = new Set(coreFragments.map(f => f.id));
  workerGeneral = workerGeneral.filter(f => !coreIds.has(f.id));

  // Take top GENERAL_LIMIT
  const generalEntries = workerGeneral.slice(0, GENERAL_LIMIT);

  if (coreFragments.length === 0 && generalEntries.length === 0) return { text: '', ids: [] };

  // ─── TOON compact serialization ───────────────────────────
  // Format: [P:dim] obs1 | obs2   (Profile/core)
  //         [M:topic] ●fact1 | ◐fact2   (Memory/general)
  // Token budget: core always included, general fills remaining budget.

  const lines: string[] = [];
  const includedIds: string[] = [];
  let tokenCount = 0;

  // Section 1: Core fragments — always included (persona/identity)
  if (coreFragments.length > 0) {
    const byDimension = new Map<string, string[]>();
    for (const f of coreFragments) {
      const match = f.content.match(/^\[(\w+)\]\s+(.+)/);
      if (match) {
        const list = byDimension.get(match[1]) ?? [];
        list.push(match[2]);
        byDimension.set(match[1], list);
      } else {
        const list = byDimension.get(f.topic) ?? [];
        list.push(f.content);
        byDimension.set(f.topic, list);
      }
      includedIds.push(f.id);
    }
    for (const [dim, observations] of byDimension) {
      lines.push(`[P:${dim}] ${observations.join(' | ')}`);
    }
    tokenCount = estimateTokens(lines.join('\n'));
  }

  // Section 2: General memory — budget-capped, grouped by topic
  if (generalEntries.length > 0) {
    const byTopic = new Map<string, MemoryFragmentResult[]>();
    for (const f of generalEntries) {
      const group = byTopic.get(f.topic) ?? [];
      group.push(f);
      byTopic.set(f.topic, group);
    }

    for (const [topic, entries] of byTopic) {
      const facts = entries.map(e => {
        const conf = e.confidence >= 0.8 ? '●' : e.confidence >= 0.5 ? '◐' : '○';
        return `${conf}${e.content}`;
      });
      const line = `[M:${topic}] ${facts.join(' | ')}`;
      const lineCost = estimateTokens(line);

      if (tokenCount + lineCost > MEMORY_TOKEN_BUDGET) {
        // Try adding individual facts from this topic until budget exhausted
        for (let i = 0; i < facts.length; i++) {
          const partial = `[M:${topic}] ${facts.slice(0, i + 1).join(' | ')}`;
          if (tokenCount + estimateTokens(partial) > MEMORY_TOKEN_BUDGET) break;
          if (i === facts.length - 1) {
            lines.push(partial);
            tokenCount += estimateTokens(partial);
            for (const e of entries.slice(0, i + 1)) includedIds.push(e.id);
          }
        }
        break; // Budget exhausted — stop processing topics
      }

      lines.push(line);
      tokenCount += lineCost;
      for (const e of entries) includedIds.push(e.id);
    }
  }

  const total = coreFragments.length + generalEntries.length;
  const included = includedIds.length;
  if (included < total) {
    console.log(`[memory-adapter] context budget: ${included}/${total} fragments (~${tokenCount} tokens, budget ${MEMORY_TOKEN_BUDGET})`);
  }

  return { text: '\n' + lines.join('\n'), ids: includedIds };
}

// ─── recallMemory ───────────────────────────────────────────
// No-op — Memory Worker auto-tracks recall in recall()
export async function recallMemory(_mem: MB, _ids: string[]): Promise<void> {}

// ─── pruneMemory ────────────────────────────────────────────
// Split: memory decay → Memory Worker; AEGIS-specific cleanup → local D1
export async function pruneMemory(mem: MB, db: D1Database): Promise<void> {
  try {
    const result = await mem.decay(TENANT);
    console.log(`[memory-adapter] decay: decayed=${result.decayed} pruned=${result.pruned} promoted=${result.promoted}`);
  } catch (err) {
    console.error('[memory-adapter] decay failed:', err);
  }

  // AEGIS-specific cleanup (non-memory tables)
  await db.prepare("DELETE FROM web_events WHERE received_at < datetime('now', '-48 hours')").run();
  await db.prepare(`
    DELETE FROM heartbeat_results
    WHERE id NOT IN (SELECT id FROM heartbeat_results ORDER BY created_at DESC LIMIT 100)
    AND created_at < datetime('now', '-30 days')
  `).run();
}

// ─── getMemoryStats ─────────────────────────────────────────
export async function getMemoryStats(mem: MB): Promise<MemoryStatsResult> {
  try {
    return await mem.stats(TENANT);
  } catch (err) {
    console.error('[memory-adapter] getMemoryStats failed:', err);
    return { total_active: 0, topics: [], recalled_last_24h: 0, strength_distribution: { low: 0, medium: 0, high: 0 } };
  }
}

// ─── forgetMemory ───────────────────────────────────────────
export async function forgetMemory(mem: MB, ids: string[]): Promise<number> {
  try {
    return await mem.forget(TENANT, { ids });
  } catch (err) {
    console.error('[memory-adapter] forgetMemory failed:', err);
    return 0;
  }
}

// ─── getMemoryForConsolidation ──────────────────────────────
export async function getMemoryForConsolidation(
  mem: MB,
): Promise<Array<{ id: string; topic: string; fact: string }>> {
  try {
    const fragments = await mem.recall(TENANT, { limit: 40 });
    return fragments.map(f => ({ id: f.id, topic: f.topic, fact: f.content }));
  } catch (err) {
    console.error('[memory-adapter] getMemoryForConsolidation failed:', err);
    return [];
  }
}

// ─── getAllMemoryForReflection ───────────────────────────────
export async function getAllMemoryForReflection(
  mem: MB,
): Promise<Array<{ id: string; topic: string; fact: string; confidence: number; source: string; strength: number; created_at: string; last_accessed_at: string }>> {
  try {
    const fragments = await mem.recall(TENANT, { limit: 100 });
    return fragments.map(f => ({
      id: f.id, topic: f.topic, fact: f.content, confidence: f.confidence,
      source: 'memory_worker', strength: f.strength,
      created_at: f.created_at, last_accessed_at: f.last_accessed_at,
    }));
  } catch (err) {
    console.error('[memory-adapter] getAllMemoryForReflection failed:', err);
    return [];
  }
}
