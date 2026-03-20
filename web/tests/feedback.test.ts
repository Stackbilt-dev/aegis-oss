// HTTP route tests for web/src/routes/feedback.ts
// Tests POST validation, category normalization, GET listing, email notification.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { feedback } from '../src/routes/feedback.js';
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

function createApp(db: ReturnType<typeof createMockDb>, overrides: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c.env as any) = { DB: db, AEGIS_TOKEN: 'test-token', ...overrides };
    await next();
  });
  app.route('/', feedback);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('feedback routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/feedback', () => {
    it('accepts valid feedback and returns id', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Great product!' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.id).toBeDefined();
      expect(json.received).toBe(true);
    });

    it('returns 400 when message is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('message');
    });

    it('returns 400 when message is too short (< 5 chars)', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hi' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when message exceeds 5000 chars', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(5001) }),
      });

      expect(res.status).toBe(400);
    });

    it('accepts message at boundary (exactly 5 chars)', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });

      expect(res.status).toBe(200);
    });

    it('accepts message at boundary (exactly 5000 chars)', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(5000) }),
      });

      expect(res.status).toBe(200);
    });

    it('normalizes valid category', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Found a bug', category: 'bug' }),
      });

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO feedback'));
      expect(insertQuery!.bindings).toContain('bug');
    });

    it('defaults invalid category to general', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Something here', category: 'invalid' }),
      });

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO feedback'));
      expect(insertQuery!.bindings).toContain('general');
    });

    it('stores email when provided', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Nice work!', email: 'user@test.com' }),
      });

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO feedback'));
      expect(insertQuery!.bindings).toContain('user@test.com');
    });

    it('sets null email when not provided', async () => {
      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Anonymous feedback' }),
      });

      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO feedback'));
      // email should be null (second binding after id)
      expect(insertQuery!.bindings[1]).toBeNull();
    });

    it('sends email notification when RESEND_API_KEY is set', async () => {
      const db = createMockDb();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      const app = createApp(db, { RESEND_API_KEY: 'test-resend-key' });

      await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Feedback with email', category: 'feature' }),
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('does not send email when RESEND_API_KEY is not set', async () => {
      const db = createMockDb();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      const app = createApp(db);

      await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'No email sent' }),
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('handles invalid JSON body gracefully', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/feedback', () => {
    it('lists feedback with default limit', async () => {
      const feedbackData = [
        { id: 'f1', message: 'Great!', category: 'general' },
      ];
      const db = createMockDb({ allResults: [feedbackData] });
      const app = createApp(db);

      const res = await app.request('/api/feedback');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.feedback).toEqual(feedbackData);
    });

    it('uses default limit of 50', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/feedback');
      expect(db._queries[0].bindings[0]).toBe(50);
    });

    it('respects custom limit', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/feedback?limit=10');
      expect(db._queries[0].bindings[0]).toBe(10);
    });

    it('caps limit at 200', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/feedback?limit=999');
      expect(db._queries[0].bindings[0]).toBe(200);
    });
  });
});
