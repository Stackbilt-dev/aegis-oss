// HTTP route tests for web/src/routes/health.ts
// Tests JSON/HTML modes, kernel stats, task stats, docs sync status.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/kernel/memory/index.js', () => ({
  getAllProcedures: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/version.js', () => ({
  VERSION: '1.99.0',
}));

vi.mock('../src/health-page.js', () => ({
  healthPage: vi.fn(() => '<html>health</html>'),
}));

import { health } from '../src/routes/health.js';
import { getAllProcedures } from '../src/kernel/memory/index.js';
import { healthPage } from '../src/health-page.js';
import type { Env } from '../src/types.js';

// ─── D1 Mock ──────────────────────────────────────────────────

function createMockDb(options: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
} = {}) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  let firstIdx = 0;
  let allIdx = 0;

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
          return options.firstResults?.[firstIdx++] ?? null;
        },
        async all() {
          const results = options.allResults?.[allIdx++] ?? [];
          return { results };
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
  app.route('/', health);

  const originalFetch = app.fetch.bind(app);
  app.fetch = (req: Request, ...rest: any[]) => {
    const env = { DB: db, AEGIS_TOKEN: 'test-token', MEMORY: {} };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
    return originalFetch(req, env, ctx);
  };
  return app;
}

// ─── Tests ────────────────────────────────────────────────────

describe('health routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /health (JSON mode)', () => {
    it('returns JSON when format=json query param is set', async () => {
      const db = createMockDb({
        allResults: [[]], // taskStats
        firstResults: [null], // lastDocSync
      });
      const app = createApp(db);

      const res = await app.request('/health?format=json');
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('ok');
      expect(json.service).toBe('aegis-web');
      expect(json.version).toBe('1.99.0');
      expect(json.mode).toBe('edge-native');
      expect(json.kernel).toBeDefined();
      expect(json.tasks_24h).toBeDefined();
      expect(json.timestamp).toBeDefined();
    });

    it('returns JSON when Accept: application/json is set', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [null],
      });
      const app = createApp(db);

      const res = await app.request('/health', {
        headers: { Accept: 'application/json' },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.status).toBe('ok');
    });

    it('includes kernel procedure counts', async () => {
      vi.mocked(getAllProcedures).mockResolvedValueOnce([
        { status: 'learned' },
        { status: 'learned' },
        { status: 'learning' },
        { status: 'degraded' },
        { status: 'broken' },
      ] as any);

      const db = createMockDb({
        allResults: [[]],
        firstResults: [null],
      });
      const app = createApp(db);

      const res = await app.request('/health?format=json');
      const json = await res.json() as any;
      expect(json.kernel.learned).toBe(2);
      expect(json.kernel.learning).toBe(1);
      expect(json.kernel.degraded).toBe(1);
      expect(json.kernel.broken).toBe(1);
    });

    it('includes task stats from last 24h', async () => {
      const taskStats = [
        { task_name: 'dreaming', runs: 5, ok: 4, errors: 1, last_run: '2026-03-10T12:00:00Z' },
      ];
      const db = createMockDb({
        allResults: [taskStats],
        firstResults: [null],
      });
      const app = createApp(db);

      const res = await app.request('/health?format=json');
      const json = await res.json() as any;
      expect(json.tasks_24h).toEqual(taskStats);
    });

    it('includes docs_sync_status with ok when recent', async () => {
      const recentSync = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago
      const db = createMockDb({
        allResults: [[]],
        firstResults: [{ received_at: recentSync }],
      });
      const app = createApp(db);

      const res = await app.request('/health?format=json');
      const json = await res.json() as any;
      expect(json.docs_sync_status.status).toBe('ok');
    });

    it('includes docs_sync_status alert when no sync found', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [null],
      });
      const app = createApp(db);

      const res = await app.request('/health?format=json');
      const json = await res.json() as any;
      expect(json.docs_sync_status.status).toBe('alert');
      expect(json.docs_sync_status.lastSyncAge).toBeNull();
    });
  });

  describe('GET /health (HTML mode)', () => {
    it('returns HTML by default', async () => {
      const db = createMockDb({
        allResults: [[]],
        firstResults: [
          null,      // lastDocSync
          { c: 42 }, // memoryRow
          { c: 3 },  // agendaRow
          { c: 2 },  // goalRow
          { first_run: null }, // uptimeRow
        ],
      });
      const app = createApp(db);

      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('health');
      expect(healthPage).toHaveBeenCalled();
    });

    it('passes HealthData to healthPage', async () => {
      vi.mocked(getAllProcedures).mockResolvedValueOnce([
        { status: 'learned' },
      ] as any);

      const db = createMockDb({
        allResults: [[]],
        firstResults: [
          null,               // lastDocSync
          { c: 10 },          // memoryRow
          { c: 5 },           // agendaRow
          { c: 1 },           // goalRow
          { first_run: null }, // uptimeRow
        ],
      });
      const app = createApp(db);

      await app.request('/health');
      expect(healthPage).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '1.99.0',
          memoryCount: 10,
          agendaCount: 5,
          goalCount: 1,
        }),
      );
    });
  });
});
