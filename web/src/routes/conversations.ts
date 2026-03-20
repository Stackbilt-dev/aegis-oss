import { Hono } from 'hono';
import type { Env } from '../types.js';

export const conversations = new Hono<{ Bindings: Env }>();

conversations.get('/api/conversations', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50'
  ).all();
  return c.json({ conversations: rows.results });
});

conversations.get('/api/conversations/:id/messages', async (c) => {
  const id = c.req.param('id');
  const rows = await c.env.DB.prepare(
    'SELECT id, role, content, metadata, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).bind(id).all();
  return c.json({
    conversationId: id,
    messages: rows.results.map((m: any) => ({
      ...m,
      metadata: m.metadata ? JSON.parse(m.metadata) : null,
    })),
  });
});
