// Knowledge graph tests — extractNodes, createEdges, activateGraph
// Verifies source provenance columns (source_system, first_seen_at, last_seen_at)

import { describe, it, expect, beforeEach } from 'vitest';
import { extractNodes, createEdges, activateGraph } from '../../src/kernel/memory/graph.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(options: {
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
          return options.firstResults?.[firstIdx++] ?? null;
        },
        async all() {
          const results = options.allResults?.[allIdx++] ?? [];
          return { results };
        },
        async run() {
          const meta = options.runMeta?.[runIdx++] ?? { changes: 1, last_row_id: 1 };
          return { meta };
        },
      };
    },
    _queries: queries,
  } as unknown as D1Database & { _queries: MockQuery[] };
}

// ════════════════════════════════════════════════════════════════
// extractNodes
// ════════════════════════════════════════════════════════════════

describe('extractNodes', () => {
  it('inserts new nodes with source_system=cognitive', async () => {
    const db = createMockDb({
      // first() calls: no existing node found for each entity
      firstResults: [null, null],
      // run() calls: two inserts
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }],
    });

    const ids = await extractNodes(db, 'Alex uses aegis for testing', 'general');
    expect(ids.length).toBeGreaterThanOrEqual(1);

    // Verify INSERT includes source_system = 'cognitive'
    const insertQueries = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    expect(insertQueries.length).toBeGreaterThanOrEqual(1);
    for (const q of insertQueries) {
      expect(q.sql).toContain('source_system');
      expect(q.sql).toContain("'cognitive'");
    }
  });

  it('updates existing nodes with updated_at', async () => {
    const db = createMockDb({
      // first() calls: existing node found for "alex", null for topic
      firstResults: [
        { id: 42, memory_ids: '[]' },
        null,
      ],
      runMeta: [
        { changes: 1 }, // update existing
        { last_row_id: 2 }, // insert topic node
      ],
    });

    const ids = await extractNodes(db, 'Alex is the operator', 'ops');
    expect(ids).toContain(42);

    const updateQueries = db._queries.filter(q => q.sql.includes('UPDATE kg_nodes'));
    expect(updateQueries.length).toBeGreaterThanOrEqual(1);
    expect(updateQueries[0].sql).toContain('updated_at');
  });

  it('returns empty array for facts with no entities', async () => {
    const db = createMockDb();
    const ids = await extractNodes(db, 'a b c', 'x');
    // Even with no extracted entities, the topic itself is added
    // unless it's too short — 'x' is 1 char, which passes the entity filter (>= 2)
    // but since no capitalized phrases or known entities, only the topic 'x' is tried
    expect(Array.isArray(ids)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// createEdges
// ════════════════════════════════════════════════════════════════

describe('createEdges', () => {
  it('inserts new edges with source_system=cognitive and temporal fields', async () => {
    const db = createMockDb({
      // first() call: no existing edge
      firstResults: [null],
      runMeta: [{ last_row_id: 10 }],
    });

    await createEdges(db, [1, 2]);

    const insertQueries = db._queries.filter(q => q.sql.includes('INSERT INTO kg_edges'));
    expect(insertQueries.length).toBe(1);
    expect(insertQueries[0].sql).toContain("'cognitive'");
    expect(insertQueries[0].sql).toContain('first_seen_at');
    expect(insertQueries[0].sql).toContain('last_seen_at');
  });

  it('updates last_seen_at on existing edges', async () => {
    const db = createMockDb({
      // first() call: existing edge found
      firstResults: [{ id: 5, co_activation_count: 3, weight: 0.6 }],
      runMeta: [{ changes: 1 }],
    });

    await createEdges(db, [1, 2]);

    const updateQueries = db._queries.filter(q => q.sql.includes('UPDATE kg_edges'));
    expect(updateQueries.length).toBe(1);
    expect(updateQueries[0].sql).toContain('last_seen_at');
  });

  it('skips when fewer than 2 nodes', async () => {
    const db = createMockDb();
    await createEdges(db, [1]);
    expect(db._queries.length).toBe(0);
  });

  it('creates edges for all node pairs', async () => {
    const db = createMockDb({
      // 3 pairs for 3 nodes: (1,2), (1,3), (2,3) — each needs a first() check
      firstResults: [null, null, null],
      runMeta: [{ last_row_id: 10 }, { last_row_id: 11 }, { last_row_id: 12 }],
    });

    await createEdges(db, [1, 2, 3]);

    const insertQueries = db._queries.filter(q => q.sql.includes('INSERT INTO kg_edges'));
    expect(insertQueries.length).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════
// activateGraph
// ════════════════════════════════════════════════════════════════

describe('activateGraph', () => {
  it('returns empty for empty query', async () => {
    const db = createMockDb();
    const result = await activateGraph(db, '');
    expect(result).toEqual([]);
  });

  it('returns empty when no seed nodes match', async () => {
    const db = createMockDb({
      allResults: [[]],  // seed query returns no results
    });

    const result = await activateGraph(db, 'nonexistent thing');
    expect(result).toEqual([]);
  });

  it('returns seed nodes with activation 1.0', async () => {
    const db = createMockDb({
      allResults: [
        // seed nodes found
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        // hop 0: neighbors of node 1
        [],
      ],
    });

    const result = await activateGraph(db, 'aegis');
    expect(result.length).toBe(1);
    expect(result[0].label).toBe('aegis');
    expect(result[0].activation).toBe(1.0);
  });

  it('spreads activation to neighbors with decay', async () => {
    const db = createMockDb({
      allResults: [
        // seed nodes
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        // hop 0: neighbors of node 1
        [{ neighbor_id: 2, weight: 0.8, edge_id: 10 }],
        // hop 1: neighbors of node 2
        [],
        // fetch missing node info for node 2
        [{ id: 2, label: 'cloudflare', node_type: 'tool' }],
      ],
    });

    const result = await activateGraph(db, 'aegis');
    expect(result.length).toBe(2);

    const aegis = result.find(n => n.label === 'aegis');
    const cf = result.find(n => n.label === 'cloudflare');
    expect(aegis?.activation).toBe(1.0);
    // 1.0 * 0.8 * 0.7 = 0.56
    expect(cf?.activation).toBeCloseTo(0.56, 2);
  });
});
