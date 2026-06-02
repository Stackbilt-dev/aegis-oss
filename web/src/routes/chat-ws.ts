import { Hono } from 'hono';
import type { Env } from '../types.js';

export const chatWs = new Hono<{ Bindings: Env }>();

chatWs.get('/chat/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  if (!c.env.CHAT_SESSION) {
    return c.text('CHAT_SESSION Durable Object binding is not configured', 503);
  }

  const id = c.env.CHAT_SESSION.idFromName('operator');
  const stub = c.env.CHAT_SESSION.get(id);
  return stub.fetch(c.req.raw);
});
