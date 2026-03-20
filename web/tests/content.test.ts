// HTTP route tests for web/src/routes/content.ts
// Tests tech post CRUD (via ROUNDTABLE_DB), content generation triggers, auth, and validation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock heavy dependencies before importing routes
vi.mock('../src/sanitize.js', () => ({
  sanitizeForBlog: vi.fn((s: string) => s),
}));

vi.mock('../src/content/index.js', () => ({
  runRoundtableGeneration: vi.fn().mockResolvedValue({ ok: true }),
  runJournalGeneration: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../src/kernel/scheduled/dreaming.js', () => ({
  runDreamingCycle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    integrations: { imgForge: { enabled: false, baseUrl: '' } },
  },
}));

vi.mock('../src/edge-env.js', () => ({
  buildEdgeEnv: vi.fn((env: any) => ({
    db: env.DB,
    roundtableDb: env.ROUNDTABLE_DB,
    anthropicApiKey: 'test-key',
    claudeModel: 'test-model',
    anthropicBaseUrl: undefined,
    imgForgeFetcher: null,
    imgForgeSbSecret: null,
    memoryBinding: null,
  })),
}));

import { content } from '../src/routes/content.js';
import { runRoundtableGeneration, runJournalGeneration } from '../src/content/index.js';
import { runDreamingCycle } from '../src/kernel/scheduled/dreaming.js';
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

