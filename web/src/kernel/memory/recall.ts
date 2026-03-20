// ─── Recall Pipeline: Blocks → Graph → Memory Worker → RRF Fusion ────
//
// Phase 2 of the unified graph engine. Replaces parallel memory lookups
// with a coordinated pipeline where each layer's output enriches the next.
//
// Cost budget: ~130-260ms total, $0 LLM.
// Design: research/2026-03-13-unified-graph-spike.md

import { activateGraph } from './graph.js';
import { getAllBlocks } from './blocks.js';
import type { MemoryServiceBinding, MemoryFragmentResult } from '../../types.js';

// ─── Types ───────────────────────────────────────────────────

export interface RecallResult {
  facts: RecalledFact[];
  graphExpansions: string[];   // labels from graph activation
  blockContext: string[];      // active project names from blocks
  mindspringHits: number;     // count of MindSpring conversation matches
  timing: {
    blocks_ms: number;
    graph_ms: number;
    memory_ms: number;
    mindspring_ms: number;
    parallel_ms: number;   // wall-clock for Memory Worker + MindSpring combined
    fusion_ms: number;
    total_ms: number;
  };
}

export interface RecalledFact {
  id: string;
  text: string;
  score: number;           // fused score
  semantic_score: number;  // from Memory Worker
  graph_score: number;     // from activation (0 if no graph match)
  source: 'memory_worker' | 'graph' | 'mindspring' | 'both';
}

// ─── MindSpring search result ────────────────────────────────
interface MindSpringResult {
  id: string;
  title: string;
  text: string;
  score: number;
}

// ─── RRF (Reciprocal Rank Fusion) ────────────────────────────

export function rrf(ranks: Map<string, number[]>, k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [id, rankList] of ranks) {
    let score = 0;
    for (const rank of rankList) {
      score += 1 / (k + rank);
    }
    scores.set(id, score);
  }
  return scores;
}

// ─── Pipeline Orchestrator ───────────────────────────────────

const TENANT = 'aegis';
const DEFAULT_MAX_RESULTS = 15;

