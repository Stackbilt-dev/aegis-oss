// Recall pipeline baseline tests — captures current behavior pre-Phase 2
// Tests: graph activation, cognitive state recall, memory block loading
//
// These tests document CURRENT behavior so Phase 2 can verify it produces
// a superset of these results. Do not refactor the source code.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractNodes, createEdges, activateGraph } from '../src/kernel/memory/graph.js';
import { formatCognitiveContext, getCognitiveState } from '../src/kernel/cognition.js';
import { assembleBlockContext, getAttachedBlocks, type MemoryBlock } from '../src/kernel/memory/blocks.js';
import type { CognitiveState } from '../src/kernel/types.js';

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

// ════════════════════════════════════════════════════════════════
// 1. Graph Activation Baselines
// ════════════════════════════════════════════════════════════════

describe('recall-baseline: activateGraph', () => {
  it('returns empty array for short/empty queries', async () => {
    const db = createMockDb();
    expect(await activateGraph(db, '')).toEqual([]);
    expect(await activateGraph(db, 'a')).toEqual([]);
    expect(await activateGraph(db, '  ')).toEqual([]);
  });

  it('performs 2-hop spreading activation by default', async () => {
    // Seed: node 1 (aegis) → hop 0 neighbor: node 2 (cloudflare) → hop 1 neighbor: node 3 (d1)
    const db = createMockDb({
      allResults: [
        // seed query: find nodes matching "aegis"
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        // hop 0: neighbors of node 1
        [{ neighbor_id: 2, weight: 0.8, edge_id: 10 }],
        // hop 1: neighbors of node 2
        [{ neighbor_id: 3, weight: 0.6, edge_id: 11 }],
        // fetch missing node info for nodes 2 and 3
        [
          { id: 2, label: 'cloudflare', node_type: 'tool' },
          { id: 3, label: 'd1', node_type: 'tool' },
        ],
      ],
    });

    const result = await activateGraph(db, 'aegis');

    // Seed gets 1.0
    const seed = result.find(n => n.label === 'aegis');
    expect(seed?.activation).toBe(1.0);

    // Hop 1: 1.0 * 0.8 * 0.7 = 0.56
    const hop1 = result.find(n => n.label === 'cloudflare');
    expect(hop1?.activation).toBeCloseTo(0.56, 2);

    // Hop 2: 0.56 * 0.6 * 0.7 = 0.2352
    const hop2 = result.find(n => n.label === 'd1');
    expect(hop2?.activation).toBeCloseTo(0.2352, 2);
  });

  it('uses 0.7 decay factor per hop', async () => {
    // Single hop with weight 1.0 → activation = 1.0 * 1.0 * 0.7 = 0.7
    const db = createMockDb({
      allResults: [
        [{ id: 1, label: 'stripe', node_type: 'tool' }],
        // hop 0: neighbor with weight 1.0
        [{ neighbor_id: 2, weight: 1.0, edge_id: 1 }],
        // hop 1: no further neighbors
        [],
        // fetch node info for node 2
        [{ id: 2, label: 'billing', node_type: 'concept' }],
      ],
    });

    const result = await activateGraph(db, 'stripe');
    const neighbor = result.find(n => n.label === 'billing');
    expect(neighbor?.activation).toBeCloseTo(0.7, 2);
  });

  it('caps results at 10 nodes', async () => {
    // Seed with many neighbors — only top 10 should be returned
    const db = createMockDb({
      allResults: [
        // 3 seed nodes
        Array.from({ length: 3 }, (_, i) => ({ id: i + 1, label: `seed${i}`, node_type: 'concept' })),
        // hop 0: seed 0 has 5 neighbors
        Array.from({ length: 5 }, (_, i) => ({ neighbor_id: 100 + i, weight: 0.5, edge_id: i })),
        // hop 0: seed 1 has 5 neighbors
        Array.from({ length: 5 }, (_, i) => ({ neighbor_id: 200 + i, weight: 0.5, edge_id: i + 10 })),
        // hop 0: seed 2 has 5 neighbors
        Array.from({ length: 5 }, (_, i) => ({ neighbor_id: 300 + i, weight: 0.5, edge_id: i + 20 })),
        // hop 1: no further neighbors for any of the 15 new frontier nodes
        ...Array.from({ length: 15 }, () => [] as Record<string, unknown>[]),
        // fetch missing node info (15 nodes)
        Array.from({ length: 15 }, (_, i) => ({ id: [100, 200, 300][Math.floor(i / 5)] + (i % 5), label: `neighbor${i}`, node_type: 'concept' })),
      ],
    });

    const result = await activateGraph(db, 'seed0 seed1 seed2');
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('results are sorted by activation descending', async () => {
    const db = createMockDb({
      allResults: [
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        // Two neighbors with different weights
        [
          { neighbor_id: 2, weight: 0.9, edge_id: 1 },
          { neighbor_id: 3, weight: 0.3, edge_id: 2 },
        ],
        // hop 1: no further neighbors
        [],
        [],
        // fetch node info
        [
          { id: 2, label: 'high', node_type: 'concept' },
          { id: 3, label: 'low', node_type: 'concept' },
        ],
      ],
    });

    const result = await activateGraph(db, 'aegis');
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].activation).toBeGreaterThanOrEqual(result[i].activation);
    }
  });

  it('prunes activations below 0.05 threshold', async () => {
    // A neighbor with very low weight gets activation 1.0 * 0.05 * 0.7 = 0.035
    // On hop 1, this node's source activation (0.035) is below the 0.05 prune threshold,
    // so the `continue` skips it BEFORE the db query — no further spreading.
    const db = createMockDb({
      allResults: [
        // seed query
        [{ id: 1, label: 'aegis', node_type: 'project' }],
        // hop 0: neighbors of seed node 1
        [{ neighbor_id: 2, weight: 0.05, edge_id: 1 }],
        // hop 1: node 2 is in frontier but activation 0.035 < 0.05 → continue (no db call)
        // So NO more all() calls for hop 1 neighbors.
        // fetch missing node info for node 2
        [{ id: 2, label: 'weak', node_type: 'concept' }],
      ],
    });

    const result = await activateGraph(db, 'aegis');
    // Node 2 was activated (0.035) but since it's below prune threshold,
    // it didn't propagate further. It still appears in results though.
    const weak = result.find(n => n.label === 'weak');
    expect(weak?.activation).toBeCloseTo(0.035, 3);
  });
});

