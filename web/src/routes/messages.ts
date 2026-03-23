import { Hono } from 'hono';
import { createIntent, dispatch, dispatchStream } from '../kernel/dispatch.js';
import { askGroq } from '../groq.js';
import type { Env, MessageMetadata } from '../types.js';
import { buildEdgeEnv } from '../edge-env.js';

const messages = new Hono<{ Bindings: Env }>();

// ─── Gateway URL helpers ──────────────────────────────────

function groqBaseUrl(env: Env): string | undefined {
  if (!env.AI_GATEWAY_ID) return undefined;
  if (!env.CF_ACCOUNT_ID) return undefined;
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/groq`;
}

// ─── Auto-generate conversation title (#21) ──────────────

async function generateConversationTitle(
  db: D1Database,
  conversationId: string,
  firstMessage: string,
  groqApiKey: string,
  groqModel: string,
  groqBase?: string,
): Promise<void> {
  try {
    const title = await askGroq(
      groqApiKey,
      groqModel,
      'Generate a concise 3-6 word title for a conversation that starts with the following message. Return ONLY the title, no quotes, no punctuation at the end.',
      firstMessage,
      groqBase,
    );
    const cleaned = title.trim().slice(0, 100);
    if (cleaned) {
      await db.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(cleaned, conversationId).run();
    }
  } catch {
    // Non-fatal — leaves first-message slice as title
  }
}

// ─── Send Message (edge-native kernel) ───────────────────────
messages.post('/api/message', async (c) => {
  const body = await c.req.json<{ text: string; conversationId?: string }>();
  if (!body.text?.trim()) {
    return c.json({ error: 'text is required' }, 400);
  }

  const text = body.text.trim();
  const conversationId = body.conversationId ?? crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  // Event dedup
  const existing = await c.env.DB.prepare(
    'SELECT event_id FROM web_events WHERE event_id = ?'
  ).bind(eventId).first();
  if (existing) {
    return c.json({ error: 'duplicate event' }, 409);
  }
  await c.env.DB.prepare(
    'INSERT INTO web_events (event_id) VALUES (?)'
  ).bind(eventId).run();

  // Ensure conversation exists
  const convInsert = await c.env.DB.prepare(
    'INSERT OR IGNORE INTO conversations (id, title) VALUES (?, ?)'
  ).bind(conversationId, text.slice(0, 100)).run();
  const isNewConversation = (convInsert.meta.changes ?? 0) > 0;

  // Save user message
  await c.env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)'
  ).bind(userMessageId, conversationId, 'user', text).run();

  // Fire-and-forget title generation for new conversations (#21)
  if (isNewConversation && c.executionCtx) {
    c.executionCtx.waitUntil(
      generateConversationTitle(c.env.DB, conversationId, text, c.env.GROQ_API_KEY, c.env.GROQ_MODEL || 'llama-3.3-70b-versatile', groqBaseUrl(c.env)),
    );
  }

  // Dispatch through edge kernel
  const edgeEnv = buildEdgeEnv(c.env, c.executionCtx);
  const intent = createIntent(conversationId, text);

  try {
    const result = await dispatch(intent, edgeEnv);

    // Save assistant message
    const assistantMessageId = crypto.randomUUID();
    const metadata: MessageMetadata = {
      classification: result.classification,
      executor: result.executor,
      procHit: result.procedureHit,
      latencyMs: result.latency_ms,
      cost: result.cost,
      confidence: result.confidence,
      reclassified: result.reclassified,
      probeResult: result.probeResult,
    };

    await c.env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
    ).bind(assistantMessageId, conversationId, 'assistant', result.text, JSON.stringify(metadata)).run();

    await c.env.DB.prepare(
      "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"
    ).bind(conversationId).run();

    return c.json({
      conversationId,
      message: {
        id: assistantMessageId,
        role: 'assistant',
        content: result.text,
        metadata,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errMessageId = crypto.randomUUID();

    await c.env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)'
    ).bind(errMessageId, conversationId, 'assistant', `Error: ${errMsg}`, JSON.stringify({ error: true })).run();

    console.error('Kernel error:', errMsg);
    return c.json({
      conversationId,
      message: {
        id: errMessageId,
        role: 'assistant',
        content: 'An error occurred processing your message',
        metadata: { error: true },
      },
    }, 500);
  }
});

// ─── Streaming Message (SSE) ─────────────────────────────────
messages.post('/api/message/stream', async (c) => {
  const body = await c.req.json<{ text: string; conversationId?: string }>();
  if (!body.text?.trim()) {
    return c.json({ error: 'text is required' }, 400);
  }

  const text = body.text.trim();
  const conversationId = body.conversationId ?? crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  // Event dedup
  const existing = await c.env.DB.prepare(
    'SELECT event_id FROM web_events WHERE event_id = ?'
  ).bind(eventId).first();
  if (existing) return c.json({ error: 'duplicate event' }, 409);
  await c.env.DB.prepare('INSERT INTO web_events (event_id) VALUES (?)').bind(eventId).run();

  // Ensure conversation + save user message
  const convInsertStream = await c.env.DB.prepare('INSERT OR IGNORE INTO conversations (id, title) VALUES (?, ?)').bind(conversationId, text.slice(0, 100)).run();
  const isNewConvStream = (convInsertStream.meta.changes ?? 0) > 0;
  await c.env.DB.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').bind(userMessageId, conversationId, 'user', text).run();

  // Fire-and-forget title generation for new conversations (#21)
  if (isNewConvStream && c.executionCtx) {
    c.executionCtx.waitUntil(
      generateConversationTitle(c.env.DB, conversationId, text, c.env.GROQ_API_KEY, c.env.GROQ_MODEL || 'llama-3.3-70b-versatile', groqBaseUrl(c.env)),
    );
  }

  const edgeEnv = buildEdgeEnv(c.env, c.executionCtx);
  const intent = createIntent(conversationId, text);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const writeSSE = (data: unknown) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

  // Run dispatch async — stream stays open until writer.close()
  (async () => {
    try {
      await writeSSE({ type: 'start', conversationId });

      const result = await dispatchStream(intent, edgeEnv, async (delta) => {
        await writeSSE({ type: 'delta', text: delta });
      });

      // Persist assistant message
      const assistantMessageId = crypto.randomUUID();
      const metadata: MessageMetadata = {
        classification: result.classification,
        executor: result.executor,
        procHit: result.procedureHit,
        latencyMs: result.latency_ms,
        cost: result.cost,
        confidence: result.confidence,
        reclassified: result.reclassified,
        probeResult: result.probeResult,
      };
      await c.env.DB.prepare('INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)').bind(assistantMessageId, conversationId, 'assistant', result.text, JSON.stringify(metadata)).run();
      await c.env.DB.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").bind(conversationId).run();

      await writeSSE({ type: 'done', conversationId, metadata: { id: assistantMessageId, ...metadata } });
    } catch (err) {
      await writeSSE({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

export { messages };
