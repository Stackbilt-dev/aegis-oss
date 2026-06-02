import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/kernel/dispatch.js', () => ({
  createIntent: vi.fn((conversationId: string, text: string) => ({ conversationId, text })),
  dispatchStream: vi.fn(),
}));

vi.mock('../src/edge-env.js', () => ({
  buildEdgeEnv: vi.fn((env: unknown) => ({ env })),
}));

import { ChatSession } from '../src/durable-objects/chat-session.js';
import { dispatchStream } from '../src/kernel/dispatch.js';
import type { Env } from '../src/types.js';

const CONVERSATION_ID = '018f9e54-7f61-4e01-8a04-7b54c23b2e10';

function makeDb(owner: string | null = null, duplicateEvent = false) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  return {
    prepare(sql: string) {
      const entry = { sql, bindings: [] as unknown[] };
      queries.push(entry);
      return {
        bind(...bindings: unknown[]) {
          entry.bindings = bindings;
          return this;
        },
        async first() {
          if (sql.includes('SELECT event_id FROM web_events')) {
            return duplicateEvent ? { event_id: 'evt-1' } : null;
          }
          if (sql.includes('SELECT user_id FROM conversations')) {
            return owner ? { user_id: owner } : null;
          }
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
  } as unknown as D1Database & { _queries: { sql: string; bindings: unknown[] }[] };
}

function makeSession(db: D1Database) {
  const state = {
    id: { name: 'operator' },
    acceptWebSocket: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;
  const env = { DB: db } as Env;
  return new ChatSession(state, env);
}

function sentFrames(ws: { send: ReturnType<typeof vi.fn> }) {
  return ws.send.mock.calls.map(([frame]) => JSON.parse(String(frame)));
}

describe('ChatSession Durable Object', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a new conversation and streams assistant frames', async () => {
    vi.mocked(dispatchStream).mockImplementation(async (_intent, _env, onDelta) => {
      onDelta('partial');
      return {
        text: 'complete',
        classification: 'general_knowledge',
        executor: 'gpt_oss',
        latency_ms: 12,
        cost: 0.001,
        grounded: true,
        sources: ['wiki:demo'],
      } as any;
    });

    const db = makeDb();
    const session = makeSession(db);
    const ws = { send: vi.fn() };

    await session.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: 'message',
      text: 'What changed?',
      conversationId: CONVERSATION_ID,
      eventId: 'evt-1',
    }));

    const frames = sentFrames(ws);
    expect(frames.map((frame) => frame.type)).toEqual(['start', 'delta', 'done']);
    expect(frames[0].conversationId).toBe(CONVERSATION_ID);
    expect(frames[1].text).toBe('partial');
    expect(frames[2].metadata.executor).toBe('gpt_oss');
    expect(frames[2].metadata.grounded).toBe(true);

    expect(db._queries.some((query) =>
      query.sql.includes('INSERT INTO conversations') &&
      query.bindings.includes(CONVERSATION_ID) &&
      query.bindings.includes('operator'),
    )).toBe(true);
    expect(dispatchStream).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign conversations before dispatching', async () => {
    const db = makeDb('other-user');
    const session = makeSession(db);
    const ws = { send: vi.fn() };

    await session.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: 'message',
      text: 'Resume this',
      conversationId: CONVERSATION_ID,
      eventId: 'evt-1',
    }));

    const frames = sentFrames(ws);
    expect(frames).toEqual([{ type: 'error', error: 'conversation not found' }]);
    expect(dispatchStream).not.toHaveBeenCalled();
  });

  it('deduplicates replayed client events before dispatching', async () => {
    const db = makeDb(null, true);
    const session = makeSession(db);
    const ws = { send: vi.fn() };

    await session.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: 'message',
      text: 'Replay this',
      conversationId: CONVERSATION_ID,
      eventId: 'evt-1',
    }));

    const frames = sentFrames(ws);
    expect(frames).toEqual([{ type: 'error', error: 'duplicate event' }]);
    expect(dispatchStream).not.toHaveBeenCalled();
  });
});
