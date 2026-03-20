// Procedural memory tests — key helpers, upsert logic, probation system,
// circuit breaker, staleness decay, utility pruning

import { describe, it, expect } from 'vitest';
import {
  complexityTier,
  procedureKey,
  getProcedure,
  upsertProcedure,
  addRefinement,
  degradeProcedure,
  maintainProcedures,
  PROCEDURE_MIN_SUCCESSES,
  PROCEDURE_MIN_SUCCESS_RATE,
} from '../../src/kernel/memory/procedural.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(opts: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Array<{ results: Record<string, unknown>[] }>;
  runResults?: Array<{ success: boolean; meta?: Record<string, unknown> }>;
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
        async first<T>(): Promise<T | null> {
          return (opts.firstResults?.[firstIdx++] ?? null) as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return (opts.allResults?.[allIdx++] ?? { results: [] }) as { results: T[] };
        },
        async run() {
          return opts.runResults?.[runIdx++] ?? { success: true, meta: {} };
        },
      };
    },
    _queries: queries,
  } as unknown as D1Database & { _queries: MockQuery[] };
}

// ─── complexityTier ─────────────────────────────────────────

describe('complexityTier', () => {
  it('maps ≤1 to low', () => {
    expect(complexityTier(0)).toBe('low');
    expect(complexityTier(1)).toBe('low');
  });

  it('maps 2 to mid', () => {
    expect(complexityTier(2)).toBe('mid');
  });

  it('maps ≥3 to high', () => {
    expect(complexityTier(3)).toBe('high');
    expect(complexityTier(5)).toBe('high');
  });

  it('defaults undefined to mid', () => {
    expect(complexityTier(undefined)).toBe('mid');
  });
});

// ─── procedureKey ───────────────────────────────────────────

describe('procedureKey', () => {
  it('combines classification and tier', () => {
    expect(procedureKey('greeting', 1)).toBe('greeting:low');
    expect(procedureKey('code_task', 3)).toBe('code_task:high');
    expect(procedureKey('question', 2)).toBe('question:mid');
  });
});

// ─── getProcedure ───────────────────────────────────────────

describe('getProcedure', () => {
  it('returns null when not found', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await getProcedure(db, 'unknown:low');
    expect(result).toBeNull();
  });

  it('returns procedure when found', async () => {
    const proc = {
      task_pattern: 'greeting:low',
      executor: 'groq_8b',
      status: 'learned',
      success_count: 10,
      fail_count: 1,
    };
    const db = createMockDb({ firstResults: [proc] });
    const result = await getProcedure(db, 'greeting:low');
    expect(result).not.toBeNull();
    expect(result!.executor).toBe('groq_8b');
  });
});

// ─── upsertProcedure ───────────────────────────────────────

