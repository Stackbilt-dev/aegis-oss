// HTTP route tests for web/src/routes/cc-tasks.ts
// Tests CRUD operations, validation, status codes, and cascade logic.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { ccTasks } from '../src/routes/cc-tasks.js';
import type { Env } from '../src/types.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery {
  sql: string;
  bindings: unknown[];
}

function createMockDb(options: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
  runMeta?: { changes: number }[];
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
          const meta = options.runMeta?.[runIdx++] ?? { changes: 1 };
          return { meta };
        },
      };
    },
    _queries: queries,
  };
}

// ─── App Factory ──────────────────────────────────────────────

function createApp(db: ReturnType<typeof createMockDb>) {
  const app = new Hono<{ Bindings: Env }>();
  // Inject mock env
  app.use('*', async (c, next) => {
    (c.env as any) = { DB: db, AEGIS_TOKEN: 'test-token' };
    await next();
  });
  app.route('/', ccTasks);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('cc-tasks routes', () => {
  describe('GET /api/cc-tasks/next', () => {
    it('returns task when one is pending', async () => {
      const task = { id: 'abc', title: 'Do thing', status: 'pending' };
      const db = createMockDb({ firstResults: [task] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/next');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual(task);
    });

    it('returns queue-empty message when no tasks', async () => {
      const db = createMockDb({ firstResults: [null] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/next');
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ id: null, message: 'Queue empty' });
    });
  });

  describe('GET /api/cc-tasks', () => {
    it('lists tasks with default limit', async () => {
      const tasks = [{ id: '1', title: 'A' }, { id: '2', title: 'B' }];
      const db = createMockDb({ allResults: [tasks] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.count).toBe(2);
      expect(json.tasks).toEqual(tasks);
    });

    it('filters by status query param', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/cc-tasks?status=running');
      expect(db._queries[0].sql).toContain('WHERE status = ?');
      expect(db._queries[0].bindings[0]).toBe('running');
    });

    it('caps limit at 100', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/cc-tasks?limit=500');
      // Last binding should be the limit, capped at 100
      const bindings = db._queries[0].bindings;
      expect(bindings[bindings.length - 1]).toBe(100);
    });
  });

  describe('POST /api/cc-tasks', () => {
    it('creates a task and returns 201', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test', repo: 'aegis', prompt: 'Do stuff' }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.id).toBeDefined();
      expect(json.status).toBe('pending');
      expect(json.authority).toBe('operator');
      expect(json.category).toBe('feature');
    });

    it('returns 400 when title is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'aegis', prompt: 'Do stuff' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('required');
    });

    it('returns 400 when repo is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test', prompt: 'Do stuff' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when prompt is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test', repo: 'aegis' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty-string fields', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '  ', repo: 'aegis', prompt: 'Do stuff' }),
      });

      expect(res.status).toBe(400);
    });

    it('accepts valid authority and category', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test', repo: 'aegis', prompt: 'Do',
          authority: 'proposed', category: 'docs',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.authority).toBe('proposed');
      expect(json.category).toBe('docs');
    });

    it('defaults invalid authority to operator', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test', repo: 'aegis', prompt: 'Do',
          authority: 'admin',
        }),
      });

      const json = await res.json() as any;
      expect(json.authority).toBe('operator');
    });

    it('defaults invalid category to feature', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test', repo: 'aegis', prompt: 'Do',
          category: 'yolo',
        }),
      });

      const json = await res.json() as any;
      expect(json.category).toBe('feature');
    });
  });

  describe('POST /api/cc-tasks/:id/start', () => {
    it('marks task as running', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess-1' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.id).toBe('task-1');
      expect(json.status).toBe('running');
    });

    it('stores preflight context when provided', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'sess-1',
          preflight: {
            repo: 'aegis',
            repo_exists: true,
            warnings: ['No obvious test command detected in root/web/e2e package.json'],
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(db._queries[0].sql).toContain('preflight_json = COALESCE(?, preflight_json)');
      expect(db._queries[0].bindings[0]).toBe('sess-1');
      expect(JSON.parse(String(db._queries[0].bindings[1]))).toMatchObject({
        repo: 'aegis',
        repo_exists: true,
      });
    });

    it('handles missing body gracefully', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/cc-tasks/:id/complete', () => {
    it('marks task as completed', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', result: 'done' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('completed');
    });

    it('marks task as failed and cascades cancellation', async () => {
      // run() calls: 1) update task status, 2) cascade cancel dependents, 3+) recursive cascade per dep
      // all() call: SELECT cancelled deps for recursive cascade
      const db = createMockDb({
        runMeta: [
          { changes: 1 },  // update task to failed
          { changes: 2 },  // cascade cancel 2 dependents
          { changes: 0 },  // recursive cascade for dep-1
          { changes: 0 },  // recursive cascade for dep-2
        ],
        allResults: [[{ id: 'dep-1' }, { id: 'dep-2' }]],
      });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'failed', error: 'boom' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('failed');

      // Verify cascade SQL was issued
      const cascadeQueries = db._queries.filter(q =>
        q.bindings.some(b => typeof b === 'string' && b.includes('Dependency'))
      );
      expect(cascadeQueries.length).toBeGreaterThan(0);
    });

    it('classifies failed tasks and persists autopsy metadata', async () => {
      const db = createMockDb({
        runMeta: [
          { changes: 1 },
          { changes: 0 },
        ],
      });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          error: 'Repo not found: user-website.example',
          exit_code: 1,
          task_title: 'Scaffold deploy pipeline',
          repo: 'user-website.example',
          category: 'tests',
          preflight: {
            repo: 'user-website.example',
            repo_exists: false,
            warnings: ['Resolved repo path does not exist on this runner'],
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('failed');
      expect(json.failure_kind).toBe('repo_missing');
      expect(json.retryable).toBe(false);

      expect(db._queries[0].sql).toContain('failure_kind = ?');
      expect(db._queries[0].bindings[7]).toBe('repo_missing');
      expect(db._queries[0].bindings[8]).toBe(0);

      const autopsy = JSON.parse(String(db._queries[0].bindings[9]));
      expect(autopsy.kind).toBe('repo_missing');
      expect(autopsy.system_contract).toBe('repo_target_missing');
    });

    it('normalizes unknown status to failed', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'unknown' }),
      });

      const json = await res.json() as any;
      expect(json.status).toBe('failed');
    });
  });

  describe('POST /api/cc-tasks/:id/cancel', () => {
    it('cancels a pending task', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('cancelled');
    });
  });

  describe('POST /api/cc-tasks/:id/approve', () => {
    it('approves a proposed task', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.authority).toBe('operator');
    });

    it('returns 404 when task not found or not proposed', async () => {
      const db = createMockDb({ runMeta: [{ changes: 0 }] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(404);
      const json = await res.json() as any;
      expect(json.error).toContain('not found');
    });
  });

  describe('POST /api/cc-tasks/:id/reject', () => {
    it('rejects a proposed task', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('cancelled');
    });

    it('returns 404 when task not proposed or not pending', async () => {
      const db = createMockDb({ runMeta: [{ changes: 0 }] });
      const app = createApp(db);

      const res = await app.request('/api/cc-tasks/task-1/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(404);
    });
  });
});
