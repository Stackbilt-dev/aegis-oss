import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSqliteD1 } from './helpers/sqlite-d1.js';
import { enqueueEvent, claimBatch, countOpenEvents } from '../src/kernel/events.js';
import { drainOnce, runUntilIdle, type BatchHandler } from '../src/kernel/runner.js';
import { createAgentRunnerDO, notifyRunner, enqueueAndNotify } from '../src/durable-objects/agent-runner.js';

const SCHEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');
const MIN = 60_000;

let db: D1Database;
const row = (id: string) => (db as any).raw.prepare('SELECT * FROM agent_events WHERE id = ?').get(id);
const enqueue = (extra: Record<string, unknown> = {}) =>
  enqueueEvent(db, { source: 'test', kind: 'k', ...extra }, new Date(Date.now() - 1000));

beforeEach(() => {
  db = createSqliteD1(SCHEMA);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('drainOnce', () => {
  it('returns claimed: 0 and never calls the handler when nothing is ready', async () => {
    const handler = vi.fn();
    const summary = await drainOnce(db, handler);
    expect(summary).toMatchObject({ claimed: 0, runId: null });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the whole batch once and marks every event done when the handler returns nothing', async () => {
    const ids = [(await enqueue()).id, (await enqueue()).id, (await enqueue()).id];
    const handler = vi.fn<BatchHandler>(async () => undefined);
    const summary = await drainOnce(db, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].map(e => e.id).sort()).toEqual([...ids].sort());
    expect(summary).toMatchObject({ claimed: 3, done: 3, lost: 0 });
    for (const id of ids) expect(row(id)).toMatchObject({ status: 'done', run_id: summary.runId });
  });

  it('applies a single outcome to every event', async () => {
    const a = await enqueue();
    const b = await enqueue();
    const summary = await drainOnce(db, async () => ({ status: 'deferred', reason: 'awaiting approval' }));
    expect(summary.deferred).toBe(2);
    expect(row(a.id).defer_reason).toBe('awaiting approval');
    expect(row(b.id).status).toBe('deferred');
  });

  it('applies per-event outcomes and retries events the handler left out', async () => {
    const done = await enqueue();
    const failed = await enqueue();
    const retry = await enqueue();
    const forgotten = await enqueue();
    const summary = await drainOnce(db, async () => ({
      [done.id]: { status: 'done' },
      [failed.id]: { status: 'failed', error: 'bad input' },
      [retry.id]: { status: 'retry', error: 'upstream 503', retryDelayMs: 0 },
    }));
    expect(summary).toMatchObject({ claimed: 4, done: 1, failed: 1, retried: 2 });
    expect(row(done.id).status).toBe('done');
    expect(row(failed.id)).toMatchObject({ status: 'failed', error: 'bad input' });
    expect(row(retry.id)).toMatchObject({ status: 'pending', error: 'upstream 503' });
    expect(row(forgotten.id)).toMatchObject({ status: 'pending', error: 'handler returned no outcome for this event' });
  });

  it('retries every event when the handler throws, and counts a final failure as failed', async () => {
    const once = await enqueue({ maxAttempts: 1 });
    const twice = await enqueue({ maxAttempts: 2 });
    const summary = await drainOnce(db, async () => { throw new Error('model timeout'); });
    expect(summary).toMatchObject({ claimed: 2, retried: 1, failed: 1, error: 'model timeout' });
    expect(row(once.id)).toMatchObject({ status: 'failed', error: 'model timeout' });
    expect(row(twice.id)).toMatchObject({ status: 'pending', error: 'model timeout' });
  });

  it('only claims the given principal', async () => {
    await enqueue({ principal: 'alice' });
    const bob = await enqueue({ principal: 'bob' });
    const summary = await drainOnce(db, async () => undefined, { principal: 'bob' });
    expect(summary.claimed).toBe(1);
    expect(row(bob.id).status).toBe('done');
    expect((await countOpenEvents(db, 'alice')).pending).toBe(1);
  });

  it('renews the lease while a long handler runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    const { id } = await enqueue();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });

    const running = drainOnce(db, async () => { await gate; }, { leaseMs: 9 * MIN });
    await vi.advanceTimersByTimeAsync(20 * MIN); // past the original 9-minute lease
    expect((await claimBatch(db, {})).events).toHaveLength(0); // still held: renewed
    release();
    const summary = await running;
    expect(summary).toMatchObject({ done: 1, lost: 0 });
    expect(row(id).status).toBe('done');
  });

  it('aborts the signal and reports lost settles when another run takes the lease', async () => {
    const { id } = await enqueue();
    let signal!: AbortSignal;
    const summary = await drainOnce(db, async (_events, ctx) => {
      signal = ctx.signal;
      // Simulate a lapse: another run reclaims the event under a new claim.
      (db as any).raw.prepare("UPDATE agent_events SET claim_id = 'other', lease_until = '9999-01-01T00:00:00.000Z' WHERE id = ?").run(id);
      expect(await ctx.renew()).toBe(0);
    });
    expect(signal.aborted).toBe(true);
    expect(summary).toMatchObject({ claimed: 1, done: 0, lost: 1 });
    expect(row(id).claim_id).toBe('other');
  });
});

