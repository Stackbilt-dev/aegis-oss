// HTTP route tests for web/src/routes/observability.ts
// Tests shadow stats, shadow read stats, agenda, and procedures endpoints.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/kernel/memory/index.js', () => ({
  getAllProceduresWithDerivedStats: vi.fn().mockResolvedValue([]),
  getActiveAgendaItems: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/kernel/scheduled/entropy.js', () => ({
  detectEntropy: vi.fn().mockResolvedValue({
    score: 0,
    ghostAgendaItems: [],
    ghostTasks: [],
    dormantGoals: [],
    summary: 'Entropy 0% - all clear.',
  }),
}));

import { observability } from '../src/routes/observability.js';
import { getAllProceduresWithDerivedStats, getActiveAgendaItems } from '../src/kernel/memory/index.js';
import { detectEntropy } from '../src/kernel/scheduled/entropy.js';
import type { Env } from '../src/types.js';

// ─── D1 Mock ──────────────────────────────────────────────────

function createMockDb(options: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
} = {}) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  let firstIdx = 0;
  let allIdx = 0;

  return {
    prepare(sql: string) {
      const entry = { sql, bindings: [] as unknown[] };
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
          return { meta: { changes: 1 } };
        },
      };
    },
    _queries: queries,
  };
}

// ─── App Factory ──────────────────────────────────────────────

