// Recall pipeline tests — Stage 3.5: MindSpring conversation history
// Tests the MindSpring integration within recallForQuery: query construction,
// fetch behavior, graceful degradation, and RRF fusion with other layers.

import { describe, it, expect, vi } from 'vitest';
import { recallForQuery, rrf } from '../src/kernel/memory/recall.js';
import type { MemoryServiceBinding, MemoryFragmentResult } from '../src/types.js';

// ─── D1 Mock Factory (reused from recall-pipeline.test.ts) ──────

function createMockDb(opts: {
  allResults?: Record<string, unknown>[][];
} = {}) {
  let allIdx = 0;
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) { return this; },
        async first() { return null; },
        async all() {
          const results = opts.allResults?.[allIdx++] ?? [];
          return { results };
        },
        async run() { return { meta: { changes: 1, last_row_id: 1 } }; },
      };
    },
  } as unknown as D1Database;
}

// ─── Memory Worker Mock Factory ────────────────────────────────

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

// ─── MindSpring Fetcher Mock Factory ───────────────────────────

function createMockMindspring(
  results: Array<{ id: string; title: string; text: string; score: number }> = [],
  opts?: { ok?: boolean; throws?: boolean },
): Fetcher {
  const ok = opts?.ok ?? true;
  const throws = opts?.throws ?? false;

  return {
    fetch: vi.fn().mockImplementation(async () => {
      if (throws) throw new Error('MindSpring connection refused');
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => ({ results }),
      };
    }),
    connect: vi.fn() as any,
  } as unknown as Fetcher;
}

// Minimal DB that returns empty blocks + no graph seeds (isolates MindSpring tests)
function emptyDb() {
  return createMockDb({ allResults: [[], []] });
}

// ════════════════════════════════════════════════════════════════
// Stage 3.5: MindSpring conversation history search
// ════════════════════════════════════════════════════════════════

