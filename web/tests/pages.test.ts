// HTTP route tests for web/src/routes/pages.ts
// Tests landing, chat, pulse, dashboard, manifest, SW, events, reading endpoints.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/ui.js', () => ({
  chatPage: vi.fn(() => '<html>chat</html>'),
}));

vi.mock('../src/landing.js', () => ({
  landingPage: vi.fn(() => '<html>landing</html>'),
}));

vi.mock('../src/version.js', () => ({
  VERSION: '1.99.0',
}));

vi.mock('../src/dashboard.js', () => ({
  dashboardPage: vi.fn(() => '<html>dashboard</html>'),
  getDashboardData: vi.fn().mockResolvedValue({ version: '1.99.0' }),
}));

vi.mock('../src/pulse.js', () => ({
  pulsePage: vi.fn(() => '<html>pulse</html>'),
  getPulseData: vi.fn().mockResolvedValue({ version: '1.99.0' }),
}));

import { pages } from '../src/routes/pages.js';
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

function createApp(db: ReturnType<typeof createMockDb>, overrides: Record<string, unknown> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c.env as any) = { DB: db, AEGIS_TOKEN: 'test-token', MEMORY: {}, ...overrides };
    await next();
  });
  app.route('/', pages);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('pages routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /', () => {
    it('returns landing page HTML', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('landing');
    });
  });

  describe('GET /chat', () => {
    it('returns chat page HTML', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/chat');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('chat');
    });
  });

  describe('GET /pulse', () => {
    it('returns pulse page HTML', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/pulse');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('pulse');
    });
  });

  describe('GET /dashboard', () => {
    it('returns dashboard page HTML', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/dashboard');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('dashboard');
    });
  });

  describe('GET /manifest.json', () => {
    it('returns PWA manifest', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/manifest.json');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.name).toBe('AEGIS');
      expect(json.short_name).toBe('AEGIS');
      expect(json.start_url).toBe('/chat');
      expect(json.display).toBe('standalone');
      expect(json.background_color).toBe('#0a0a0f');
      expect(json.theme_color).toBe('#8b8bff');
    });
  });

  describe('GET /sw.js', () => {
    it('returns service worker JavaScript', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/sw.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/javascript');
      const text = await res.text();
      expect(text).toContain('skipWaiting');
      expect(text).toContain('clients.claim');
    });
  });

  describe('POST /api/events', () => {
    it('records an event and returns ok', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: 'test-event-1' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.ok).toBe(true);
      expect(json.event_id).toBe('test-event-1');
    });

    it('returns 400 when event_id is missing', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error).toContain('event_id');
    });

    it('returns 400 when event_id is whitespace', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: '   ' }),
      });

      expect(res.status).toBe(400);
    });

    it('trims event_id', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: '  my-event  ' }),
      });

      const json = await res.json() as any;
      expect(json.event_id).toBe('my-event');
    });
  });

  describe('POST /api/reading', () => {
    it('returns 503 when TAROTSCRIPT binding is not configured', async () => {
      const db = createMockDb();
      const app = createApp(db);

      const res = await app.request('/api/reading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spread: 'three_card', intention: 'test' }),
      });

      expect(res.status).toBe(503);
      const json = await res.json() as any;
      expect(json.error).toContain('TarotScript');
    });
  });
});
