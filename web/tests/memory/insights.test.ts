// Insight tests — publishInsight gates, validateInsight transitions,
// promoteInsight, listInsights, getInsightDetail, getInsightStats, archiveInsight

import { describe, it, expect } from 'vitest';
import {
  publishInsight,
  validateInsight,
  promoteInsight,
  listInsights,
  getInsightDetail,
  getInsightStats,
  archiveInsight,
  type InsightPayload,
} from '../../src/kernel/memory/insights.js';

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
          return opts.runResults?.[runIdx++] ?? { success: true, meta: { changes: 1 } };
        },
      };
    },
    _queries: queries,
  } as unknown as D1Database & { _queries: MockQuery[] };
}

function baseInsight(overrides?: Partial<InsightPayload>): InsightPayload {
  return {
    fact: 'Service bindings always perform better than fetch calls for same-account Workers',
    insight_type: 'pattern',
    origin_repo: 'aegis',
    keywords: ['service', 'binding', 'workers', 'performance'],
    confidence: 0.85,
    ...overrides,
  };
}

// ─── publishInsight ─────────────────────────────────────────

describe('publishInsight', () => {
  it('rejects confidence below 0.75', async () => {
    const db = createMockDb();
    const result = await publishInsight(db, baseInsight({ confidence: 0.5 }));
    expect(result.published).toBe(false);
    expect(result.reason).toContain('confidence');
  });

  it('rejects duplicate insights (hash match)', async () => {
    const db = createMockDb({
      firstResults: [{ id: 42 }], // existing hash match
    });
    const result = await publishInsight(db, baseInsight());
    expect(result.published).toBe(false);
    expect(result.reason).toContain('duplicate');
  });

  it('rejects context-specific insights (hardcoded paths)', async () => {
    const db = createMockDb({
      firstResults: [null], // no hash match
    });
    const result = await publishInsight(db, baseInsight({
      fact: 'The file at /home/user/test.ts has a bug pattern',
    }));
    expect(result.published).toBe(false);
    expect(result.reason).toContain('context-specific');
  });

  it('rejects context-specific insights (env vars)', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await publishInsight(db, baseInsight({
      fact: 'Set $CLOUDFLARE_API_TOKEN before running wrangler deploy',
    }));
    expect(result.published).toBe(false);
    expect(result.reason).toContain('context-specific');
  });

  it('rejects context-specific insights (process.env)', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await publishInsight(db, baseInsight({
      fact: 'process.env.NODE_ENV is required for the build',
    }));
    expect(result.published).toBe(false);
    expect(result.reason).toContain('context-specific');
  });

  it('rejects single-file reference without general pattern language', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await publishInsight(db, baseInsight({
      fact: 'Bug found in dispatch.ts: line 42 has an off-by-one error',
    }));
    expect(result.published).toBe(false);
    expect(result.reason).toContain('context-specific');
  });

  it('allows file reference WITH general pattern language', async () => {
    const db = createMockDb({
      firstResults: [null], // no hash match
      allResults: [{ results: [] }], // no topic entries for recordMemory
      runResults: [{ success: true, meta: {} }], // INSERT
    });
    const result = await publishInsight(db, baseInsight({
      fact: 'When using dispatch.ts: always validate JSON before parsing to prevent runtime crashes',
    }));
    expect(result.published).toBe(true);
  });

  it('publishes valid insight via D1 fallback (no memoryBinding)', async () => {
    const db = createMockDb({
      firstResults: [null], // no hash match gate
      allResults: [{ results: [] }], // no topic entries for recordMemory phase 2
      runResults: [{ success: true, meta: {} }], // INSERT from recordMemory phase 3
    });

    const result = await publishInsight(db, baseInsight());
    expect(result.published).toBe(true);
  });

  it('publishes via Memory Worker when binding provided', async () => {
    const storeCalls: unknown[] = [];
    const memBinding = {
      store: async (_tenant: string, frags: unknown[]) => {
        storeCalls.push(frags);
        return { stored: 1, merged: 0, duplicates: 0, fragment_ids: ['frag-1'] };
      },
    };

    const db = createMockDb({
      firstResults: [null], // no hash match
      runResults: [{ success: true, meta: {} }], // anchor INSERT
    });

    const result = await publishInsight(db, baseInsight(), memBinding as any);
    expect(result.published).toBe(true);
    expect(storeCalls).toHaveLength(1);
  });
});

// ─── validateInsight ────────────────────────────────────────

describe('validateInsight', () => {
  it('returns candidate/not-transitioned for missing entry', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    expect(result.stage).toBe('candidate');
    expect(result.transitioned).toBe(false);
  });

  it('does not transition terminal stages (canonical)', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'canonical', validators: '[]', fact: 'test' }],
    });
    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    expect(result.stage).toBe('canonical');
    expect(result.transitioned).toBe(false);
  });

  it('does not transition terminal stages (refuted)', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'refuted', validators: '[]', fact: 'test' }],
    });
    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    expect(result.stage).toBe('refuted');
    expect(result.transitioned).toBe(false);
  });

  it('refutes immediately on confirmed=false', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'candidate', validators: '[]', fact: 'test' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await validateInsight(db, 'abc123', 'img-forge', false);
    expect(result.stage).toBe('refuted');
    expect(result.transitioned).toBe(true);
  });

  it('promotes candidate→validated on first confirmation', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'candidate', validators: '[]', fact: 'test' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    expect(result.stage).toBe('validated');
    expect(result.transitioned).toBe(true);
  });

  it('promotes validated→expert on 2+ confirmations', async () => {
    const existingValidators = JSON.stringify([
      { repo: 'aegis', confirmed: true, date: '2026-01-01' },
    ]);
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'validated', validators: existingValidators, fact: 'test' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    expect(result.stage).toBe('expert');
    expect(result.transitioned).toBe(true);
  });

  it('stays validated with only 1 total confirmation', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'validated', validators: '[]', fact: 'test' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    // Only 1 confirmed → not enough for expert (needs 2)
    expect(result.stage).toBe('validated');
    expect(result.transitioned).toBe(false);
  });

  it('handles malformed validators JSON gracefully', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'candidate', validators: 'not-json', fact: 'test' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await validateInsight(db, 'abc123', 'img-forge', true);
    expect(result.stage).toBe('validated');
    expect(result.transitioned).toBe(true);
  });
});

