// Stub — full implementation not yet extracted to OSS

import { Hono } from 'hono';
import type { Env } from '../types.js';

const operatorLogs = new Hono<{ Bindings: Env }>();

// List operator logs with pagination
operatorLogs.get('/api/operator-logs', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const logs = await c.env.DB.prepare(
    'SELECT id, content, episodes_count, created_at FROM operator_logs ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();

  const countRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM operator_logs'
  ).first<{ cnt: number }>();

  return c.json({
    logs: logs.results,
    total: countRow?.cnt ?? 0,
  });
});

// Get single operator log by ID
operatorLogs.get('/api/operator-logs/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);

  const log = await c.env.DB.prepare(
    'SELECT * FROM operator_logs WHERE id = ?'
  ).bind(id).first();

  if (!log) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json(log);
});

export { operatorLogs };
