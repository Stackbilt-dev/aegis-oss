// HTTP route tests for web/src/routes/conversations.ts
// Tests conversation listing and message retrieval with metadata parsing.

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { conversations } from '../src/routes/conversations.js';
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
  app.route('/', conversations);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('conversations routes', () => {
  describe('GET /api/conversations', () => {
    it('lists conversations ordered by updated_at', async () => {
      const convData = [
        { id: 'c1', title: 'Hello world', created_at: '2026-03-10', updated_at: '2026-03-10' },
        { id: 'c2', title: 'Another chat', created_at: '2026-03-09', updated_at: '2026-03-09' },
      ];
      const db = createMockDb({ allResults: [convData] });
      const app = createApp(db);

      const res = await app.request('/api/conversations');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.conversations).toEqual(convData);
      expect(json.conversations.length).toBe(2);
    });

    it('returns empty array when no conversations', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      const res = await app.request('/api/conversations');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.conversations).toEqual([]);
    });

    it('queries with LIMIT 50', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/conversations');
      expect(db._queries[0].sql).toContain('LIMIT 50');
    });
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('returns messages for a conversation', async () => {
      const msgData = [
        { id: 'm1', role: 'user', content: 'Hello', metadata: null, created_at: '2026-03-10T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Hi!', metadata: '{"classification":"greeting"}', created_at: '2026-03-10T00:00:01Z' },
      ];
      const db = createMockDb({ allResults: [msgData] });
      const app = createApp(db);

      const res = await app.request('/api/conversations/conv-1/messages');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.conversationId).toBe('conv-1');
      expect(json.messages.length).toBe(2);
    });

    it('parses metadata JSON strings', async () => {
      const msgData = [
        { id: 'm1', role: 'assistant', content: 'Hi', metadata: '{"classification":"greeting","executor":"groq_8b"}', created_at: '2026-03-10T00:00:00Z' },
      ];
      const db = createMockDb({ allResults: [msgData] });
      const app = createApp(db);

      const res = await app.request('/api/conversations/conv-1/messages');
      const json = await res.json() as any;
      expect(json.messages[0].metadata).toEqual({ classification: 'greeting', executor: 'groq_8b' });
    });

    it('returns null metadata for messages without it', async () => {
      const msgData = [
        { id: 'm1', role: 'user', content: 'Hello', metadata: null, created_at: '2026-03-10T00:00:00Z' },
      ];
      const db = createMockDb({ allResults: [msgData] });
      const app = createApp(db);

      const res = await app.request('/api/conversations/conv-1/messages');
      const json = await res.json() as any;
      expect(json.messages[0].metadata).toBeNull();
    });

    it('binds conversation id to query', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      await app.request('/api/conversations/test-conv-id/messages');
      expect(db._queries[0].bindings[0]).toBe('test-conv-id');
    });

    it('returns empty messages array for unknown conversation', async () => {
      const db = createMockDb({ allResults: [[]] });
      const app = createApp(db);

      const res = await app.request('/api/conversations/unknown/messages');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.messages).toEqual([]);
    });
  });
});
