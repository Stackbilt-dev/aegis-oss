// Recall pipeline tests — Phase 2 unified memory retrieval
// Tests: Blocks→Graph→Memory Worker→RRF Fusion pipeline
//
// Verifies the pipeline produces results when all layers have data,
// degrades gracefully when layers are empty, and produces a superset
// of what the baseline parallel approach yields.

import { describe, it, expect, vi } from 'vitest';
import { recallForQuery, rrf, type RecallResult, type RecalledFact } from '../src/kernel/memory/recall.js';
import type { MemoryServiceBinding, MemoryFragmentResult } from '../src/types.js';

// ─── D1 Mock Factory ─────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(opts: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
  runMeta?: { changes?: number; last_row_id?: number }[];
} = {}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let allIdx = 0;
  let runIdx = 0;

  return {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async first() {
          return opts.firstResults?.[firstIdx++] ?? null;
        },
        async all() {
          const results = opts.allResults?.[allIdx++] ?? [];
          return { results };
        },
        async run() {
          const meta = opts.runMeta?.[runIdx++] ?? { changes: 1, last_row_id: 1 };
          return { meta };
        },
      };
    },
    _queries: queries,
  } as unknown as D1Database & { _queries: MockQuery[] };
}

// ─── Memory Worker Mock Factory ──────────────────────────────

function createMockMemory(fragments: MemoryFragmentResult[] = []): MemoryServiceBinding {
  return {
    store: vi.fn().mockResolvedValue({ stored: 0, merged: 0, duplicates: 0, fragment_ids: [] }),
    recall: vi.fn().mockResolvedValue(fragments),
    forget: vi.fn().mockResolvedValue(0),
    decay: vi.fn().mockResolvedValue({ decayed: 0, pruned: 0, promoted: 0 }),
    consolidate: vi.fn().mockResolvedValue({ processed: 0, merged: 0, pruned: 0, high_water_mark: '' }),
    health: vi.fn().mockResolvedValue({ status: 'ok', version: '1.0', tenants: 1, total_fragments: 0, active_fragments: 0 }),
    stats: vi.fn().mockResolvedValue({ total_active: 0, topics: [], recalled_last_24h: 0, strength_distribution: { low: 0, medium: 0, high: 0 } }),
    embed: vi.fn().mockResolvedValue({ embeddings: [] }),
  };
}

function makeFragment(id: string, content: string, topic: string, confidence = 0.8): MemoryFragmentResult {
  return {
    id,
    tenant_id: 'aegis',
    content,
    topic,
    confidence,
    lifecycle: 'confirmed',
    strength: 1.0,
    last_accessed_at: '2026-03-13T00:00:00Z',
    access_count: 1,
    created_at: '2026-03-13T00:00:00Z',
    updated_at: '2026-03-13T00:00:00Z',
  };
}

// ════════════════════════════════════════════════════════════════
// 1. RRF unit tests
// ════════════════════════════════════════════════════════════════

