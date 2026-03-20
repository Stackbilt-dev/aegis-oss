// HTTP route tests for web/src/routes/sessions.ts
// Tests session creation, validation, listing with day filter.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sessions } from '../src/routes/sessions.js';
import type { Env } from '../src/types.js';

// ─── D1 Mock ──────────────────────────────────────────────────

function createMockDb(options: {
  allResults?: Record<string, unknown>[][];
} = {}) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
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
          return null;
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
  app.route('/', sessions);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('sessions routes', () => {
  describe('POST /api/cc-session', () => {
    it('creates a session and returns 201', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'Deployed v1.30' }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.id).toBeDefined();
      expect(json.session_date).toBeDefined();
      expect(json.status).toBe('recorded');
    });

    it('returns 400 when summary is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('summary');
    });

    it('returns 400 when summary is whitespace-only', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: '   ' }),
      });

      expect(res.status).toBe(400);
    });

    it('persists optional fields to DB', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/cc-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: 'Session with extras',
          commits: [{ hash: 'abc123', message: 'fix bug' }],
          files_changed: ['src/index.ts'],
          decisions: ['Use vitest'],
          repos: ['aegis-daemon'],
          duration_minutes: 30,
        }),
      });

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO cc_sessions'));
      expect(insertQuery).toBeDefined();
      // Verify JSON-serialized fields are in bindings
      expect(insertQuery!.bindings).toContain(JSON.stringify([{ hash: 'abc123', message: 'fix bug' }]));
      expect(insertQuery!.bindings).toContain(JSON.stringify(['src/index.ts']));
      expect(insertQuery!.bindings).toContain(30);
    });

    it('sets null for missing optional fields', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/cc-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: 'Minimal session' }),
      });

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO cc_sessions'));
      // commits, files_changed, issues_opened, issues_closed, decisions, repos should be null
      // duration_minutes should be null
      const nullCount = insertQuery!.bindings.filter(b => b === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(6);
    });
  });

  describe('GET /api/cc-sessions', () => {
    it('lists sessions with default 7-day window', async () => {
      const sessionData = [{ id: 's1', summary: 'Session 1' }];
      const db = createMockDb({ allResults: [sessionData] });
      const app = createApp(db);

      const res = await app.request('/api/cc-sessions');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.sessions).toEqual(sessionData);
      expect(db._queries[0].bindings[0]).toBe(7);
    });

    it('respects days query param', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/cc-sessions?days=30');
      expect(db._queries[0].bindings[0]).toBe(30);
    });
  });
});