export async function recallForQuery(
  query: string,
  env: { db: D1Database; memoryBinding?: MemoryServiceBinding; mindspringFetcher?: Fetcher; mindspringToken?: string },
  options?: { maxResults?: number; includeGraph?: boolean },
): Promise<RecallResult> {
  const totalStart = Date.now();
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const includeGraph = options?.includeGraph ?? true;

  // ── Stage 1: Blocks (frame) ──────────────────────────────
  const blocksStart = Date.now();
  const blockContext = await loadBlockContext(env.db);
  const blocks_ms = Date.now() - blocksStart;

  // ── Stage 2: Graph (structure) ───────────────────────────
  let graphExpansions: string[] = [];
  let activatedNodeMap = new Map<string, number>(); // label → activation score
  let nodeMemoryIds = new Map<string, string[]>();   // label → memory_ids from kg_nodes
  const graphStart = Date.now();

  if (includeGraph) {
    try {
      // Combine query entities with active project names from blocks as seeds
      const seedQuery = blockContext.length > 0
        ? `${query} ${blockContext.join(' ')}`
        : query;

      const activated = await activateGraph(env.db, seedQuery, 2);

      for (const node of activated) {
        graphExpansions.push(node.label);
        activatedNodeMap.set(node.label.toLowerCase(), node.activation);
      }

      // Fetch memory_ids for activated nodes to enable fusion matching
      if (activated.length > 0) {
        nodeMemoryIds = await fetchNodeMemoryIds(env.db, activated.map(n => n.label));
      }
    } catch (err) {
      console.warn('[recall] Graph activation failed:', err instanceof Error ? err.message : String(err));
    }
  }
  const graph_ms = Date.now() - graphStart;

  // ── Stage 3 + 3.5: Memory Worker + MindSpring (parallel) ──
  // These are independent — both depend on graphExpansions but not each other.
  const parallelStart = Date.now();
  let memoryFragments: MemoryFragmentResult[] = [];
  let mindspringResults: MindSpringResult[] = [];
  let memory_ms = 0;
  let mindspring_ms = 0;

  const expandedQuery = graphExpansions.length > 0
    ? `${query} ${graphExpansions.join(' ')}`
    : query;

  const memoryPromise = (async () => {
    if (!env.memoryBinding) return;
    const memoryStart = Date.now();
    try {
      memoryFragments = await env.memoryBinding.recall(TENANT, {
        keywords: expandedQuery,
        limit: maxResults + 10, // fetch extra for fusion headroom
      });
    } catch (err) {
      console.warn('[recall] Memory Worker recall failed:', err instanceof Error ? err.message : String(err));
    }
    memory_ms = Date.now() - memoryStart;
  })();

  const mindspringPromise = (async () => {
    if (!env.mindspringFetcher || !env.mindspringToken) return;
    const mindspringStart = Date.now();
    try {
      const msQuery = graphExpansions.length > 0
        ? `${query} ${graphExpansions.slice(0, 5).join(' ')}`
        : query;

      const msResponse = await env.mindspringFetcher.fetch(
        `https://mindspring/api/search?q=${encodeURIComponent(msQuery)}&limit=5&threshold=0.4`,
        { headers: { 'Authorization': `Bearer ${env.mindspringToken}` } },
      );

      if (msResponse.ok) {
        const msData = await msResponse.json<{ results: MindSpringResult[] }>();
        mindspringResults = msData.results ?? [];
      }
    } catch (err) {
      console.warn('[recall] MindSpring search failed:', err instanceof Error ? err.message : String(err));
    }
    mindspring_ms = Date.now() - mindspringStart;
  })();

  await Promise.all([memoryPromise, mindspringPromise]);
  const parallel_ms = Date.now() - parallelStart;

  // Log parallel savings: sequential would be memory_ms + mindspring_ms
  const sequential_ms = memory_ms + mindspring_ms;
  if (sequential_ms > 0) {
    console.log(`[recall] parallel recall: wall=${parallel_ms}ms (memory=${memory_ms}ms + mindspring=${mindspring_ms}ms sequential=${sequential_ms}ms, saved ~${sequential_ms - parallel_ms}ms)`);
  }

  // ── Stage 4: Fusion (RRF merge) ──────────────────────────
  const fusionStart = Date.now();
  const facts = fuseResults(memoryFragments, mindspringResults, activatedNodeMap, nodeMemoryIds, blockContext, maxResults);
  const fusion_ms = Date.now() - fusionStart;

  return {
    facts,
    graphExpansions,
    blockContext,
    mindspringHits: mindspringResults.length,
    timing: {
      blocks_ms,
      graph_ms,
      memory_ms,
      mindspring_ms,
      parallel_ms,
      fusion_ms,
      total_ms: Date.now() - totalStart,
    },
  };
}

// ─── Stage 1: Load block context (active project names) ─────