// ─── promoteInsight ─────────────────────────────────────────

describe('promoteInsight', () => {
  it('fails for missing insight', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await promoteInsight(db, 'abc123', 'expert');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('allows validated→expert promotion', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'validated' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await promoteInsight(db, 'abc123', 'expert');
    expect(result.success).toBe(true);
  });

  it('allows expert→canonical promotion', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'expert' }],
      runResults: [{ success: true, meta: {} }],
    });

    const result = await promoteInsight(db, 'abc123', 'canonical');
    expect(result.success).toBe(true);
  });

  it('rejects canonical from non-expert stage', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'validated' }],
    });

    const result = await promoteInsight(db, 'abc123', 'canonical');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('expert');
  });

  it('rejects backward transitions', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1, validation_stage: 'canonical' }],
    });

    const result = await promoteInsight(db, 'abc123', 'expert');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('forward');
  });
});

// ─── listInsights ───────────────────────────────────────────

describe('listInsights', () => {
  it('returns parsed insight rows', async () => {
    const db = createMockDb({
      allResults: [{
        results: [{
          id: 1, fact: 'test insight', fact_hash: 'abc', validation_stage: 'candidate',
          confidence: 0.85, validators: null, created_at: '2026-03-01',
        }],
      }],
    });

    const results = await listInsights(db);
    expect(results).toHaveLength(1);
    expect(results[0].insight_type).toBeNull(); // D1 path
    expect(results[0].origin_repo).toBeNull();
    expect(results[0].validators).toEqual([]);
  });

  it('filters by validation stage', async () => {
    const db = createMockDb({
      allResults: [{ results: [] }],
    });

    await listInsights(db, { stage: 'validated' });
    expect(db._queries[0].sql).toContain('validation_stage = ?');
    expect(db._queries[0].bindings).toContain('validated');
  });

  it('returns empty array on error', async () => {
    const db = {
      prepare() {
        throw new Error('DB error');
      },
    } as unknown as D1Database;

    const results = await listInsights(db);
    expect(results).toEqual([]);
  });
});

// ─── getInsightDetail ───────────────────────────────────────

describe('getInsightDetail', () => {
  it('returns null for missing insight', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await getInsightDetail(db, 'missing');
    expect(result).toBeNull();
  });

  it('returns parsed detail', async () => {
    const validators = JSON.stringify([{ repo: 'aegis', confirmed: true, date: '2026-03-01' }]);
    const db = createMockDb({
      firstResults: [{
        id: 1, fact: 'test', fact_hash: 'abc', validation_stage: 'validated',
        confidence: 0.9, validators, created_at: '2026-03-01',
      }],
    });

    const result = await getInsightDetail(db, 'abc');
    expect(result).not.toBeNull();
    expect(result!.validation_stage).toBe('validated');
    expect(result!.validators).toHaveLength(1);
    expect(result!.validators[0].repo).toBe('aegis');
  });
});

// ─── getInsightStats ────────────────────────────────────────

describe('getInsightStats', () => {
  it('returns stats with stage breakdown', async () => {
    const db = createMockDb({
      firstResults: [
        { cnt: 10 },  // total
        { cnt: 3 },   // new_since_last_week
      ],
      allResults: [{
        results: [
          { validation_stage: 'candidate', cnt: 5 },
          { validation_stage: 'validated', cnt: 3 },
          { validation_stage: 'expert', cnt: 2 },
        ],
      }],
    });

    const stats = await getInsightStats(db);
    expect(stats.total).toBe(10);
    expect(stats.by_stage.candidate).toBe(5);
    expect(stats.by_stage.validated).toBe(3);
    expect(stats.pending_review).toBe(3); // validated count
    expect(stats.new_since_last_week).toBe(3);
  });

  it('returns empty stats on error', async () => {
    const db = {
      prepare() { throw new Error('fail'); },
    } as unknown as D1Database;

    const stats = await getInsightStats(db);
    expect(stats.total).toBe(0);
    expect(stats.by_stage).toEqual({});
  });
});

// ─── archiveInsight ─────────────────────────────────────────

describe('archiveInsight', () => {
  it('archives by fact_hash', async () => {
    const db = createMockDb({
      runResults: [{ success: true, meta: { changes: 1 } }],
    });

    const result = await archiveInsight(db, 'abc123', 'outdated');
    expect(result.success).toBe(true);
  });

  it('returns false when no rows changed', async () => {
    const db = createMockDb({
      runResults: [{ success: true, meta: { changes: 0 } }],
    });

    const result = await archiveInsight(db, 'missing', 'test');
    expect(result.success).toBe(false);
  });

  it('returns false on error', async () => {
    const db = {
      prepare() { throw new Error('fail'); },
    } as unknown as D1Database;

    const result = await archiveInsight(db, 'abc', 'test');
    expect(result.success).toBe(false);
  });
});