function createApp(db: ReturnType<typeof createMockDb>) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c.env as any) = { DB: db, AEGIS_TOKEN: 'test-token' };
    await next();
  });
  app.route('/', observability);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('observability routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/shadow-stats', () => {
    it('returns shadow write stats with defaults', async () => {
      const summary = { total_writes: 100, worker_ok: 95, d1_ok: 98 };
      const errors = [{ error_source: 'worker', count: 5 }];
      const recent = [{ topic: 'memory', worker_ok: 1, d1_ok: 1 }];
      const db = createMockDb({
        firstResults: [summary],
        allResults: [errors, recent],
      });
      const app = createApp(db);

      const res = await app.request('/api/shadow-stats');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.days).toBe(7);
      expect(json.summary).toEqual(summary);
      expect(json.errors).toEqual(errors);
      expect(json.recent).toEqual(recent);
    });

    it('respects days query param', async () => {
      const db = createMockDb({
        firstResults: [null],
        allResults: [[], []],
      });
      const app = createApp(db);

      await app.request('/api/shadow-stats?days=30');
      // All queries should bind days=30
      const daysBindings = db._queries.filter(q => q.bindings.includes(30));
      expect(daysBindings.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/shadow-read-stats', () => {
    it('returns shadow read stats', async () => {
      const summary = { total_reads: 50, avg_overlap_ratio: 0.95 };
      const bySite = [{ call_site: 'dispatch', reads: 30 }];
      const recent = [{ call_site: 'dispatch', query_text: 'test' }];
      const db = createMockDb({
        firstResults: [summary],
        allResults: [bySite, recent],
      });
      const app = createApp(db);

      const res = await app.request('/api/shadow-read-stats');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.days).toBe(7);
      expect(json.summary).toEqual(summary);
      expect(json.by_site).toEqual(bySite);
      expect(json.recent).toEqual(recent);
    });

    it('respects days query param', async () => {
      const db = createMockDb({
        firstResults: [null],
        allResults: [[], []],
      });
      const app = createApp(db);

      await app.request('/api/shadow-read-stats?days=14');
      const daysBindings = db._queries.filter(q => q.bindings.includes(14));
      expect(daysBindings.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/entropy', () => {
    it('returns entropy report from detector', async () => {
      const report = {
        score: 25,
        ghostAgendaItems: [{ id: 1, item: 'Stale item', daysSinceCreated: 9 }],
        ghostTasks: [],
        dormantGoals: [],
        summary: 'Entropy 25% - 1 agenda item stale >7d.',
      };
      vi.mocked(detectEntropy).mockResolvedValueOnce(report as any);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/entropy');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(report);
      expect(detectEntropy).toHaveBeenCalledWith(expect.objectContaining({ db }));
    });
  });

  describe('GET /api/shadow-read-drift', () => {
    it('returns drift distribution, readiness, and top drifters', async () => {
      const distribution = [{
        reader: 'observability',
        samples: 4,
        p95_count_drift: 1,
        p95_latency_drift_ms: 5,
        p95_cost_drift: 0.00001,
      }];
      const readiness = {
        total_pairs: 2,
        distinct_procedures: 2,
        clean_pairs: 2,
        ready_pairs: 1,
      };
      const topDrifters = [{
        task_pattern: 'dispatch:mid',
        reader: 'observability',
        count_drift: 1,
        latency_drift: 5,
        cost_drift: 0.00001,
        sampled_at: '2026-04-24 00:00:00',
      }];
      const db = createMockDb({
        firstResults: [readiness],
        allResults: [distribution, topDrifters],
      });
      const app = createApp(db);

      const res = await app.request('/api/shadow-read-drift?days=14&reader=observability');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json).toEqual({
        days: 14,
        reader_filter: 'observability',
        distribution,
        readiness,
        top_drifters: topDrifters,
      });
      expect(db._queries[0].bindings).toEqual([14, 'observability']);
      expect(db._queries[1].bindings).toEqual(['observability', 14]);
      expect(db._queries[2].bindings).toEqual([14, 'observability']);
    });

    it('defaults invalid days and omits reader filter', async () => {
      const db = createMockDb({
        firstResults: [{ total_pairs: 0, distinct_procedures: 0, clean_pairs: 0, ready_pairs: 0 }],
        allResults: [[], []],
      });
      const app = createApp(db);

      const res = await app.request('/api/shadow-read-drift?days=999');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.days).toBe(7);
      expect(json.reader_filter).toBeNull();
      expect(db._queries[0].bindings).toEqual([7]);
      expect(db._queries[1].bindings).toEqual([7]);
      expect(db._queries[2].bindings).toEqual([7]);
    });
  });

  describe('GET /agenda', () => {
    it('returns active agenda items', async () => {
      const items = [
        { id: 'a1', description: 'Fix bug', status: 'active' },
        { id: 'a2', description: 'Write tests', status: 'active' },
      ];
      vi.mocked(getActiveAgendaItems).mockResolvedValueOnce(items as any);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/agenda');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.count).toBe(2);
      expect(json.items).toEqual(items);
    });

    it('returns empty when no agenda items', async () => {
      vi.mocked(getActiveAgendaItems).mockResolvedValueOnce([]);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/agenda');
      const json = await res.json() as any;
      expect(json.count).toBe(0);
      expect(json.items).toEqual([]);
    });
  });

  describe('GET /procedures', () => {
    it('returns formatted procedures', async () => {
      vi.mocked(getAllProceduresWithDerivedStats).mockResolvedValueOnce([
        {
          task_pattern: 'greeting',
          executor: 'groq_8b',
          status: 'learned',
          success_count: 10,
          fail_count: 1,
          consecutive_failures: 0,
          avg_latency_ms: 123.456,
          avg_cost: 0.00123456,
          last_used: '2026-03-10',
        },
      ] as any);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/procedures');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.count).toBe(1);
      expect(json.procedures[0].pattern).toBe('greeting');
      expect(json.procedures[0].executor).toBe('groq_8b');
      expect(json.procedures[0].status).toBe('learned');
      expect(json.procedures[0].successes).toBe(10);
      expect(json.procedures[0].failures).toBe(1);
      expect(json.procedures[0].consecutiveFailures).toBe(0);
      expect(json.procedures[0].successRate).toBe(0.91);
      expect(json.procedures[0].avgLatencyMs).toBe(123);
      expect(json.procedures[0].avgCost).toBe(0.0012);
    });

    it('handles zero total executions', async () => {
      vi.mocked(getAllProceduresWithDerivedStats).mockResolvedValueOnce([
        {
          task_pattern: 'unknown',
          executor: 'claude',
          status: 'learning',
          success_count: 0,
          fail_count: 0,
          consecutive_failures: 0,
          avg_latency_ms: 0,
          avg_cost: 0,
          last_used: null,
        },
      ] as any);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/procedures');
      const json = await res.json() as any;
      expect(json.procedures[0].successRate).toBe(0);
    });
  });
});