async function loadBlockContext(db: D1Database): Promise<string[]> {
  try {
    const blocks = await getAllBlocks(db);
    const projectNames: string[] = [];

    for (const block of blocks) {
      // Extract project names from active_context block
      if (block.id === 'active_context') {
        // Look for project references in the block content
        const projectMatches = block.content.matchAll(/\*\*([a-z][\w-]*)\*\*/gi);
        for (const match of projectMatches) {
          const name = match[1].toLowerCase();
          if (name.length >= 3 && !projectNames.includes(name)) {
            projectNames.push(name);
          }
        }
      }
    }

    return projectNames;
  } catch (err) {
    console.warn('[recall] Block context load failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ─── Fetch memory_ids from kg_nodes for activated nodes ─────

async function fetchNodeMemoryIds(
  db: D1Database,
  labels: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (labels.length === 0) return result;

  // Batch fetch in chunks of 20
  for (let i = 0; i < labels.length; i += 20) {
    const chunk = labels.slice(i, i + 20);
    const placeholders = chunk.map(() => 'LOWER(?) = LOWER(label)').join(' OR ');

    try {
      const rows = await db.prepare(
        `SELECT label, memory_ids FROM kg_nodes WHERE ${placeholders}`
      ).bind(...chunk).all<{ label: string; memory_ids: string }>();

      for (const row of rows.results) {
        try {
          const ids = JSON.parse(row.memory_ids || '[]');
          if (Array.isArray(ids) && ids.length > 0) {
            result.set(row.label.toLowerCase(), ids.map(String));
          }
        } catch {
          // Invalid JSON in memory_ids — skip
        }
      }
    } catch (err) {
      console.warn('[recall] fetchNodeMemoryIds failed:', err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}

// ─── Stage 4: RRF Fusion ────────────────────────────────────

function fuseResults(
  memoryFragments: MemoryFragmentResult[],
  mindspringResults: MindSpringResult[],
  activatedNodeMap: Map<string, number>,
  nodeMemoryIds: Map<string, string[]>,
  blockContext: string[],
  maxResults: number,
): RecalledFact[] {
  // Build a set of memory_ids that are linked to activated graph nodes
  const graphLinkedIds = new Set<string>();
  const graphScoreById = new Map<string, number>();

  for (const [label, memIds] of nodeMemoryIds) {
    const activation = activatedNodeMap.get(label.toLowerCase()) ?? 0;
    for (const id of memIds) {
      graphLinkedIds.add(id);
      const existing = graphScoreById.get(id) ?? 0;
      graphScoreById.set(id, Math.max(existing, activation));
    }
  }

  // Build RRF rank lists
  const ranks = new Map<string, number[]>();
  const factById = new Map<string, { text: string; semanticScore: number }>();

  // Rank list 1: Memory Worker semantic order
  for (let i = 0; i < memoryFragments.length; i++) {
    const f = memoryFragments[i];
    const id = f.id;
    factById.set(id, { text: f.content, semanticScore: f.confidence });

    const existing = ranks.get(id) ?? [];
    existing.push(i + 1); // 1-indexed rank
    ranks.set(id, existing);
  }

  // Rank list 2: Graph activation order (for fragments that have graph links)
  const graphRankedIds = [...graphScoreById.entries()]
    .sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < graphRankedIds.length; i++) {
    const [id] = graphRankedIds[i];
    // Only include if we have the fact text (from memory worker or add it)
    const existing = ranks.get(id) ?? [];
    existing.push(i + 1);
    ranks.set(id, existing);
  }

  // Rank list 3: Block relevance boost (facts mentioning active projects)
  if (blockContext.length > 0) {
    const blockBoosted: Array<{ id: string; matches: number }> = [];
    for (const [id, info] of factById) {
      const text = info.text.toLowerCase();
      let matches = 0;
      for (const project of blockContext) {
        if (text.includes(project.toLowerCase())) matches++;
      }
      if (matches > 0) blockBoosted.push({ id, matches });
    }
    blockBoosted.sort((a, b) => b.matches - a.matches);
    for (let i = 0; i < blockBoosted.length; i++) {
      const existing = ranks.get(blockBoosted[i].id) ?? [];
      existing.push(i + 1);
      ranks.set(blockBoosted[i].id, existing);
    }
  }

  // Rank list 4: MindSpring conversation matches (historical context)
  for (let i = 0; i < mindspringResults.length; i++) {
    const ms = mindspringResults[i];
    const id = `ms:${ms.id}`;
    // Synthesize a fact from the conversation match: title + truncated text
    const text = `[Prior conversation: "${ms.title}"] ${ms.text.slice(0, 500)}`;
    factById.set(id, { text, semanticScore: ms.score });

    const existing = ranks.get(id) ?? [];
    existing.push(i + 1);
    ranks.set(id, existing);
  }

  // Apply RRF
  const fusedScores = rrf(ranks);

  // Build result facts
  const results: RecalledFact[] = [];
  const seen = new Set<string>();

  for (const [id, score] of fusedScores) {
    if (seen.has(id)) continue;
    seen.add(id);

    const info = factById.get(id);
    const graphScore = graphScoreById.get(id) ?? 0;
    const hasGraph = graphScore > 0;
    const hasSemantic = !!info;
    const isMindspring = id.startsWith('ms:');

    results.push({
      id,
      text: info?.text ?? '', // empty if only graph-linked without memory worker match
      score,
      semantic_score: info?.semanticScore ?? 0,
      graph_score: graphScore,
      source: isMindspring ? 'mindspring' : hasGraph && hasSemantic ? 'both' : hasGraph ? 'graph' : 'memory_worker',
    });
  }

  // Sort by fused score, filter out empty-text entries, take top-K
  results.sort((a, b) => b.score - a.score);
  return results.filter(f => f.text.length > 0).slice(0, maxResults);
}
