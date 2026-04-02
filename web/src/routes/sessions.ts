import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../types.js';

const DEFAULT_BODY_LIMIT = 100 * 1024;

export const sessions = new Hono<{ Bindings: Env }>();

interface CCSessionPayload {
  summary: string;
  commits?: Array<{ hash: string; message: string; repo?: string }>;
  files_changed?: string[];
  issues_opened?: Array<{ repo: string; number: number; title: string }>;
  issues_closed?: Array<{ repo: string; number: number; title: string }>;
  decisions?: string[];
  repos?: string[];
  duration_minutes?: number;
}

sessions.post('/api/cc-session', bodyLimit({ maxSize: DEFAULT_BODY_LIMIT }), async (c) => {
  const body = await c.req.json<CCSessionPayload>();
  if (!body.summary?.trim()) {
    return c.json({ error: 'summary is required' }, 400);
  }

  const id = crypto.randomUUID();
  const sessionDate = new Date().toISOString().slice(0, 10);

  await c.env.DB.prepare(`
    INSERT INTO cc_sessions (id, session_date, summary, commits, files_changed, issues_opened, issues_closed, decisions, repos, duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    sessionDate,
    body.summary.trim(),
    body.commits ? JSON.stringify(body.commits) : null,
    body.files_changed ? JSON.stringify(body.files_changed) : null,
    body.issues_opened ? JSON.stringify(body.issues_opened) : null,
    body.issues_closed ? JSON.stringify(body.issues_closed) : null,
    body.decisions ? JSON.stringify(body.decisions) : null,
    body.repos ? JSON.stringify(body.repos) : null,
    body.duration_minutes ?? null,
  ).run();

  return c.json({ id, session_date: sessionDate, status: 'recorded' }, 201);
});

sessions.get('/api/cc-sessions', async (c) => {
  const days = parseInt(c.req.query('days') ?? '7', 10);
  const sessions = await c.env.DB.prepare(
    "SELECT * FROM cc_sessions WHERE created_at > datetime('now', '-' || ? || ' days') ORDER BY created_at DESC LIMIT 50"
  ).bind(days).all();
  return c.json({ sessions: sessions.results });
});