describe('upsertProcedure', () => {
  it('inserts new procedure on first success', async () => {
    const db = createMockDb({
      firstResults: [null], // no existing
      runResults: [{ success: true, meta: {} }],
    });

    await upsertProcedure(db, 'greeting:low', 'groq_8b', '{}', 'success', 100, 0.001);

    const insertQuery = db._queries.find(q => q.sql.includes('INSERT'));
    expect(insertQuery).toBeDefined();
    // Executor should be set on success
    expect(insertQuery!.bindings).toContain('groq_8b');
  });

  it('inserts with pending executor on first failure', async () => {
    const db = createMockDb({
      firstResults: [null],
      runResults: [{ success: true, meta: {} }],
    });

    await upsertProcedure(db, 'code_task:high', 'claude', '{}', 'failure', 5000, 0.1);

    const insertQuery = db._queries.find(q => q.sql.includes('INSERT'));
    expect(insertQuery!.bindings).toContain('pending');
  });

  it('triggers circuit breaker after consecutive failures', async () => {
    const existing = {
      task_pattern: 'test:mid',
      executor: 'groq_8b',
      executor_config: '{}',
      success_count: 5,
      fail_count: 3,
      avg_latency_ms: 200,
      avg_cost: 0.01,
      status: 'learned',
      consecutive_failures: 1, // one prior failure
      refinements: '[]',
      candidate_executor: null,
      candidate_successes: 0,
    };
    const db = createMockDb({
      firstResults: [existing],
      runResults: [{ success: true, meta: {} }],
    });

    // Second consecutive failure → should trigger circuit breaker (threshold=2)
    await upsertProcedure(db, 'test:mid', 'groq_8b', '{}', 'failure', 500, 0.02);

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE'));
    expect(updateQuery).toBeDefined();
    // Status should be 'degraded' (circuit breaker triggered)
    expect(updateQuery!.bindings).toContain('degraded');
  });

  it('recovers from degraded on success', async () => {
    const existing = {
      task_pattern: 'test:mid',
      executor: 'groq_8b',
      executor_config: '{}',
      success_count: 5,
      fail_count: 5,
      avg_latency_ms: 200,
      avg_cost: 0.01,
      status: 'degraded',
      consecutive_failures: 2,
      refinements: '[]',
      candidate_executor: null,
      candidate_successes: 0,
    };
    const db = createMockDb({
      firstResults: [existing],
      runResults: [{ success: true, meta: {} }],
    });

    await upsertProcedure(db, 'test:mid', 'groq_8b', '{}', 'success', 100, 0.005);

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE'));
    expect(updateQuery!.bindings).toContain('learned');
    // consecutive_failures should reset to 0
    expect(updateQuery!.bindings).toContain(0);
  });

  it('promotes candidate after 3 consecutive successes', async () => {
    const existing = {
      task_pattern: 'question:mid',
      executor: 'groq_8b',
      executor_config: '{}',
      success_count: 8,
      fail_count: 1,
      avg_latency_ms: 200,
      avg_cost: 0.01,
      status: 'learned',
      consecutive_failures: 0,
      refinements: '[]',
      candidate_executor: 'workers_ai',
      candidate_successes: 2, // 2 prior successes, this will be 3rd
    };
    const db = createMockDb({
      firstResults: [existing],
      runResults: [{ success: true, meta: {} }],
    });

    await upsertProcedure(db, 'question:mid', 'workers_ai', '{"model":"llama"}', 'success', 150, 0.005);

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE'));
    // After promotion: executor = 'workers_ai', candidate_executor = null
    expect(updateQuery!.bindings[0]).toBe('workers_ai'); // newExecutor
    expect(updateQuery!.bindings[1]).toBe('{"model":"llama"}'); // newConfig
    expect(updateQuery!.bindings[8]).toBeNull(); // candidateExecutor cleared
    expect(updateQuery!.bindings[9]).toBe(0); // candidateSuccesses reset
  });

  it('discards candidate on failure during probation', async () => {
    const existing = {
      task_pattern: 'question:mid',
      executor: 'groq_8b',
      executor_config: '{}',
      success_count: 8,
      fail_count: 1,
      avg_latency_ms: 200,
      avg_cost: 0.01,
      status: 'learned',
      consecutive_failures: 0,
      refinements: '[]',
      candidate_executor: 'workers_ai',
      candidate_successes: 1,
    };
    const db = createMockDb({
      firstResults: [existing],
      runResults: [{ success: true, meta: {} }],
    });

    await upsertProcedure(db, 'question:mid', 'workers_ai', '{}', 'failure', 500, 0.02);

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE'));
    // Executor should remain groq_8b (trusted), candidate discarded
    expect(updateQuery!.bindings[0]).toBe('groq_8b');
    expect(updateQuery!.bindings[8]).toBeNull(); // candidateExecutor
    expect(updateQuery!.bindings[9]).toBe(0); // candidateSuccesses
  });
});

// ─── addRefinement ──────────────────────────────────────────