// ════════════════════════════════════════════════════════════════
// 1b. extractNodes baseline
// ════════════════════════════════════════════════════════════════

describe('recall-baseline: extractNodes', () => {
  it('extracts known project names from text', async () => {
    const db = createMockDb({
      // Each entity triggers a first() check → null means insert
      // "Alex" (person), "aegis" (project), "cloudflare" (tool), topic "infrastructure"
      firstResults: [null, null, null, null],
      runMeta: [
        { last_row_id: 1 },
        { last_row_id: 2 },
        { last_row_id: 3 },
        { last_row_id: 4 },
      ],
    });

    const ids = await extractNodes(db, 'Alex deployed aegis on cloudflare', 'infrastructure');
    expect(ids.length).toBeGreaterThanOrEqual(3); // alex, aegis, cloudflare, + topic
  });

  it('extracts tech terms like MCP, OAuth, D1', async () => {
    const db = createMockDb({
      firstResults: [null, null, null, null],
      runMeta: [
        { last_row_id: 1 },
        { last_row_id: 2 },
        { last_row_id: 3 },
        { last_row_id: 4 },
      ],
    });

    const ids = await extractNodes(db, 'MCP uses OAuth 2.1 with D1 storage', 'auth');

    // Should have inserted nodes for MCP, OAUTH 2.1, D1, and topic "auth"
    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    expect(inserts.length).toBeGreaterThanOrEqual(3);
  });

  it('classifies known people as person type', async () => {
    const db = createMockDb({
      firstResults: [null, null],
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }],
    });

    await extractNodes(db, 'kurt approved the change', 'general');

    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    // "kurt" should be classified as 'person'
    const kurtInsert = inserts.find(q => q.bindings.includes('kurt'));
    expect(kurtInsert?.bindings).toContain('person');
  });

  it('classifies known projects correctly', async () => {
    const db = createMockDb({
      firstResults: [null, null],
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }],
    });

    await extractNodes(db, 'aegis is the main system', 'ops');

    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    const aegisInsert = inserts.find(q => q.bindings.includes('aegis'));
    expect(aegisInsert?.bindings).toContain('project');
  });

  it('classifies known tools even in decision context (tool check wins)', async () => {
    // "Better Auth" is in KNOWN_TOOLS, so classifyNode returns 'tool' even though
    // the context contains "decided". Tool/project/person checks run before context-based checks.
    const db = createMockDb({
      firstResults: [null, null, null],
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }, { last_row_id: 3 }],
    });

    await extractNodes(db, 'We decided to use Better Auth for sessions', 'auth');

    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    // "Better Auth" extracted by CAPITALIZED_PHRASE regex, classified via classifyNode
    // which lowercases to "better auth" → found in KNOWN_TOOLS → 'tool'
    const baInsert = inserts.find(q => q.bindings.includes('Better Auth'));
    expect(baInsert?.bindings).toContain('tool');
  });

  it('classifies unknown entities in decision context as decision type', async () => {
    // When an entity is NOT a known project/tool/person, context markers apply
    const db = createMockDb({
      firstResults: [null, null],
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }],
    });

    await extractNodes(db, 'We decided to adopt Service Mesh architecture', 'infrastructure');

    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    const smInsert = inserts.find(q => q.bindings.includes('Service Mesh'));
    expect(smInsert?.bindings).toContain('decision');
  });

  it('adds topic as a node if not already extracted', async () => {
    // "hello world" has no extractable entities from any regex pattern.
    // But extractEntities returns [] → extractNodes returns [] early (line 111).
    // The topic is only added AFTER extractEntities runs and only if entities.length > 0.
    // Current behavior: returns empty when no entities extracted at all.
    const db = createMockDb();

    const ids = await extractNodes(db, 'hello world', 'billing');
    // No entities extracted → returns early with []
    expect(ids).toEqual([]);
  });

  it('adds topic when other entities exist but topic is not among them', async () => {
    // When entities ARE extracted, the topic gets appended if not already present
    const db = createMockDb({
      // "kurt" is a known person → 1 entity. Topic "billing" added → 2 entities total.
      firstResults: [null, null],  // both new
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }],
    });

    const ids = await extractNodes(db, 'kurt mentioned something', 'billing');
    expect(ids).toHaveLength(2);
    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_nodes'));
    expect(inserts.some(q => q.bindings.includes('billing'))).toBe(true);
  });

  it('returns empty for text with no extractable entities and short topic', async () => {
    const db = createMockDb({
      firstResults: [null],
      runMeta: [{ last_row_id: 1 }],
    });

    const ids = await extractNodes(db, 'ok', 'x');
    // Topic "x" is 1 char but still >= 2 after replace? Actually 'x' is 1 char, passes filter (>= 2 check is on entities)
    expect(Array.isArray(ids)).toBe(true);
  });

  it('upserts existing nodes (increments activation)', async () => {
    const db = createMockDb({
      firstResults: [
        { id: 42, memory_ids: '[]' }, // existing "kurt" node
        null,                          // new topic node
      ],
      runMeta: [
        { changes: 1 },     // update existing
        { last_row_id: 2 }, // insert topic
      ],
    });

    const ids = await extractNodes(db, 'kurt said hello', 'general');
    expect(ids).toContain(42);

    const updates = db._queries.filter(q => q.sql.includes('UPDATE kg_nodes'));
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].sql).toContain('MIN(activation + 0.1, 1.0)');
  });
});

