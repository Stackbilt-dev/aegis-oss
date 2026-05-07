/**
 * Grounding layer — owns all the "don't hallucinate" machinery the dispatch
 * loop weaves around an executor call.
 *
 * Three pre-execution augmentations:
 *   - augmentWithInsights     — CRIX (#106) cross-repo intelligence injection
 *   - augmentWithEntityGrounding — (aegis#446) bizops_read + user_correction
 *     fanout to D1 + wiki; returns the grounding envelope
 *   - augmentWithMemoryRecall — (aegis#457 Phase 5) memory_recall reads
 *     from the wiki and prepends a "relevant pages" block
 *
 * Two post-execution passes:
 *   - applyFabricationCheck  — fabrication-detector (#447 v1)
 *   - applyGapSignal         — gap-signal bookkeeping (#497)
 *
 * And one outcome adjudicator:
 *   - applyGroundingProof    — redefines "success" in procedural_memory
 *     so fabrications on grounding-gated classes count as partial_failure.
 *
 * Everything non-fatal logs and falls through to the ungrounded path —
 * grounding must never block dispatch.
 *
 * Circuit-breaker wrapping is intentionally absent from this core layer.
 * Consumers wanting auto-disable-after-N-failures should compose their own
 * circuit breaker at the call site.
 */
import { groundIntent, formatGroundingBlock, summarizeGrounding } from './grounding/fanout.js';
import type { GroundingEnvelope } from './grounding/fanout.js';
import { fabricationCheck, formatUnverifiedClaims } from './grounding/fabrication-detector.js';
import { semanticSanhedrinCheck, formatContradictions } from './grounding/semantic-sanhedrin.js';
import { searchPages } from '../wiki/client.js';
import type { WikiClientEnv } from '../wiki/client.js';
import { memoryServiceFor } from './memory-service.js';
import type { KernelIntent, DispatchResult } from './types.js';
import type { EdgeEnv } from './dispatch.js';

// ─── Classifications that participate in grounding ─────────

export const GROUNDING_GATED_CLASSIFICATIONS = new Set<string>([
  'bizops_read', 'user_correction', 'memory_recall',
]);

// ─── CRIX insight cache ─────────────────────────────────────

const INSIGHT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_INSIGHTS_PER_DISPATCH = 3;

interface InsightEntry { fact: string; type: string; origin: string }
let insightCache: { entries: InsightEntry[]; fetchedAt: number } | null = null;

/** Testing hook — reset the module-level cache between runs. */
export function __resetInsightCache(): void {
  insightCache = null;
}

async function fetchRelevantInsights(
  env: EdgeEnv,
  _classification: string,
  rawQuery: string,
): Promise<string | null> {
  const now = Date.now();
  if (!insightCache || (now - insightCache.fetchedAt) > INSIGHT_CACHE_TTL_MS) {
    try {
      const wikiEnv: WikiClientEnv = { wikiBinding: env.wikiBinding, wikiToken: env.wikiToken };
      const { results } = await searchPages(wikiEnv, 'cross_repo_insights', { limit: 20 });
      insightCache = {
        entries: results.map(page => ({
          fact: page.summary || page.snippet || page.title,
          type: page.type || 'pattern',
          origin: page.scope || 'core',
        })),
        fetchedAt: now,
      };
    } catch {
      return null;
    }
  }

  if (!insightCache || insightCache.entries.length === 0) return null;

  const queryWords = new Set(
    rawQuery.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3),
  );

  const scored = insightCache.entries
    .map(entry => {
      const factWords = entry.fact.toLowerCase().split(/\s+/);
      const matches = factWords.filter(w => queryWords.has(w)).length;
      return { ...entry, relevance: matches };
    })
    .filter(e => e.relevance > 0);

  scored.sort((a, b) => b.relevance - a.relevance);
  const top = scored.slice(0, MAX_INSIGHTS_PER_DISPATCH);
  if (top.length === 0) return null;

  const lines = top.map(i => `- [${i.type}] (from ${i.origin}) ${i.fact}`);
  return `[Cross-Repo Intelligence — validated patterns]\n${lines.join('\n')}`;
}

/**
 * Prepend cross-repo insights to the intent when applicable. In-place mutation
 * of intent.raw. Skips greeting + heartbeat and when no wiki binding is
 * configured. Non-fatal.
 */
