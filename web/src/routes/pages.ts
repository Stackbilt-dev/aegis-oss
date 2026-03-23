// Stub — full implementation not yet extracted to OSS

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { chatPage } from '../ui.js';
import { landingPage } from '../landing.js';
import { dashboardPage, getDashboardData } from '../dashboard.js';
import { pulsePage, getPulseData } from '../pulse.js';

const pages = new Hono<{ Bindings: Env }>();

// ─── Landing ────────────────────────────────────────────────

pages.get('/', (c) => {
  return c.html(landingPage());
});

// ─── Chat ───────────────────────────────────────────────────

pages.get('/chat', (c) => {
  return c.html(chatPage());
});

// ─── Pulse ──────────────────────────────────────────────────

pages.get('/pulse', async (c) => {
  const data = await getPulseData(c.env.DB);
  return c.html(pulsePage(data));
});

// ─── Dashboard ──────────────────────────────────────────────

pages.get('/dashboard', async (c) => {
  const data = await getDashboardData(c.env.DB);
  return c.html(dashboardPage(data));
});

// ─── PWA Manifest ───────────────────────────────────────────

pages.get('/manifest.json', (c) => {
  return c.json({
    name: 'AEGIS',
    short_name: 'AEGIS',
    start_url: '/chat',
    display: 'standalone',
    background_color: '#0a0a0f',
    theme_color: '#8b8bff',
    icons: [],
  });
});

// ─── Service Worker ─────────────────────────────────────────

pages.get('/sw.js', (c) => {
  const sw = `
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(clients.claim()); });
`;
  return new Response(sw.trim(), {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
  });
});

// ─── Events ─────────────────────────────────────────────────

pages.post('/api/events', async (c) => {
  const body = await c.req.json<{ event_id?: string }>();
  const eventId = body.event_id?.trim();

  if (!eventId) {
    return c.json({ error: 'event_id is required' }, 400);
  }

  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
  ).bind(eventId).run();

  return c.json({ ok: true, event_id: eventId });
});

// ─── Reading (TarotScript) ──────────────────────────────────

pages.post('/api/reading', async (c) => {
  const tarotBinding = (c.env as any).TAROTSCRIPT;
  if (!tarotBinding) {
    return c.json({ error: 'TarotScript service binding not configured' }, 503);
  }

  // Full implementation not yet extracted
  return c.json({ error: 'not implemented' }, 501);
});

export { pages };
