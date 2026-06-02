// Daily digest scheduling and delivery resilience tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emailMocks = vi.hoisted(() => ({
  sendDailyDigest: vi.fn(),
}));

vi.mock('../src/email.js', () => ({
  sendDailyDigest: emailMocks.sendDailyDigest,
}));

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    integrations: {
      bizops: { fallbackUrl: 'http://localhost' },
    },
  },
}));

import { runDailyDigest, sendDailyDigestWithRetry } from '../src/kernel/scheduled/digest.js';

interface MockQuery {
  sql: string;
  bindings: unknown[];
}

function createMockDb(options?: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let allIdx = 0;

  const db = {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          return (options?.firstResults?.[firstIdx++] ?? null) as T | null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: (options?.allResults?.[allIdx++] ?? []) as T[] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    _queries: queries,
  };

  return db as unknown as D1Database & { _queries: MockQuery[] };
}

function createDigestDb(lastDigest: { received_at: string } | null = null) {
  return createMockDb({
    firstResults: [
      lastDigest,
      null, // latest operator_log content
    ],
    allResults: [
      [
        {
          payload: JSON.stringify({
            severity: 'medium',
            timestamp: '2026-06-01T09:00:00.000Z',
            checks: [{ name: 'resend_timeout', status: 'warn', detail: 'retry preserved content' }],
          }),
        },
      ],
      [], // event notifications
      [], // memory reflection
      [], // cognitive metrics
      [], // analytics
      [], // developer activity
      [], // service alerts
      [], // completed tasks
      [], // failed tasks
      [], // proposed tasks
      [], // active agenda
    ],
  });
}

function createEnv(db: D1Database) {
  return {
    db,
    resendApiKey: 'rk_test',
    resendApiKeyPersonal: 'rk_personal',
    notifyEmail: 'operator@example.com',
    bizopsToken: '',
    bizopsFetcher: undefined,
  } as any;
}

describe('runDailyDigest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emailMocks.sendDailyDigest.mockReset();
    emailMocks.sendDailyDigest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not run before 09:00 UTC', async () => {
    vi.setSystemTime(new Date('2026-06-01T08:59:00.000Z'));
    const db = createDigestDb();

    await runDailyDigest(createEnv(db));

    expect(db._queries).toHaveLength(0);
    expect(emailMocks.sendDailyDigest).not.toHaveBeenCalled();
  });

  it('runs after 09:00 UTC when no successful digest watermark exists', async () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    const db = createDigestDb();

    await runDailyDigest(createEnv(db));

    expect(emailMocks.sendDailyDigest).toHaveBeenCalledTimes(1);
    expect(db._queries.some(q => q.sql.includes('UPDATE digest_sections SET consumed = 1'))).toBe(true);
    expect(db._queries.some(q => q.sql.includes("event_id, received_at) VALUES ('daily_digest'"))).toBe(true);
  });

  it('respects the existing 22 hour cooldown during catch-up hours', async () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    const db = createDigestDb({ received_at: '2026-06-01T09:00:00' });

    await runDailyDigest(createEnv(db));

    expect(emailMocks.sendDailyDigest).not.toHaveBeenCalled();
    expect(db._queries).toHaveLength(1);
  });
});

describe('sendDailyDigestWithRetry', () => {
  beforeEach(() => {
    emailMocks.sendDailyDigest.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries transient send failures before succeeding', async () => {
    emailMocks.sendDailyDigest
      .mockRejectedValueOnce(new Error('Resend API request timed out after 10s'))
      .mockRejectedValueOnce(new Error('Resend API request timed out after 10s'))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendDailyDigestWithRetry(
      { resendApiKey: 'rk_test', resendApiKeyPersonal: 'rk_personal' },
      {
        completedTasks: [],
        failedTasks: [],
        proposedTasks: [],
        operatorLog: null,
        healthChecks: [],
        eventNotifications: [],
        memoryReflection: null,
        cognitiveMetrics: null,
        analytics: null,
        devActivity: null,
        serviceAlerts: [],
        agendaItems: [],
        bizopsInteractions: null,
      },
      'operator@example.com',
      [0, 0],
    );

    expect(emailMocks.sendDailyDigest).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
