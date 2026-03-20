// HTTP route tests for web/src/routes/messages.ts
// Tests message dispatch, validation, streaming SSE format, and error handling.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock heavy dependencies before importing routes
vi.mock('../src/kernel/dispatch.js', () => ({
  createIntent: vi.fn((conversationId: string, text: string) => ({ conversationId, text })),
  dispatch: vi.fn(),
  dispatchStream: vi.fn(),
}));

vi.mock('../src/groq.js', () => ({
  askGroq: vi.fn().mockResolvedValue('Test Title'),
}));

vi.mock('../src/edge-env.js', () => ({
  buildEdgeEnv: vi.fn((env: any) => ({
    db: env.DB,
    anthropicApiKey: 'test-key',
    claudeModel: 'test-model',
  })),
}));

import { messages } from '../src/routes/messages.js';
import { dispatch, dispatchStream } from '../src/kernel/dispatch.js';
import type { Env } from '../src/types.js';

// ─── D1 Mock ──────────────────────────────────────────────────

function createMockDb() {
  const queries: { sql: string; bindings: unknown[] }[] = [];

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
          // Event dedup check — always return null (no duplicate)
          return null;
        },
        async all() {
          return { results: [] };
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
  app.route('/', messages);

  const originalFetch = app.fetch.bind(app);
  app.fetch = (req: Request, ...rest: any[]) => {
    const env = {
      DB: db,
      AEGIS_TOKEN: 'test-token',
      GROQ_API_KEY: 'groq-key',
      GROQ_MODEL: 'test-model',
    };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    return originalFetch(req, env, ctx);
  };
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('messages routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/message', () => {
    it('returns 400 when text is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('text is required');
    });

    it('returns 400 when text is whitespace-only', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      });

      expect(res.status).toBe(400);
    });

    it('dispatches message and returns response', async () => {
      vi.mocked(dispatch).mockResolvedValue({
        text: 'Hello back!',
        classification: 'greeting',
        executor: 'groq_8b',
        latency_ms: 42,
        cost: 0.0001,
      } as any);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', conversationId: 'conv-1' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.conversationId).toBe('conv-1');
      expect(json.message.role).toBe('assistant');
      expect(json.message.content).toBe('Hello back!');
      expect(json.message.metadata.classification).toBe('greeting');
      expect(json.message.metadata.executor).toBe('groq_8b');
    });

    it('auto-generates conversationId when not provided', async () => {
      vi.mocked(dispatch).mockResolvedValue({
        text: 'Response',
        classification: 'chat',
        executor: 'claude',
        latency_ms: 100,
        cost: 0.01,
      } as any);

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.conversationId).toBeDefined();
      expect(json.conversationId.length).toBeGreaterThan(0);
    });

    it('returns 500 when dispatch throws', async () => {
      vi.mocked(dispatch).mockRejectedValue(new Error('Kernel exploded'));

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });

      expect(res.status).toBe(500);
      const json = await res.json() as any;
      expect(json.message.content).toContain('Kernel error');
      expect(json.message.metadata.error).toBe(true);
    });

    it('persists user message to DB', async () => {
      vi.mocked(dispatch).mockResolvedValue({
        text: 'Ok',
        classification: 'chat',
        executor: 'claude',
        latency_ms: 50,
        cost: 0.005,
      } as any);

      const db = createMockDb();
      const app = createApp(db);

      await app.request('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Save me' }),
      });

      const insertUserMsg = db._queries.find(
        q => q.sql.includes('INSERT INTO messages') && q.bindings.includes('user')
      );
      expect(insertUserMsg).toBeDefined();
      expect(insertUserMsg!.bindings).toContain('Save me');
    });
  });

  describe('POST /api/message/stream', () => {
    it('returns 400 when text is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns SSE content type', async () => {
      vi.mocked(dispatchStream).mockImplementation(async (_intent, _env, onDelta) => {
        await onDelta!('Hello');
        return {
          text: 'Hello',
          classification: 'greeting',
          executor: 'groq_8b',
          latency_ms: 30,
          cost: 0.0001,
        } as any;
      });

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hi' }),
      });

      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
    });

    it('streams SSE events in correct format', async () => {
      vi.mocked(dispatchStream).mockImplementation(async (_intent, _env, onDelta) => {
        await onDelta!('chunk1');
        await onDelta!('chunk2');
        return {
          text: 'chunk1chunk2',
          classification: 'chat',
          executor: 'claude',
          latency_ms: 100,
          cost: 0.01,
        } as any;
      });

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Stream test' }),
      });

      const body = await res.text();
      const events = body.split('\n\n').filter(Boolean).map(line => {
        const dataStr = line.replace('data: ', '');
        return JSON.parse(dataStr);
      });

      // Should have: start, delta(chunk1), delta(chunk2), done
      expect(events[0].type).toBe('start');
      expect(events[0].conversationId).toBeDefined();

      const deltas = events.filter((e: any) => e.type === 'delta');
      expect(deltas.length).toBe(2);
      expect(deltas[0].text).toBe('chunk1');
      expect(deltas[1].text).toBe('chunk2');

      const done = events.find((e: any) => e.type === 'done');
      expect(done).toBeDefined();
      expect(done.metadata.classification).toBe('chat');
    });

    it('streams error event on dispatch failure', async () => {
      vi.mocked(dispatchStream).mockRejectedValue(new Error('Stream broke'));

      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/message/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Fail test' }),
      });

      const body = await res.text();
      const events = body.split('\n\n').filter(Boolean).map(line => {
        const dataStr = line.replace('data: ', '');
        return JSON.parse(dataStr);
      });

      const errorEvent = events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toContain('Stream broke');
    });
  });
});
