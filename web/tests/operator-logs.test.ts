// HTTP route tests for web/src/routes/operator-logs.ts
// Tests paginated list, single log retrieval, 404 handling.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { operatorLogs } from '../src/routes/operator-logs.js';
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
  app.route('/', operatorLogs);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('operator-logs routes', () => {
  describe('GET /api/operator-logs', () => {
    it('returns paginated logs with total count', async () => {
      const logs = [
        { id: 1, content: 'Log 1', episodes_count: 3, created_at: '2026-03-10' },
      ];
      const db = createMockDb({
        allResults: [logs],
        firstResults: [{ cnt: 42 }],
      });
      const app = createApp(db);

      const res = await app.request('/api/operator-logs');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.logs).toEqual(logs);
      expect(json.total).toBe(42);
    });

    it('uses default limit=20 and offset=0', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [{ cnt: 0 }],
      });
      const app = createApp(db);

      await app.request('/api/operator-logs');
      const selectQuery = db._queries.find(q => q.sql.includes('SELECT id'));
      expect(selectQuery!.bindings[0]).toBe(20); // limit
      expect(selectQuery!.bindings[1]).toBe(0);  // offset
    });

    it('respects limit and offset query params', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [{ cnt: 0 }],
      });
      const app = createApp(db);

      await app.request('/api/operator-logs?limit=10&offset=20');
      const selectQuery = db._queries.find(q => q.sql.includes('SELECT id'));
      expect(selectQuery!.bindings[0]).toBe(10);
      expect(selectQuery!.bindings[1]).toBe(20);
    });

    it('caps limit at 100', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [{ cnt: 0 }],
      });
      const app = createApp(db);

      await app.request('/api/operator-logs?limit=500');
      const selectQuery = db._queries.find(q => q.sql.includes('SELECT id'));
      expect(selectQuery!.bindings[0]).toBe(100);
    });

    it('returns total 0 when count returns null', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [null],
      });
      const app = createApp(db);

      const res = await app.request('/api/operator-logs');
      const json = await res.json() as any;
      expect(json.total).toBe(0);
    });
  });

  describe('GET /api/operator-logs/:id', () => {
    it('returns a single log by id', async () => {
      const log = { id: 5, content: 'Log 5', episodes_count: 2 };
      const db = createMockDb({ firstResults: [log] });
      const app = createApp(db);

      const res = await app.request('/api/operator-logs/5');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.id).toBe(5);
    });

    it('returns 404 when log not found', async () => {
      const db = createMockDb({ firstResults: [null] });
      const app = createApp(db);

      const res = await app.request('/api/operator-logs/999');
      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.error).toContain('Not found');
    });

    it('binds integer id to query', async () => {
      const db = createMockDb({ firstResults: [null] });
      const app = createApp(db);

      await app.request('/api/operator-logs/42');
      expect(db._queries[0].bindings[0]).toBe(42);
    });
  });
});