describe('addRefinement', () => {
  it('does nothing when procedure not found', async () => {
    const db = createMockDb({ firstResults: [null] });
    await addRefinement(db, 'missing:low', { timestamp: Date.now(), what: 'test', why: 'reason', impact: 'pending' });
    // Only SELECT, no UPDATE
    const updates = db._queries.filter(q => q.sql.includes('UPDATE'));
    expect(updates).toHaveLength(0);
  });

  it('appends refinement and trims to last 10', async () => {
    const existing = {
      task_pattern: 'test:mid',
      refinements: JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
        timestamp: i, what: `ref${i}`, why: 'x', impact: 'pending',
      }))),
    };
    const db = createMockDb({
      firstResults: [existing],
      runResults: [{ success: true, meta: {} }],
    });

    await addRefinement(db, 'test:mid', {
      timestamp: 999, what: 'new', why: 'y', impact: 'positive',
    });

    const updateQuery = db._queries.find(q => q.sql.includes('UPDATE'));
    const saved = JSON.parse(updateQuery!.bindings[0] as string);
    expect(saved).toHaveLength(10);
    expect(saved[9].what).toBe('new');
  });
});

// ─── degradeProcedure ───────────────────────────────────────

describe('degradeProcedure', () => {
  it('does nothing when procedure not found', async () => {
    const db = createMockDb({ firstResults: [null] });
    await degradeProcedure(db, 'missing:low', 'groq_8b');
    // Only one SELECT, no UPDATE
    const updates = db._queries.filter(q => q.sql.includes('UPDATE'));
    expect(updates).toHaveLength(0);
  });

  it('increments failures and triggers degraded on circuit breaker threshold', async () => {
    const existing = {
      task_pattern: 'test:mid',
      executor: 'groq_8b',
      executor_config: '{}',
      success_count: 5,
      fail_count: 3,
      status: 'learned',
      consecutive_failures: 1,
      refinements: '[]',
    };
    const db = createMockDb({
      firstResults: [
        existing, // for degradeProcedure
        existing, // for addRefinement's getProcedure
      ],
      runResults: [
        { success: true, meta: {} }, // UPDATE for degrade
        { success: true, meta: {} }, // UPDATE for refinement
      ],
    });

    await degradeProcedure(db, 'test:mid', 'groq_8b');

    // First UPDATE should set status to 'degraded' (consec_failures hits 2)
    const updateQueries = db._queries.filter(q => q.sql.includes('UPDATE'));
    expect(updateQueries.length).toBeGreaterThanOrEqual(1);
    expect(updateQueries[0].bindings).toContain('degraded');
  });
});

// ─── maintainProcedures ─────────────────────────────────────

describe('maintainProcedures', () => {
  it('resets stale learned procedures to learning', async () => {
    const db = createMockDb({
      allResults: [
        { results: [{ task_pattern: 'old:low' }] }, // stale procedures
        { results: [] }, // no low-utility procs
      ],
      runResults: [{ success: true, meta: {} }],
    });

    await maintainProcedures(db);

    const updateQuery = db._queries.find(q => q.sql.includes("status = 'learning'"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.bindings).toContain('old:low');
  });

  it('degrades low-utility procedures', async () => {
    const db = createMockDb({
      allResults: [
        { results: [] }, // no stale procedures
        { results: [{ task_pattern: 'bad:mid', success_count: 2, fail_count: 5 }] }, // low utility
      ],
      runResults: [{ success: true, meta: {} }],
    });

    await maintainProcedures(db);

    const degradeQuery = db._queries.find(q => q.sql.includes("status = 'degraded'"));
    expect(degradeQuery).toBeDefined();
  });
});

// ─── Constants ──────────────────────────────────────────────

describe('exported constants', () => {
  it('has correct threshold values', () => {
    expect(PROCEDURE_MIN_SUCCESSES).toBe(3);
    expect(PROCEDURE_MIN_SUCCESS_RATE).toBe(0.7);
  });
});