function createApp(db: ReturnType<typeof createMockDb>, overrides: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', content);

  const originalFetch = app.fetch.bind(app);
  app.fetch = (req: Request, ...rest: any[]) => {
    const env = {
      DB: db,
      AEGIS_TOKEN: 'test-token',
      ROUNDTABLE_DB: overrides.ROUNDTABLE_DB ?? null,
      ...overrides,
    };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    return originalFetch(req, env, ctx);
  };
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('content routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Tech Post CRUD (ROUNDTABLE_DB) ─────────────────────────

  describe('POST /api/tech-posts', () => {
    it('creates a tech post and returns 201', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Post', slug: 'my-post', body: 'Content here' }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.id).toBeDefined();
      expect(json.slug).toBe('my-post');
      expect(json.status).toBe('draft');
      expect(json.url).toBeNull();
      expect(json.note).toContain('No public route exists');
    });

    it('returns 500 when ROUNDTABLE_DB is not bound', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Post', slug: 'my-post', body: 'Content' }),
      });

      expect(res.status).toBe(500);
    });

    it('returns 400 when title is missing', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'my-post', body: 'Content' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('required');
    });

    it('returns 400 when slug is missing', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Post', body: 'Content' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when body is missing', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'My Post', slug: 'my-post' }),
      });

      expect(res.status).toBe(400);
    });

    it('sets published_at when status is published', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'My Post', slug: 'my-post', body: 'Content',
          status: 'published',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json() as any;
      expect(json.status).toBe('published');
      expect(json.url).toBe('https://your-blog.example.com/post/my-post');

      const insertQuery = roundtableDb._queries.find(q => q.sql.includes('INSERT INTO posts'));
      expect(insertQuery).toBeDefined();
      const publishedAt = insertQuery!.bindings[insertQuery!.bindings.length - 1];
      expect(publishedAt).not.toBeNull();
    });

    it('sets published_at to null for draft status', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      await app.request('/api/tech-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'My Post', slug: 'my-post', body: 'Content',
          status: 'draft',
        }),
      });

      const insertQuery = roundtableDb._queries.find(q => q.sql.includes('INSERT INTO posts'));
      const publishedAt = insertQuery!.bindings[insertQuery!.bindings.length - 1];
      expect(publishedAt).toBeNull();
    });
  });

  describe('PUT /api/tech-posts/:id', () => {
    it('updates an existing post', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({
        firstResults: [{
          id: 'post-1', title: 'Old', body: 'Old body',
          description: '', tags: '[]', status: 'draft',
          canonical_url: null, published_at: null,
        }],
      });
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts/post-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Title' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
    });

    it('returns 404 for non-existent post', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({ firstResults: [null] });
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts/fake-id', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New' }),
      });

      expect(res.status).toBe(404);
    });

    it('sets published_at when publishing a draft', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({
        firstResults: [{
          id: 'post-1', title: 'Draft', body: 'Body',
          description: '', tags: '[]', status: 'draft',
          canonical_url: null, published_at: null,
        }],
      });
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      await app.request('/api/tech-posts/post-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      });

      const updateQuery = roundtableDb._queries.find(q => q.sql.includes('UPDATE posts'));
      expect(updateQuery).toBeDefined();
      const publishedAt = updateQuery!.bindings[updateQuery!.bindings.length - 2];
      expect(publishedAt).not.toBeNull();
    });

    it('preserves published_at when updating already-published post', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({
        firstResults: [{
          id: 'post-1', title: 'Published', body: 'Body',
          description: '', tags: '[]', status: 'published',
          canonical_url: null, published_at: '2026-01-01T00:00:00.000Z',
        }],
      });
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      await app.request('/api/tech-posts/post-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated Title', status: 'published' }),
      });

      const updateQuery = roundtableDb._queries.find(q => q.sql.includes('UPDATE posts'));
      const publishedAt = updateQuery!.bindings[updateQuery!.bindings.length - 2];
      expect(publishedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('GET /api/tech-posts', () => {
    it('lists all posts', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({ allResults: [[{ id: '1', title: 'Post 1' }, { id: '2', title: 'Post 2' }]] });
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const res = await app.request('/api/tech-posts');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.posts).toEqual([{ id: '1', title: 'Post 1' }, { id: '2', title: 'Post 2' }]);
    });

    it('filters by status query param', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({ allResults: [[]] });
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      await app.request('/api/tech-posts?status=published');
      expect(roundtableDb._queries[0].sql).toContain('WHERE status = ?');
      expect(roundtableDb._queries[0].bindings[0]).toBe('published');
    });
  });

  // ─── Tech Blog Redirects ──────────────────────────────────────

  describe('GET /tech', () => {
    it('returns 301 redirect to your-blog.example.com', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/tech', { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('https://your-blog.example.com');
    });
  });

  describe('GET /tech/feed.xml', () => {
    it('returns 301 redirect to your-blog.example.com/feed.xml', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/tech/feed.xml', { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('https://your-blog.example.com/feed.xml');
    });
  });

  describe('GET /tech/:slug', () => {
    it('returns 301 redirect to your-blog.example.com/post/:slug', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/tech/some-post', { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('https://your-blog.example.com/post/some-post');
    });
  });

  // ─── Content Generation Triggers ────────────────────────────

  describe('POST /api/generate/roundtable', () => {
    it('returns 500 when ROUNDTABLE_DB is not bound', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/generate/roundtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(500);
      const json = await res.json() as any;
      expect(json.error).toContain('ROUNDTABLE_DB');
    });

    it('triggers roundtable generation when DB is bound', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb();
      const app = createApp(db, { ROUNDTABLE_DB: roundtableDb });

      const { buildEdgeEnv } = await import('../src/edge-env.js');
      vi.mocked(buildEdgeEnv).mockReturnValue({
        db, roundtableDb,
        anthropicApiKey: 'key', claudeModel: 'model',
      } as any);

      const res = await app.request('/api/generate/roundtable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      expect(runRoundtableGeneration).toHaveBeenCalled();
    });
  });

  describe('POST /api/generate/journal', () => {
    it('returns 500 when ROUNDTABLE_DB is not bound', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const { buildEdgeEnv } = await import('../src/edge-env.js');
      vi.mocked(buildEdgeEnv).mockReturnValueOnce({
        db, roundtableDb: null,
        anthropicApiKey: 'key', claudeModel: 'model',
      } as any);

      const res = await app.request('/api/generate/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/trigger/dreaming', () => {
    it('triggers dreaming cycle', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/trigger/dreaming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(runDreamingCycle).toHaveBeenCalled();
    });

    it('clears dreaming watermark before running', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/trigger/dreaming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      const deleteQuery = db._queries.find(q => q.sql.includes('DELETE FROM web_events'));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery!.sql).toContain('last_dreaming_at');
    });

    it('returns 500 when dreaming cycle throws', async () => {
      vi.mocked(runDreamingCycle).mockRejectedValueOnce(new Error('Dream failed'));

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/trigger/dreaming', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(500);
      const json = await res.json() as any;
      expect(json.error).toContain('Dream failed');
    });
  });

  // ─── Auth on sanitize-backfill ──────────────────────────────

  describe('POST /api/sanitize-backfill', () => {
    it('requires bearer auth (returns 401 without token)', async () => {
      const db = createMockDb();
      const roundtableDb = createMockDb({ allResults: [[], []] });
      const app = new Hono<{ Bindings: Env }>();

      const { bearerAuth } = await import('../src/auth.js');
      app.use('/api/sanitize-backfill', bearerAuth);
      app.route('/', content);

      const env = {
        DB: db,
        AEGIS_TOKEN: 'test-token',
        ROUNDTABLE_DB: roundtableDb,
      };
      const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

      const req = new Request('http://localhost/api/sanitize-backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const res = await app.fetch(req, env, ctx);
      expect(res.status).toBe(401);
    });
  });
});
