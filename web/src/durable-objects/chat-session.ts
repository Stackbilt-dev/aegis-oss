import type { Env, MessageMetadata } from '../types.js';
import { buildEdgeEnv } from '../edge-env.js';
import { createIntent, dispatchStream } from '../kernel/dispatch.js';
import type { DispatchResult } from '../kernel/types.js';
import { isValidConversationId, verifyConversationOwnership } from './chat-session-auth.js';
import { z } from 'zod';

const MessageFrameSchema = z.object({
  type: z.literal('message'),
  text: z.string().trim().min(1),
  conversationId: z.string().optional(),
  eventId: z.string().trim().min(1).optional(),
}).passthrough();

type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: string | null;
  created_at: string;
};

export class ChatSession implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const url = new URL(request.url);
    const userId = this.userId();
    const conversationId = url.searchParams.get('conversationId');

    this.state.acceptWebSocket(server, ['aegis-chat']);
    this.state.waitUntil(this.sendHistory(server, conversationId, userId));

    const headers = new Headers();
    if (request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((p) => p.trim()).includes('aegis-chat')) {
      headers.set('Sec-WebSocket-Protocol', 'aegis-chat');
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON frame' });
      return;
    }

    if (!isRecord(payload) || payload.type !== 'message') return;

    const parsed = MessageFrameSchema.safeParse(payload);
    if (!parsed.success) {
      this.send(ws, { type: 'error', error: 'Invalid message frame' });
      return;
    }

    const eventId = parsed.data.eventId ?? crypto.randomUUID();
    const eventClaimed = await this.claimEvent(eventId);
    if (!eventClaimed) {
      this.send(ws, { type: 'error', error: 'duplicate event' });
      return;
    }

    const text = parsed.data.text;
    const userId = this.userId();
    const conversationId = await this.resolveConversationId(ws, parsed.data.conversationId, userId, text);
    if (!conversationId) return;

    const userMessageId = crypto.randomUUID();
    await this.env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    ).bind(userMessageId, conversationId, 'user', text).run();

    this.send(ws, { type: 'start', conversationId });

    try {
      const edgeEnv = buildEdgeEnv(this.env);
      const intent = createIntent(conversationId, text);
      const result = await dispatchStream(intent, edgeEnv, (delta) => {
        this.send(ws, { type: 'delta', text: delta });
      });

      const assistantMessageId = crypto.randomUUID();
      const metadata = buildMessageMetadata(result);

      await this.env.DB.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)',
      ).bind(assistantMessageId, conversationId, 'assistant', result.text, JSON.stringify(metadata)).run();

      await this.env.DB.prepare(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
      ).bind(conversationId).run();

      this.send(ws, { type: 'done', conversationId, metadata: { id: assistantMessageId, ...metadata } });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.send(ws, { type: 'error', error });
    }
  }

  private async resolveConversationId(
    ws: WebSocket,
    rawConversationId: unknown,
    userId: string,
    firstMessage: string,
  ): Promise<string | null> {
    if (rawConversationId !== undefined && typeof rawConversationId !== 'string') {
      this.send(ws, { type: 'error', error: 'conversationId must be a UUID string' });
      return null;
    }

    const conversationId = rawConversationId ?? crypto.randomUUID();
    if (!isValidConversationId(conversationId)) {
      this.send(ws, { type: 'error', error: 'conversationId must be a UUID string' });
      return null;
    }

    const ownership = await verifyConversationOwnership(this.env.DB, conversationId, userId);
    if (ownership === 'not_owned') {
      this.send(ws, { type: 'error', error: 'conversation not found' });
      return null;
    }
    if (ownership === 'owned') return conversationId;

    await this.env.DB.prepare(
      'INSERT INTO conversations (id, title, user_id) VALUES (?, ?, ?)',
    ).bind(conversationId, firstMessage.slice(0, 100), userId).run();
    return conversationId;
  }

  private async claimEvent(eventId: string): Promise<boolean> {
    const existing = await this.env.DB.prepare(
      'SELECT event_id FROM web_events WHERE event_id = ?',
    ).bind(eventId).first();
    if (existing) return false;

    await this.env.DB.prepare(
      'INSERT INTO web_events (event_id) VALUES (?)',
    ).bind(eventId).run();
    return true;
  }

  private async sendHistory(ws: WebSocket, conversationId: string | null, userId: string): Promise<void> {
    if (!conversationId) {
      this.send(ws, { type: 'history', conversationId: null, messages: [] });
      return;
    }
    if (!isValidConversationId(conversationId)) {
      this.send(ws, { type: 'error', error: 'conversationId must be a UUID string' });
      return;
    }

    const ownership = await verifyConversationOwnership(this.env.DB, conversationId, userId);
    if (ownership === 'not_owned') {
      this.send(ws, { type: 'error', error: 'conversation not found' });
      return;
    }
    if (ownership === 'not_found') {
      this.send(ws, { type: 'history', conversationId, messages: [] });
      return;
    }

    const rows = await this.env.DB.prepare(
      `SELECT m.id, m.role, m.content, m.metadata, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = ? AND c.user_id = ?
       ORDER BY m.created_at ASC`,
    ).bind(conversationId, userId).all<StoredMessage>();

    this.send(ws, {
      type: 'history',
      conversationId,
      messages: rows.results.map((message) => ({
        ...message,
        metadata: parseMetadata(message.metadata),
      })),
    });
  }

  private userId(): string {
    return this.state.id.name ?? 'operator';
  }

  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Ignore writes after the client disconnects.
    }
  }
}

function buildMessageMetadata(result: DispatchResult): MessageMetadata {
  return {
    classification: result.classification,
    executor: result.executor,
    procHit: result.procedureHit,
    latencyMs: result.latency_ms,
    cost: result.cost,
    confidence: result.confidence,
    reclassified: result.reclassified,
    probeResult: result.probeResult,
    grounded: result.grounded,
    sources: result.sources,
    unknowns: result.unknowns,
    searched: result.searched,
    unverifiedClaims: result.unverified_claims,
  };
}

function parseMetadata(value: string | null): MessageMetadata | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as MessageMetadata;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