export async function augmentWithInsights(
  intent: KernelIntent,
  classification: string,
  env: EdgeEnv,
): Promise<void> {
  if (!env.wikiBinding) return;
  if (classification === 'greeting' || classification === 'heartbeat') return;
  try {
    const insightContext = await fetchRelevantInsights(env, classification, intent.raw);
    if (insightContext) {
      intent.raw = `${insightContext}\n\n${intent.raw}`;
    }
  } catch (err) {
    console.warn('[grounding-layer] Insight fetch failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fanout entity grounding for bizops_read + user_correction. Extracts entity
 * refs, queries D1 + wiki in parallel, injects a verified-facts block. Returns
 * the grounding envelope when a block was injected, or undefined. Non-fatal.
 */
export async function augmentWithEntityGrounding(
  intent: KernelIntent,
  classification: string,
  env: EdgeEnv,
): Promise<GroundingEnvelope | undefined> {
  if (classification !== 'bizops_read' && classification !== 'user_correction') return undefined;

  try {
    const wikiEnv: WikiClientEnv | undefined = env.wikiBinding
      ? { wikiBinding: env.wikiBinding, wikiToken: env.wikiToken }
      : undefined;
    const grounding = await groundIntent(intent.raw, {
      db: env.db,
      wiki: wikiEnv,
    });
    const block = formatGroundingBlock(grounding);
    if (block) {
      intent.raw = `${block}\n\n[Operator query]\n${intent.raw}`;
    }
    return summarizeGrounding(grounding);
  } catch (err) {
    console.warn('[grounding-layer] Entity grounding failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
  return undefined;
}

/**
 * Memory_recall augmentation — search the wiki for pages matching the
 * intent.raw and prepend a block of hits for the executor to quote. Non-fatal.
 */
export async function augmentWithMemoryRecall(
  intent: KernelIntent,
  classification: string,
  env: EdgeEnv,
): Promise<void> {
  if (classification !== 'memory_recall') return;
  try {
    if (!env.wikiBinding) {
      console.warn('[grounding-layer] Wiki binding unavailable — skipping memory recall augmentation');
      return;
    }
    const wikiEnv: WikiClientEnv = { wikiBinding: env.wikiBinding, wikiToken: env.wikiToken };
    const { results } = await searchPages(wikiEnv, intent.raw, { limit: 10 });
    if (results.length > 0) {
      const memLines = results.map(p =>
        `- [${p.scope || p.type || 'wiki'}] ${p.summary || p.title} (confidence: ${p.confidence || 'medium'})`,
      ).join('\n');
      intent.raw = `[Relevant wiki pages matching this query]\n${memLines}\n\n[User's question]\n${intent.raw}`;
    }
  } catch (err) {
    console.warn('[grounding-layer] Wiki search failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ─── Post-execution passes ─────────────────────────────────

/**
 * Downgrade successful outcomes to `partial_failure` when the response
 * carries unverified_claims on a grounding-gated classification. This stops
 * the procedural_memory learning loop from probating procedures upward on
 * fabrications that happen to not throw.
 */
export function applyGroundingProof(
  execOutcome: 'success' | 'failure' | 'partial_failure',
  classification: string,
  dispatchResult: DispatchResult,
): 'success' | 'failure' | 'partial_failure' {
  if (execOutcome !== 'success') return execOutcome;
  if (!GROUNDING_GATED_CLASSIFICATIONS.has(classification)) return execOutcome;
  if (dispatchResult.unverified_claims && dispatchResult.unverified_claims.length > 0) {
    return 'partial_failure';
  }
  return execOutcome;
}

/**
 * Record or clear the gap_signal_count for this procedureKey. Only runs for
 * grounding-gated classes. Non-fatal.
 */
export async function applyGapSignal(
  dispatchResult: DispatchResult,
  procKey: string,
  classification: string,
  env: EdgeEnv,
): Promise<void> {
  if (!GROUNDING_GATED_CLASSIFICATIONS.has(classification)) return;

  const hasGap =
    (dispatchResult.unverified_claims?.length ?? 0) > 0 ||
    (dispatchResult.unknowns?.length ?? 0) > 0;

  try {
    const memory = memoryServiceFor(env);
    if (hasGap) {
      await memory.recordGapSignal(procKey);
    } else {
      await memory.clearGapSignal(procKey);
    }
  } catch (err) {
    console.warn('[grounding-layer] Gap signal update failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fabrication-detector post-pass (#447 v1 + semantic Sanhedrin #573).
 *
 * Runs two checks independently (Promise.allSettled so one failure doesn't
 * cancel the other):
 *   - Structured pass: agenda/task mutation claims + referential slug verification
 *   - Semantic pass: Workers AI wiki-contradiction gate
 *
 * Contradictions from either pass land in `unverified_claims[]`. Response text
 * is never stripped — diagnostic posture until false-positive rates are known.
 */
export async function applyFabricationCheck(
  result: DispatchResult,
  responseText: string,
  env: EdgeEnv,
): Promise<void> {
  try {
    const [structuredResult, semanticResult] = await Promise.allSettled([
      fabricationCheck(responseText, {
        db: env.db,
        wikiBinding: env.wikiBinding,
        wikiToken: env.wikiToken,
      }),
      semanticSanhedrinCheck(responseText, {
        wikiBinding: env.wikiBinding,
        wikiToken: env.wikiToken,
        ai: env.ai,
      }),
    ]);

    const structuredReport = structuredResult.status === 'fulfilled'
      ? structuredResult.value
      : { checked: 0, unverified: [] };
    const semanticReport = semanticResult.status === 'fulfilled'
      ? semanticResult.value
      : { checked: 0, contradictions: [] };

    const allClaims: string[] = [
      ...formatUnverifiedClaims(structuredReport),
      ...formatContradictions(semanticReport),
    ];

    if (allClaims.length > 0) {
      result.unverified_claims = allClaims;
      result.grounded = false;
    }
  } catch (err) {
    console.warn('[grounding-layer] Fabrication check failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}