describe('runUntilIdle', () => {
  it('runs batches until the inbox is empty', async () => {
    for (let i = 0; i < 5; i++) await enqueue();
    const result = await runUntilIdle(db, async () => undefined, { batchLimit: 2 });
    expect(result.runs.map(r => r.claimed)).toEqual([2, 2, 1]);
    expect(result.more).toBe(false);
  });

  it('stops at maxRuns and reports more', async () => {
    for (let i = 0; i < 5; i++) await enqueue();
    const result = await runUntilIdle(db, async () => undefined, { batchLimit: 2, maxRuns: 2 });
    expect(result.runs).toHaveLength(2);
    expect(result.more).toBe(true);
  });
});

// ─── Durable Object ───────────────────────────────────────────

function fakeState() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      async get<T>(key: string) { return store.get(key) as T | undefined; },
      async put(key: string, value: unknown) { store.set(key, value); },
      async getAlarm() { return alarm; },
      async setAlarm(at: number | Date) { alarm = typeof at === 'number' ? at : at.getTime(); },
      async deleteAlarm() { alarm = null; },
    },
    get alarm() { return alarm; },
    clearAlarm() { alarm = null; },
  };
}

function makeRunner(handle: BatchHandler | ((...args: any[]) => any) = async () => undefined, extra: Record<string, unknown> = {}) {
  const Runner = createAgentRunnerDO({ handle: handle as any, debounceMs: 2000, ...extra });
  const state = fakeState();
  const env = { DB: db };
  const runner = new Runner(state as unknown as DurableObjectState, env);
  return { runner, state, env };
}

const notify = (runner: { fetch(r: Request): Promise<Response> }, principal: unknown = 'operator') =>
  runner.fetch(new Request('https://agent-runner/notify', { method: 'POST', body: JSON.stringify({ principal }) }));