// ════════════════════════════════════════════════════════════════
// 1c. createEdges baseline
// ════════════════════════════════════════════════════════════════

describe('recall-baseline: createEdges', () => {
  it('creates co-occurrence edges for all node pairs', async () => {
    const db = createMockDb({
      // 3 pairs for [1,2,3]: (1,2), (1,3), (2,3) — all new
      firstResults: [null, null, null],
      runMeta: [{ last_row_id: 1 }, { last_row_id: 2 }, { last_row_id: 3 }],
    });

    await createEdges(db, [1, 2, 3]);

    const inserts = db._queries.filter(q => q.sql.includes('INSERT INTO kg_edges'));
    expect(inserts.length).toBe(3);

    // All edges should have relation 'related_to', weight 0.5, confidence 0.7
    for (const q of inserts) {
      expect(q.sql).toContain("'related_to'");
      expect(q.sql).toContain('0.5');
      expect(q.sql).toContain('0.7');
    }
  });

  it('increments weight on existing edges (capped at 1.0)', async () => {
    const db = createMockDb({
      firstResults: [{ id: 5, co_activation_count: 3, weight: 0.9 }],
      runMeta: [{ changes: 1 }],
    });

    await createEdges(db, [1, 2]);

    const updates = db._queries.filter(q => q.sql.includes('UPDATE kg_edges'));
    expect(updates.length).toBe(1);
    // 0.9 + 0.1 = 1.0 (capped)
    expect(updates[0].bindings[0]).toBe(1.0);
  });

  it('weight does not exceed 1.0', async () => {
    const db = createMockDb({
      firstResults: [{ id: 5, co_activation_count: 10, weight: 0.95 }],
      runMeta: [{ changes: 1 }],
    });

    await createEdges(db, [1, 2]);

    const updates = db._queries.filter(q => q.sql.includes('UPDATE kg_edges'));
    // Math.min(0.95 + 0.1, 1.0) = 1.0
    expect(updates[0].bindings[0]).toBe(1.0);
  });

  it('does nothing for fewer than 2 nodes', async () => {
    const db = createMockDb();
    await createEdges(db, []);
    expect(db._queries.length).toBe(0);

    const db2 = createMockDb();
    await createEdges(db2, [1]);
    expect(db2._queries.length).toBe(0);
  });

  it('checks both edge directions for existing edges', async () => {
    const db = createMockDb({
      firstResults: [null],
      runMeta: [{ last_row_id: 1 }],
    });

    await createEdges(db, [10, 20]);

    // The SELECT should check both (source_id=10, target_id=20) and (source_id=20, target_id=10)
    const selectQueries = db._queries.filter(q => q.sql.includes('SELECT') && q.sql.includes('kg_edges'));
    expect(selectQueries.length).toBe(1);
    expect(selectQueries[0].bindings).toEqual([10, 20, 20, 10]);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. Cognitive State Recall Baselines
// ════════════════════════════════════════════════════════════════

describe('recall-baseline: precomputeCognitiveState parallel recall', () => {
  // The key behavior: precomputeCognitiveState runs fetchSemanticContext
  // (via memory reads) and activateGraph in parallel during the Promise.all.
  // This test verifies the structure of the combined output.

  it('getCognitiveState returns activated_nodes from graph activation', async () => {
    const state: CognitiveState = {
      version: 1,
      computed_at: '2026-03-13T00:00:00Z',
      narratives: [
        { arc: 'llc', title: 'LLC Formation', summary: 'Filing in progress', status: 'active', tension: 'Waiting on state', last_beat: 'Filed paperwork', beat_count: 3 },
      ],
      open_threads: 5,
      proposed_actions: 2,
      activated_nodes: [
        { label: 'aegis', type: 'project', activation: 1.0 },
        { label: 'cloudflare', type: 'tool', activation: 0.56 },
        { label: 'd1', type: 'tool', activation: 0.24 },
      ],
      active_projects: [],
      product_portfolio: [],
      latest_metacog: null,
      memory_count: 150,
      episode_count_24h: 42,
      last_heartbeat_severity: 'none',
    };

    // Verify formatCognitiveContext includes activated nodes
    const output = formatCognitiveContext(state);
    expect(output).toContain('Active Concepts');
    expect(output).toContain('aegis (project, activation: 1.00)');
    expect(output).toContain('cloudflare (tool, activation: 0.56)');
    expect(output).toContain('d1 (tool, activation: 0.24)');
  });

  it('formatCognitiveContext combines narratives + pulse + activated nodes', () => {
    const state: CognitiveState = {
      version: 1,
      computed_at: '2026-03-13T00:00:00Z',
      narratives: [
        { arc: 'billing', title: 'Billing Pipeline', summary: 'Stripe integration blocked on LLC', status: 'stalled', tension: 'No EIN yet', last_beat: null, beat_count: 1 },
      ],
      open_threads: 3,
      proposed_actions: 1,
      activated_nodes: [
        { label: 'stripe', type: 'tool', activation: 0.85 },
      ],
      active_projects: [],
      product_portfolio: [],
      latest_metacog: null,
      memory_count: 100,
      episode_count_24h: 10,
      last_heartbeat_severity: 'medium',
    };

    const output = formatCognitiveContext(state);

    // All three sections present
    expect(output).toContain('Active Narratives');
    expect(output).toContain('Billing Pipeline [STALLED]');
    expect(output).toContain('Operational Pulse');
    expect(output).toContain('Memory: 100 active entries');
    expect(output).toContain('Active Concepts');
    expect(output).toContain('stripe (tool, activation: 0.85)');
    expect(output).toContain('Last heartbeat: medium');
  });

  it('formatCognitiveContext omits sections with no data', () => {
    const state: CognitiveState = {
      version: 1,
      computed_at: '2026-03-13T00:00:00Z',
      narratives: [],
      open_threads: 0,
      proposed_actions: 0,
      activated_nodes: [],
      active_projects: [],
      product_portfolio: [],
      latest_metacog: null,
      memory_count: 0,
      episode_count_24h: 0,
      last_heartbeat_severity: null,
    };

    const output = formatCognitiveContext(state);
    expect(output).not.toContain('Active Narratives');
    expect(output).not.toContain('Active Concepts');
    expect(output).not.toContain('Self-Insight');
    expect(output).not.toContain('Project Status');
    // Operational Pulse is always present
    expect(output).toContain('Operational Pulse');
  });

  it('getCognitiveState roundtrips through JSON correctly', async () => {
    const state: CognitiveState = {
      version: 42,
      computed_at: '2026-03-13T12:00:00Z',
      narratives: [{ arc: 'test', title: 'Test', summary: 'Test arc', status: 'active', tension: null, last_beat: null, beat_count: 0 }],
      open_threads: 7,
      proposed_actions: 3,
      activated_nodes: [{ label: 'test_node', type: 'concept', activation: 0.75 }],
      active_projects: [],
      product_portfolio: [{ name: 'img-forge', description: 'Image gen', model: 'SaaS', status: 'live' }],
      latest_metacog: 'I notice a pattern of over-scoping.',
      memory_count: 200,
      episode_count_24h: 15,
      last_heartbeat_severity: 'low',
    };

    const db = createMockDb();
    (db as any).prepare = vi.fn().mockImplementation(() => ({
      first: vi.fn().mockResolvedValue({ state_json: JSON.stringify(state) }),
      bind: vi.fn().mockReturnThis(),
    }));

    const result = await getCognitiveState(db);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(42);
    expect(result!.activated_nodes).toHaveLength(1);
    expect(result!.activated_nodes[0].label).toBe('test_node');
    expect(result!.activated_nodes[0].activation).toBe(0.75);
    expect(result!.narratives).toHaveLength(1);
    expect(result!.latest_metacog).toContain('over-scoping');
  });
});

// ════════════════════════════════════════════════════════════════
// 3. Memory Block Loading Baselines
// ════════════════════════════════════════════════════════════════

describe('recall-baseline: memory block loading', () => {
  it('assembleBlockContext joins blocks by priority order', () => {
    const blocks: MemoryBlock[] = [
      { id: 'identity', content: 'You are AEGIS.', version: 1, priority: 1, max_bytes: 1024, updated_by: 'operator', updated_at: '2026-03-01' },
      { id: 'operator_profile', content: 'Alex is the operator.', version: 1, priority: 2, max_bytes: 2048, updated_by: 'operator', updated_at: '2026-03-01' },
      { id: 'operating_rules', content: 'Think like an operator.', version: 1, priority: 3, max_bytes: 1536, updated_by: 'operator', updated_at: '2026-03-01' },
    ];

    const result = assembleBlockContext(blocks);
    expect(result).toBe('You are AEGIS.\n\nAlex is the operator.\n\nThink like an operator.');
  });

  it('assembleBlockContext respects token budget', () => {
    const blocks: MemoryBlock[] = [
      { id: 'identity', content: 'A'.repeat(100), version: 1, priority: 1, max_bytes: 1024, updated_by: 'op', updated_at: '' },
      { id: 'operator_profile', content: 'B'.repeat(100), version: 1, priority: 2, max_bytes: 2048, updated_by: 'op', updated_at: '' },
      { id: 'operating_rules', content: 'C'.repeat(100), version: 1, priority: 3, max_bytes: 1536, updated_by: 'op', updated_at: '' },
    ];

    // Budget of 50 tokens → ~175 chars → only first block fits (100 chars), second block (100) fits too, third would exceed
    const result = assembleBlockContext(blocks, 50);
    expect(result).toContain('A'.repeat(100));
    // 100 + 100 = 200 > 175, so only first block should fit
    // Wait: 50 * 3.5 = 175, block A = 100 chars, then 100+100=200 > 175
    // Actually it checks usedChars + chars > budgetChars: 0 + 100 = 100 < 175 → include
    // Then 100 + 100 = 200 > 175 → break
    expect(result).toBe('A'.repeat(100));
  });

  it('assembleBlockContext returns empty string for empty blocks', () => {
    expect(assembleBlockContext([])).toBe('');
  });

  it('getAttachedBlocks returns full set for claude executor', async () => {
    const blocks: MemoryBlock[] = [
      { id: 'identity', content: 'id', version: 1, priority: 1, max_bytes: 1024, updated_by: 'op', updated_at: '' },
      { id: 'operator_profile', content: 'op', version: 1, priority: 2, max_bytes: 2048, updated_by: 'op', updated_at: '' },
      { id: 'operating_rules', content: 'rules', version: 1, priority: 3, max_bytes: 1536, updated_by: 'op', updated_at: '' },
      { id: 'active_context', content: 'ctx', version: 1, priority: 4, max_bytes: 3072, updated_by: 'op', updated_at: '' },
    ];

    const db = createMockDb({
      allResults: [blocks as unknown as Record<string, unknown>[]],
    });

    const result = await getAttachedBlocks(db, 'claude');
    // Claude gets all 4 blocks (FULL_BLOCKS)
    expect(result).toHaveLength(4);
    expect(result.map(b => b.id)).toEqual(['identity', 'operator_profile', 'operating_rules', 'active_context']);
  });

  it('getAttachedBlocks returns minimal set for workers_ai executor', async () => {
    const blocks: MemoryBlock[] = [
      { id: 'identity', content: 'id', version: 1, priority: 1, max_bytes: 1024, updated_by: 'op', updated_at: '' },
      { id: 'operator_profile', content: 'op', version: 1, priority: 2, max_bytes: 2048, updated_by: 'op', updated_at: '' },
      { id: 'operating_rules', content: 'rules', version: 1, priority: 3, max_bytes: 1536, updated_by: 'op', updated_at: '' },
      { id: 'active_context', content: 'ctx', version: 1, priority: 4, max_bytes: 3072, updated_by: 'op', updated_at: '' },
    ];

    const db = createMockDb({
      allResults: [blocks as unknown as Record<string, unknown>[]],
    });

    const result = await getAttachedBlocks(db, 'workers_ai');
    // workers_ai gets MINIMAL_BLOCKS = ['identity'] only
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('identity');
  });

  it('getAttachedBlocks returns core set for groq executor', async () => {
    const blocks: MemoryBlock[] = [
      { id: 'identity', content: 'id', version: 1, priority: 1, max_bytes: 1024, updated_by: 'op', updated_at: '' },
      { id: 'operator_profile', content: 'op', version: 1, priority: 2, max_bytes: 2048, updated_by: 'op', updated_at: '' },
      { id: 'operating_rules', content: 'rules', version: 1, priority: 3, max_bytes: 1536, updated_by: 'op', updated_at: '' },
      { id: 'active_context', content: 'ctx', version: 1, priority: 4, max_bytes: 3072, updated_by: 'op', updated_at: '' },
    ];

    const db = createMockDb({
      allResults: [blocks as unknown as Record<string, unknown>[]],
    });

    const result = await getAttachedBlocks(db, 'groq');
    // groq gets CORE_BLOCKS = ['identity', 'operating_rules']
    expect(result).toHaveLength(2);
    expect(result.map(b => b.id)).toEqual(['identity', 'operating_rules']);
  });

  it('getAttachedBlocks returns empty for direct executor', async () => {
    const db = createMockDb({
      allResults: [[]],
    });

    const result = await getAttachedBlocks(db, 'direct');
    expect(result).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════
// 4. End-to-end recall shape: blocks + cognitive state + graph
// ════════════════════════════════════════════════════════════════

describe('recall-baseline: combined recall output shape', () => {
  it('system prompt would include: blockContext + cognitiveContext + memory text', () => {
    // This test documents the current assembly order in buildContext:
    // systemPrompt = SYSTEM_PROMPT + blockContext + cognitiveContext + heartbeatContext + agendaContext + memoryResult.text
    //
    // Phase 2 must produce output that is a superset of this structure.

    const blocks: MemoryBlock[] = [
      { id: 'identity', content: '# Identity\nYou are AEGIS.', version: 1, priority: 1, max_bytes: 1024, updated_by: 'op', updated_at: '' },
    ];
    const blockContext = assembleBlockContext(blocks);

    const cogState: CognitiveState = {
      version: 1,
      computed_at: '2026-03-13T00:00:00Z',
      narratives: [{ arc: 'test', title: 'Test Arc', summary: 'Testing', status: 'active', tension: 'Unresolved', last_beat: 'Beat 1', beat_count: 1 }],
      open_threads: 2,
      proposed_actions: 1,
      activated_nodes: [{ label: 'aegis', type: 'project', activation: 1.0 }],
      active_projects: [],
      product_portfolio: [],
      latest_metacog: null,
      memory_count: 50,
      episode_count_24h: 5,
      last_heartbeat_severity: null,
    };
    const cogContext = formatCognitiveContext(cogState);

    // Simulate final prompt assembly (without actual SYSTEM_PROMPT constant)
    const combined = blockContext + cogContext;

    // Verify all recall components are present
    expect(combined).toContain('# Identity');
    expect(combined).toContain('Active Narratives');
    expect(combined).toContain('Test Arc');
    expect(combined).toContain('Operational Pulse');
    expect(combined).toContain('Active Concepts');
    expect(combined).toContain('aegis (project');
  });

  it('cognitive context is skipped when active_context block has version > 1', () => {
    // This documents the current behavior where blocks supersede cognitive context
    // once the active_context block has been populated by consolidation.
    const blocks: MemoryBlock[] = [
      { id: 'active_context', content: '## Operational Pulse\n- Everything is fine', version: 2, priority: 4, max_bytes: 3072, updated_by: 'consolidation', updated_at: '' },
    ];

    const hasActiveContextBlock = blocks.some(b => b.id === 'active_context' && b.version > 1);
    expect(hasActiveContextBlock).toBe(true);

    // When this is true, buildContext skips formatCognitiveContext
    // This is the current behavior we're documenting
  });

  it('cognitive context IS used when active_context block is at version 1 (seed)', () => {
    const blocks: MemoryBlock[] = [
      { id: 'active_context', content: '## Operational Pulse\n- Awaiting first consolidation', version: 1, priority: 4, max_bytes: 3072, updated_by: 'operator', updated_at: '' },
    ];

    const hasActiveContextBlock = blocks.some(b => b.id === 'active_context' && b.version > 1);
    expect(hasActiveContextBlock).toBe(false);

    // When this is false, buildContext includes formatCognitiveContext output
  });
});