describe('recall-pipeline: rrf', () => {
  it('computes reciprocal rank fusion scores', () => {
    const ranks = new Map<string, number[]>();
    ranks.set('a', [1, 2]);  // appears in both lists
    ranks.set('b', [3]);      // appears in one list
    ranks.set('c', [1]);      // appears in one list

    const scores = rrf(ranks, 60);

    // 'a' should score highest — it appears in both rank lists
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
  });

  it('single-list items score by rank position', () => {
    const ranks = new Map<string, number[]>();
    ranks.set('first', [1]);
    ranks.set('second', [2]);
    ranks.set('tenth', [10]);

    const scores = rrf(ranks, 60);

    expect(scores.get('first')!).toBeGreaterThan(scores.get('second')!);
    expect(scores.get('second')!).toBeGreaterThan(scores.get('tenth')!);
  });

  it('returns empty map for empty input', () => {
    const scores = rrf(new Map(), 60);
    expect(scores.size).toBe(0);
  });

  it('uses k=60 by default', () => {
    const ranks = new Map<string, number[]>();
    ranks.set('a', [1]);

    const scores = rrf(ranks);
    // 1/(60+1) = 0.01639...
    expect(scores.get('a')!).toBeCloseTo(1 / 61, 5);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. Pipeline integration tests
// ════════════════════════════════════════════════════════════════

describe('recall-pipeline: recallForQuery', () => {
  it('produces results when all 3 layers have data', async () => {
    // Blocks: active_context mentions "aegis"
    // Graph: activateGraph finds "aegis" → "cloudflare" → "d1"
    // Memory Worker: returns fragments
    const db = createMockDb({
      allResults: [
        // Stage 1: getAllBlocks
        [{ id: 'active_context', content: '**aegis** is the main project', version: 2, priority: 4, max_bytes: 3072, updated_by: 'consolidation', updated_at: '2026-03-13' }],
        // Stage 2: activateGraph seed query
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        // hop 0: neighbors of node 1
        [{ neighbor_id: 2, weight: 0.8, edge_id: 10 }],
        // hop 1: neighbors of node 2
        [{ neighbor_id: 3, weight: 0.6, edge_id: 11 }],
        // fetch node info for 2, 3
        [
          { id: 2, label: 'cloudflare', node_type: 'tool' },
          { id: 3, label: 'd1', node_type: 'tool' },
        ],
        // fetchNodeMemoryIds: query for labels
        [
          { label: 'aegis', memory_ids: '["frag-1"]' },
          { label: 'cloudflare', memory_ids: '["frag-2"]' },
        ],
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-1', 'AEGIS is the main autonomous agent', 'system', 0.9),
      makeFragment('frag-2', 'Cloudflare Workers power the edge runtime', 'infrastructure', 0.85),
      makeFragment('frag-3', 'D1 is the database layer', 'infrastructure', 0.8),
    ]);

    const result = await recallForQuery('aegis deployment', { db, memoryBinding: mem });

    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.graphExpansions.length).toBeGreaterThan(0);
    expect(result.blockContext).toContain('aegis');
    expect(result.timing.total_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.blocks_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.graph_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.memory_ms).toBeGreaterThanOrEqual(0);
    expect(result.timing.fusion_ms).toBeGreaterThanOrEqual(0);
  });

  it('works when graph has no matching nodes (falls back to pure semantic)', async () => {
    const db = createMockDb({
      allResults: [
        // Stage 1: getAllBlocks (empty)
        [],
        // Stage 2: activateGraph returns no seeds
        [],
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-1', 'Some semantic result', 'general', 0.75),
    ]);

    const result = await recallForQuery('obscure query with no graph match', { db, memoryBinding: mem });

    expect(result.facts.length).toBe(1);
    expect(result.facts[0].text).toBe('Some semantic result');
    expect(result.facts[0].source).toBe('memory_worker');
    expect(result.facts[0].graph_score).toBe(0);
    expect(result.graphExpansions).toEqual([]);
  });

  it('works when blocks are empty (no bias applied)', async () => {
    const db = createMockDb({
      allResults: [
        // Stage 1: getAllBlocks (empty)
        [],
        // Stage 2: activateGraph
        [{ id: 1, label: 'stripe', node_type: 'tool' }],
        // hop 0
        [],
        // no missing nodes to fetch
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-1', 'Stripe handles billing', 'billing', 0.9),
    ]);

    const result = await recallForQuery('stripe billing', { db, memoryBinding: mem });

    expect(result.blockContext).toEqual([]);
    expect(result.facts.length).toBeGreaterThan(0);
  });

  it('graph expansion adds terms that semantic search alone would miss', async () => {
    const db = createMockDb({
      allResults: [
        // blocks: empty
        [],
        // activateGraph: "pricing" seed → "unified_credits" neighbor
        [{ id: 1, label: 'pricing', node_type: 'concept' }],
        [{ neighbor_id: 2, weight: 0.9, edge_id: 1 }],
        [], // hop 1: no more neighbors
        [{ id: 2, label: 'unified_credits', node_type: 'concept' }],
        // fetchNodeMemoryIds
        [{ label: 'unified_credits', memory_ids: '[]' }],
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-1', 'unified credits model adopted for pricing', 'billing', 0.8),
    ]);

    const result = await recallForQuery('pricing', { db, memoryBinding: mem });

    // "unified_credits" should appear in graph expansions — semantic search for
    // just "pricing" might not find it, but graph activation does
    expect(result.graphExpansions).toContain('unified_credits');
  });

  it('RRF fusion ranks facts with both semantic + graph signal higher than semantic-only', async () => {
    const db = createMockDb({
      allResults: [
        // blocks
        [],
        // activateGraph
        [{ id: 1, label: 'oauth', node_type: 'concept' }],
        [], // no neighbors
        // fetchNodeMemoryIds: oauth links to frag-1
        [{ label: 'oauth', memory_ids: '["frag-1"]' }],
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-1', 'OAuth 2.1 implemented across products', 'auth', 0.9),
      makeFragment('frag-2', 'Better Auth used for session management', 'auth', 0.95),
    ]);

    const result = await recallForQuery('oauth', { db, memoryBinding: mem });

    // frag-1 has both semantic + graph signal, frag-2 has only semantic
    const bothFact = result.facts.find(f => f.id === 'frag-1');
    const semanticOnly = result.facts.find(f => f.id === 'frag-2');

    expect(bothFact).toBeDefined();
    expect(semanticOnly).toBeDefined();

    // The "both" fact should rank higher (higher fused score)
    expect(bothFact!.score).toBeGreaterThan(semanticOnly!.score);
    expect(bothFact!.source).toBe('both');
    expect(semanticOnly!.source).toBe('memory_worker');
  });

  it('timing object is populated', async () => {
    const db = createMockDb({
      allResults: [[], []],
    });

    const result = await recallForQuery('test', { db });

    expect(typeof result.timing.blocks_ms).toBe('number');
    expect(typeof result.timing.graph_ms).toBe('number');
    expect(typeof result.timing.memory_ms).toBe('number');
    expect(typeof result.timing.mindspring_ms).toBe('number');
    expect(typeof result.timing.parallel_ms).toBe('number');
    expect(typeof result.timing.fusion_ms).toBe('number');
    expect(typeof result.timing.total_ms).toBe('number');
    expect(result.timing.total_ms).toBeGreaterThanOrEqual(0);
  });

  it('dedup by memory_id works', async () => {
    const db = createMockDb({
      allResults: [
        // blocks
        [],
        // activateGraph
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        [], // no neighbors
        // fetchNodeMemoryIds: aegis links to frag-1 (same as semantic result)
        [{ label: 'aegis', memory_ids: '["frag-1"]' }],
      ],
    });

    // Memory Worker returns frag-1 — same as the graph-linked one
    const mem = createMockMemory([
      makeFragment('frag-1', 'AEGIS is the core agent', 'system', 0.9),
      makeFragment('frag-1', 'AEGIS is the core agent', 'system', 0.9), // duplicate
    ]);

    const result = await recallForQuery('aegis', { db, memoryBinding: mem });

    // Should only appear once despite being in both semantic and graph results
    const aegisFacts = result.facts.filter(f => f.id === 'frag-1');
    expect(aegisFacts.length).toBe(1);
  });

  it('respects maxResults option', async () => {
    const db = createMockDb({
      allResults: [[], []],
    });

    const fragments = Array.from({ length: 20 }, (_, i) =>
      makeFragment(`frag-${i}`, `Fact number ${i}`, 'test', 0.5 + i * 0.02)
    );
    const mem = createMockMemory(fragments);

    const result = await recallForQuery('test query', { db, memoryBinding: mem }, { maxResults: 5 });
    expect(result.facts.length).toBeLessThanOrEqual(5);
  });

  it('works without memory binding (graph-only mode)', async () => {
    const db = createMockDb({
      allResults: [
        // blocks
        [],
        // activateGraph
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        [], // no neighbors
      ],
    });

    // No memory binding
    const result = await recallForQuery('aegis', { db });

    expect(result.facts).toEqual([]); // no memory worker = no facts
    expect(result.graphExpansions.length).toBeGreaterThan(0);
    expect(result.graphExpansions).toContain('aegis');
  });

  it('includeGraph=false skips graph activation', async () => {
    const db = createMockDb({
      allResults: [
        // blocks only
        [],
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-1', 'Some fact', 'test', 0.8),
    ]);

    const result = await recallForQuery('test', { db, memoryBinding: mem }, { includeGraph: false });

    expect(result.graphExpansions).toEqual([]);
    expect(result.facts.length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════
// 3. Pipeline produces superset of baseline parallel approach
// ════════════════════════════════════════════════════════════════

describe('recall-pipeline: superset of baseline', () => {
  it('pipeline includes all memory worker results that baseline would return', async () => {
    // Baseline: Memory Worker returns frag-1, frag-2
    // Pipeline should include at least these same fragments
    const db = createMockDb({
      allResults: [
        // blocks
        [],
        // activateGraph: no seeds found
        [],
      ],
    });

    const fragments = [
      makeFragment('frag-1', 'LLC formation in progress', 'legal', 0.9),
      makeFragment('frag-2', 'EIN application filed', 'legal', 0.85),
    ];
    const mem = createMockMemory(fragments);

    const result = await recallForQuery('LLC formation status', { db, memoryBinding: mem });

    // Pipeline result should contain all fragments from the baseline
    const resultIds = new Set(result.facts.map(f => f.id));
    for (const frag of fragments) {
      expect(resultIds.has(frag.id)).toBe(true);
    }
  });

  it('pipeline adds graph-enriched results beyond what baseline provides', async () => {
    // Baseline would just search for "billing" — pipeline also gets graph expansions
    const db = createMockDb({
      allResults: [
        // blocks
        [],
        // activateGraph: "billing" → "stripe" neighbor
        [{ id: 1, label: 'billing', node_type: 'concept' }],
        [{ neighbor_id: 2, weight: 0.9, edge_id: 1 }],
        [], // hop 1
        [{ id: 2, label: 'stripe', node_type: 'tool' }],
        // fetchNodeMemoryIds
        [{ label: 'stripe', memory_ids: '["frag-stripe"]' }],
      ],
    });

    const mem = createMockMemory([
      makeFragment('frag-billing', 'Billing pipeline design', 'billing', 0.9),
      makeFragment('frag-stripe', 'Stripe webhook integration done', 'payments', 0.8),
    ]);

    const result = await recallForQuery('billing', { db, memoryBinding: mem });

    // Pipeline should find "stripe" via graph expansion even though baseline
    // search for "billing" might not return it
    expect(result.graphExpansions).toContain('stripe');
    expect(result.facts.some(f => f.id === 'frag-stripe')).toBe(true);
  });
});