describe('recall-pipeline: Stage 3.5 MindSpring', () => {
  it('includes MindSpring results in pipeline output with source=mindspring', async () => {
    const ms = createMockMindspring([
      { id: 'conv-1', title: 'LLC formation discussion', text: 'We discussed filing in TX', score: 0.85 },
    ]);

    const result = await recallForQuery('LLC formation', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    expect(result.facts.length).toBe(1);
    expect(result.facts[0].id).toBe('ms:conv-1');
    expect(result.facts[0].source).toBe('mindspring');
    expect(result.facts[0].text).toContain('Prior conversation');
    expect(result.facts[0].text).toContain('LLC formation discussion');
    expect(result.mindspringHits).toBe(1);
  });

  it('synthesizes fact text from title and truncated content', async () => {
    const longText = 'A'.repeat(800);
    const ms = createMockMindspring([
      { id: 'conv-2', title: 'Long discussion', text: longText, score: 0.7 },
    ]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    const fact = result.facts[0];
    // Title appears in synthesized text
    expect(fact.text).toContain('Long discussion');
    // Text is truncated to 500 chars (plus prefix)
    expect(fact.text.length).toBeLessThan(600); // prefix + 500 max
    expect(fact.text).not.toContain('A'.repeat(501));
  });

  it('passes query with graph expansions to MindSpring', async () => {
    const db = createMockDb({
      allResults: [
        // Stage 1: blocks empty
        [],
        // Stage 2: activateGraph — "billing" seed → "stripe" neighbor
        [{ id: 1, label: 'billing', node_type: 'concept' }],
        [{ neighbor_id: 2, weight: 0.9, edge_id: 1 }],
        [], // hop 1
        [{ id: 2, label: 'stripe', node_type: 'tool' }],
        // fetchNodeMemoryIds
        [],
      ],
    });

    const ms = createMockMindspring([]);

    await recallForQuery('billing', {
      db,
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    // Verify the fetch URL includes graph-expanded terms
    const fetchCall = (ms.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('billing');
    expect(url).toContain(encodeURIComponent('billing'));
    // Graph expansion terms should be appended
    expect(url).toContain(encodeURIComponent('billing stripe'));
  });

  it('limits graph expansions in MindSpring query to 5', async () => {
    const db = createMockDb({
      allResults: [
        // blocks empty
        [],
        // activateGraph returns 7 seed nodes
        [
          { id: 1, label: 'n1', node_type: 'concept' },
          { id: 2, label: 'n2', node_type: 'concept' },
          { id: 3, label: 'n3', node_type: 'concept' },
          { id: 4, label: 'n4', node_type: 'concept' },
          { id: 5, label: 'n5', node_type: 'concept' },
          { id: 6, label: 'n6', node_type: 'concept' },
          { id: 7, label: 'n7', node_type: 'concept' },
        ],
        // hop 0 for each: no neighbors
        [], [], [], [], [], [], [],
        // fetchNodeMemoryIds
        [],
      ],
    });

    const ms = createMockMindspring([]);

    await recallForQuery('test', {
      db,
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    const fetchCall = (ms.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    // Should only have first 5 graph expansions (n1-n5), not n6/n7
    expect(url).toContain('n5');
    expect(url).not.toContain('n6');
    expect(url).not.toContain('n7');
  });

  it('skips MindSpring when fetcher is not provided', async () => {
    const result = await recallForQuery('test', { db: emptyDb() });

    expect(result.mindspringHits).toBe(0);
    expect(result.timing.mindspring_ms).toBeGreaterThanOrEqual(0);
  });

  it('skips MindSpring when token is not provided', async () => {
    const ms = createMockMindspring([
      { id: 'conv-1', title: 'Should not appear', text: 'nope', score: 0.9 },
    ]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      // no mindspringToken
    });

    expect(result.mindspringHits).toBe(0);
    expect((ms.fetch as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('gracefully degrades when MindSpring fetch throws', async () => {
    const ms = createMockMindspring([], { throws: true });

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    // Pipeline should still succeed with 0 MindSpring hits
    expect(result.mindspringHits).toBe(0);
    expect(result.facts).toEqual([]);
  });

  it('gracefully degrades when MindSpring returns non-ok response', async () => {
    const ms = createMockMindspring([], { ok: false });

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    expect(result.mindspringHits).toBe(0);
  });

  it('handles MindSpring response with missing results field', async () => {
    const ms: Fetcher = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}), // no results field
      }),
      connect: vi.fn() as any,
    } as unknown as Fetcher;

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    // Should fall back to empty array via `?? []`
    expect(result.mindspringHits).toBe(0);
  });

  it('returns multiple MindSpring results ranked by position', async () => {
    const ms = createMockMindspring([
      { id: 'conv-1', title: 'First result', text: 'Most relevant', score: 0.95 },
      { id: 'conv-2', title: 'Second result', text: 'Less relevant', score: 0.75 },
      { id: 'conv-3', title: 'Third result', text: 'Least relevant', score: 0.55 },
    ]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    expect(result.mindspringHits).toBe(3);
    expect(result.facts.length).toBe(3);

    // All should be tagged as mindspring
    for (const fact of result.facts) {
      expect(fact.source).toBe('mindspring');
      expect(fact.id).toMatch(/^ms:/);
    }

    // First result should have highest fused score (rank 1 in RRF)
    expect(result.facts[0].id).toBe('ms:conv-1');
    expect(result.facts[0].score).toBeGreaterThan(result.facts[1].score);
  });

  it('records mindspring_ms in timing', async () => {
    const ms = createMockMindspring([]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    expect(typeof result.timing.mindspring_ms).toBe('number');
    expect(result.timing.mindspring_ms).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════════
// MindSpring + Memory Worker fusion via RRF
// ════════════════════════════════════════════════════════════════

describe('recall-pipeline: MindSpring + Memory Worker fusion', () => {
  it('fuses MindSpring and Memory Worker results via RRF', async () => {
    const mem = createMockMemory([
      makeFragment('frag-1', 'AEGIS kernel architecture', 'system', 0.9),
      makeFragment('frag-2', 'Edge runtime on Cloudflare Workers', 'infrastructure', 0.8),
    ]);

    const ms = createMockMindspring([
      { id: 'conv-1', title: 'Architecture review', text: 'Discussed kernel layout', score: 0.88 },
    ]);

    const result = await recallForQuery('architecture', {
      db: emptyDb(),
      memoryBinding: mem,
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    // Should have both memory worker and mindspring results
    const sources = new Set(result.facts.map(f => f.source));
    expect(sources.has('memory_worker')).toBe(true);
    expect(sources.has('mindspring')).toBe(true);
    expect(result.facts.length).toBe(3);
    expect(result.mindspringHits).toBe(1);
  });

  it('MindSpring IDs are prefixed with ms: to avoid collision with memory IDs', async () => {
    // Memory Worker has frag "conv-1", MindSpring also has id "conv-1"
    const mem = createMockMemory([
      makeFragment('conv-1', 'Memory worker fact', 'test', 0.9),
    ]);

    const ms = createMockMindspring([
      { id: 'conv-1', title: 'Conversation', text: 'MindSpring fact', score: 0.85 },
    ]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      memoryBinding: mem,
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    // Both should appear — different prefixed IDs
    const ids = result.facts.map(f => f.id);
    expect(ids).toContain('conv-1');     // memory worker
    expect(ids).toContain('ms:conv-1');  // mindspring
    expect(result.facts.length).toBe(2);
  });

  it('MindSpring results have graph_score=0 (no graph linkage)', async () => {
    const ms = createMockMindspring([
      { id: 'conv-1', title: 'Test', text: 'Content', score: 0.8 },
    ]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    expect(result.facts[0].graph_score).toBe(0);
  });

  it('MindSpring semantic_score comes from the original score field', async () => {
    const ms = createMockMindspring([
      { id: 'conv-1', title: 'Test', text: 'Content', score: 0.72 },
    ]);

    const result = await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    expect(result.facts[0].semantic_score).toBe(0.72);
  });

  it('uses correct search URL with encoded query, limit=5, threshold=0.4', async () => {
    const ms = createMockMindspring([]);

    await recallForQuery('what is AEGIS?', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'test-token',
    });

    const fetchCall = (ms.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain('limit=5');
    expect(url).toContain('threshold=0.4');
    expect(url).toContain(encodeURIComponent('what is AEGIS?'));
    expect(url).toMatch(/^https:\/\/mindspring\/api\/search/);
  });

  it('passes Authorization header with Bearer token', async () => {
    const ms = createMockMindspring([]);

    await recallForQuery('test', {
      db: emptyDb(),
      mindspringFetcher: ms,
      mindspringToken: 'my-secret-token',
    });

    const fetchCall = (ms.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const reqInit = fetchCall[1] as RequestInit;
    expect(reqInit.headers).toEqual({ 'Authorization': 'Bearer my-secret-token' });
  });
});