describe('AgentRunnerDO', () => {
  it('notify sets a debounced alarm and never pushes an earlier one later', async () => {
    const { runner, state } = makeRunner();
    const before = Date.now();
    expect((await notify(runner)).status).toBe(202);
    const first = state.alarm!;
    expect(first).toBeGreaterThanOrEqual(before + 2000);
    await new Promise(r => setTimeout(r, 5));
    await notify(runner);
    expect(state.alarm).toBe(first);
  });

  it('rejects a bad principal and a principal that is not this runner’s', async () => {
    const { runner } = makeRunner();
    expect((await notify(runner, '')).status).toBe(400);
    expect((await notify(runner, 'has spaces')).status).toBe(400);
    expect((await runner.fetch(new Request('https://agent-runner/notify', { method: 'POST', body: '{' }))).status).toBe(400);
    expect((await notify(runner, 'alice')).status).toBe(202);
    expect((await notify(runner, 'bob')).status).toBe(409);
  });

  it('alarm drains the inbox with the env, records status, and sets no alarm when idle', async () => {
    const handle = vi.fn(async () => undefined);
    const onResult = vi.fn();
    const { runner, state, env } = makeRunner(handle, { onResult });
    const { id } = await enqueue();
    await notify(runner);
    state.clearAlarm(); // the platform clears it when the alarm fires

    await runner.alarm();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][2]).toBe(env);
    expect(row(id).status).toBe('done');
    expect(state.alarm).toBeNull();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ principal: 'operator', more: false }), env);

    const status = await (await runner.fetch(new Request('https://agent-runner/status'))).json() as any;
    expect(status).toMatchObject({ principal: 'operator', nextAlarm: null, last: { runs: 1, claimed: 1, done: 1 } });
  });

  it('alarm reschedules for the next retry after a failure', async () => {
    const { runner, state } = makeRunner(async () => ({ status: 'retry', error: 'busy', retryDelayMs: 5 * MIN }));
    await enqueue();
    await notify(runner);
    state.clearAlarm();
    const before = Date.now();
    await runner.alarm();
    expect(state.alarm).toBeGreaterThanOrEqual(before + 5 * MIN - 1000);
    expect(state.alarm).toBeLessThanOrEqual(Date.now() + 5 * MIN);
  });

  it('alarm reschedules immediately when it hit maxRunsPerAlarm', async () => {
    const { runner, state } = makeRunner(async () => undefined, { batchLimit: 1, maxRunsPerAlarm: 1 });
    await enqueue();
    await enqueue();
    await notify(runner);
    state.clearAlarm();
    const before = Date.now();
    await runner.alarm();
    expect(state.alarm).toBeGreaterThanOrEqual(before);
    expect(state.alarm).toBeLessThanOrEqual(Date.now());
    expect((await countOpenEvents(db)).pending).toBe(1);
  });

  it('alarm does nothing before any notify, and a throwing onResult does not break it', async () => {
    const handle = vi.fn(async () => undefined);
    const { runner } = makeRunner(handle, { onResult: () => { throw new Error('log sink down'); } });
    await enqueue();
    await runner.alarm();
    expect(handle).not.toHaveBeenCalled();
    await notify(runner);
    await expect(runner.alarm()).resolves.toBeUndefined();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for other routes', async () => {
    const { runner } = makeRunner();
    expect((await runner.fetch(new Request('https://agent-runner/nope'))).status).toBe(404);
  });
});

describe('notifyRunner / enqueueAndNotify', () => {
  function fakeNamespace() {
    const calls: { name: string; body: unknown }[] = [];
    let status = 202;
    const ns = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (_url: string, init: RequestInit) => {
          calls.push({ name: id.name, body: JSON.parse(String(init.body)) });
          return new Response('nope', { status });
        },
      }),
    };
    return { ns: ns as unknown as DurableObjectNamespace, calls, fail: () => { status = 500; } };
  }

  it('routes to the principal’s runner by name', async () => {
    const { ns, calls } = fakeNamespace();
    await notifyRunner(ns, 'alice');
    expect(calls).toEqual([{ name: 'alice', body: { principal: 'alice' } }]);
  });

  it('throws when the runner refuses', async () => {
    const { ns, fail } = fakeNamespace();
    fail();
    await expect(notifyRunner(ns)).rejects.toThrow(/500/);
  });

  it('enqueues, then notifies even for a duplicate', async () => {
    const { ns, calls } = fakeNamespace();
    const a = await enqueueAndNotify(db, ns, { source: 'github', sourceId: 'd1', kind: 'webhook' });
    const b = await enqueueAndNotify(db, ns, { source: 'github', sourceId: 'd1', kind: 'webhook' });
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(calls.map(c => c.name)).toEqual(['operator', 'operator']);
  });
});
