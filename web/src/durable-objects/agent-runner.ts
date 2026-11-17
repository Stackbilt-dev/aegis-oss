// --- Agent runner Durable Object (aegis-oss#100) ---
//
// One instance per principal (idFromName(principal)). Sources write an event
// with enqueueEvent() and then call notifyRunner(); the runner wakes on an
// alarm, drains the inbox with runUntilIdle(), and sets its next alarm for
// the earliest event that becomes claimable (a retry backoff or a lapsed
// lease). Durable Object alarms never overlap, so there is one active run
// per principal.
//
// Notifications are debounced: the alarm fires debounceMs after the first
// notify, so a burst of events (three quick chat messages) becomes one run.
// Events that arrive while a run is working wait for the next run, which
// starts as soon as this one ends.
//
// Alarm handlers have a wall-clock limit on Cloudflare (15 min at the time
// of writing). runDeadlineMs (default 10 min) stops a wake-up from starting
// another run after that point; it reschedules instead. A single handler
// call is not interrupted, so keep one run well under the limit.
//
// The alarm never throws: a failure (D1 down, a bug) is recorded in /status
// and the runner retries itself after errorBackoffMs, so it doesn't depend
// on the platform's limited alarm retries.
//
// Durable Objects are declared by class name in wrangler, so configuration
// is baked into the class:
//   export const AgentRunnerDO = createAgentRunnerDO({ handle: async (events, ctx, env) => { ... } });
//
// HTTP surface (internal; reach it through notifyRunner / a stub):
//   POST /notify  {"principal": "..."}  — schedule a run
//   GET  /status                          — principal, next alarm, last result

import {
  enqueueEvent,
  nextReadyAt,
  normalizePrincipal,
  PRINCIPAL_PATTERN,
  type AgentEvent,
  type EnqueueEventInput,
  type EnqueueEventResult,
} from '../kernel/events.js';
import {
  runUntilIdle,
  normalizeLeaseMs,
  type RunContext,
  type RunOutcome,
  type RunUntilIdleResult,
} from '../kernel/runner.js';

export interface AgentRunnerConfig<E> {
  /** Run one batch. Same contract as BatchHandler in kernel/runner.ts, plus the Worker env. Don't settle events yourself. */
  handle(events: AgentEvent[], ctx: RunContext, env: E): Promise<void | null | RunOutcome | Record<string, RunOutcome>>;
  /** Where the agent_events table lives. Default env.DB. */
  db?(env: E): D1Database;
  /** Delay from the first notify to the run, to batch bursts. Default 2 s. */
  debounceMs?: number;
  /** Max events per run, 1–100. Default 20. */
  batchLimit?: number;
  /** Lease per claim. Default 10 min, max 24 h. */
  leaseMs?: number;
  /** Runs per alarm before yielding; more work reschedules immediately. Default 5. */
  maxRunsPerAlarm?: number;
  /** Don't start another run in the same wake-up after this. Default 10 min. */
  runDeadlineMs?: number;
  /** Delay before the runner retries itself after a failed alarm. Default 60 s. */
  errorBackoffMs?: number;
  /** Called with each alarm's result, after the next alarm is set. Errors are ignored; it gets onResultTimeoutMs. */
  onResult?(result: RunUntilIdleResult & { principal: string }, env: E): void | Promise<void>;
  /** Default 5 s. */
  onResultTimeoutMs?: number;
}

interface StoredStatus {
  at: string;
  ok: boolean;
  runs: number;
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  deferred: number;
  lost: number;
  settleErrors: number;
  exhausted: number;
  more: boolean;
  errors: string[];
  /** Platform retry count for this alarm (0 on a first attempt). */
  retryCount: number;
}

const PRINCIPAL_KEY = 'principal';
const STATUS_KEY = 'last_result';
const MAX_ERROR_CHARS = 1000;

function nonNegative(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`createAgentRunnerDO: ${field} must be a finite number >= 0`);
  }
  return value;
}

function positiveInt(value: number | undefined, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > max) {
    throw new Error(`createAgentRunnerDO: ${field} must be a number from 1 to ${max}`);
  }
  return Math.floor(value);
}

export function createAgentRunnerDO<E extends { DB?: D1Database } = { DB: D1Database }>(config: AgentRunnerConfig<E>) {
  // Validate configuration once, at class creation, so a bad config fails at
  // deploy/startup rather than inside every alarm.
  if (typeof config?.handle !== 'function') throw new Error('createAgentRunnerDO: handle is required');
  const debounceMs = nonNegative(config.debounceMs, 2000, 'debounceMs');
  const batchLimit = positiveInt(config.batchLimit, 20, 100, 'batchLimit');
  const leaseMs = normalizeLeaseMs(config.leaseMs);
  const maxRuns = positiveInt(config.maxRunsPerAlarm, 5, 1000, 'maxRunsPerAlarm');
  const runDeadlineMs = nonNegative(config.runDeadlineMs, 10 * 60 * 1000, 'runDeadlineMs');
  const errorBackoffMs = nonNegative(config.errorBackoffMs, 60 * 1000, 'errorBackoffMs');
  const onResultTimeoutMs = nonNegative(config.onResultTimeoutMs, 5000, 'onResultTimeoutMs');

  const dbFor = (env: E): D1Database => {
    const db = config.db ? config.db(env) : env.DB;
    if (!db) throw new Error('AgentRunnerDO: no D1 database (set env.DB or config.db)');
    return db;
  };

  return class AgentRunnerDO implements DurableObject {
    constructor(
      private readonly state: DurableObjectState,
      private readonly env: E,
    ) {}

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/notify') {
        let principal: unknown;
        try {
          principal = ((await request.json()) as { principal?: unknown }).principal;
        } catch {
          return Response.json({ error: 'invalid JSON' }, { status: 400 });
        }
        if (typeof principal !== 'string' || !PRINCIPAL_PATTERN.test(principal)) {
          return Response.json({ error: 'principal must match ' + PRINCIPAL_PATTERN.source }, { status: 400 });
        }
        const bound = await this.state.storage.get<string>(PRINCIPAL_KEY);
        if (bound && bound !== principal) {
          return Response.json({ error: 'this runner belongs to another principal' }, { status: 409 });
        }
        if (!bound) await this.state.storage.put(PRINCIPAL_KEY, principal);
        const alarmAt = await this.scheduleNoLaterThan(Date.now() + debounceMs);
        return Response.json({ scheduled: new Date(alarmAt).toISOString() }, { status: 202 });
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        const [principal, alarm, last] = await Promise.all([
          this.state.storage.get<string>(PRINCIPAL_KEY),
          this.state.storage.getAlarm(),
          this.state.storage.get<StoredStatus>(STATUS_KEY),
        ]);
        return Response.json({
          principal: principal ?? null,
          nextAlarm: alarm == null ? null : new Date(alarm).toISOString(),
          last: last ?? null,
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    async alarm(alarmInfo?: { retryCount?: number; isRetry?: boolean }): Promise<void> {
      const retryCount = alarmInfo?.retryCount ?? 0;
      let principal: string | undefined;
      try {
        principal = await this.state.storage.get<string>(PRINCIPAL_KEY);
        if (!principal) return;
        const db = dbFor(this.env);

        const result = await runUntilIdle(
          db,
          (events, ctx) => config.handle(events, ctx, this.env),
          { principal, batchLimit, leaseMs, maxRuns, deadlineMs: runDeadlineMs },
        );

        // Schedule first, so nothing after this can strand the next wake-up.
        if (result.more) {
          await this.scheduleNoLaterThan(Date.now());
        } else {
          const next = await nextReadyAt(db, principal);
          if (next) await this.scheduleNoLaterThan(Math.max(next.getTime(), Date.now()));
        }

        await this.state.storage.put(STATUS_KEY, summarise(result, retryCount));
        await this.report(result, principal);
      } catch (err) {
        // Never throw: record the failure and retry ourselves.
        const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
        try {
          await this.scheduleNoLaterThan(Date.now() + errorBackoffMs);
        } catch { /* storage itself is down; the platform's alarm retry is the last resort */
          throw err;
        }
        try {
          await this.state.storage.put(STATUS_KEY, failedStatus(message, retryCount));
        } catch { /* best effort */ }
      }
    }

    private async report(result: RunUntilIdleResult, principal: string): Promise<void> {
      if (!config.onResult) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => config.onResult!({ ...result, principal }, this.env)),
          new Promise<void>(resolve => { timer = setTimeout(resolve, onResultTimeoutMs); }),
        ]);
      } catch { /* reporting must not break the runner */ } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /** Set the alarm to `at` unless one is already set earlier. Returns the alarm time in effect. */
    private async scheduleNoLaterThan(at: number): Promise<number> {
      const existing = await this.state.storage.getAlarm();
      if (existing != null && existing <= at) return existing;
      await this.state.storage.setAlarm(at);
      return at;
    }
  };
}

function summarise(result: RunUntilIdleResult, retryCount: number): StoredStatus {
  const total = (key: 'claimed' | 'done' | 'retried' | 'failed' | 'deferred' | 'lost' | 'settleErrors' | 'exhausted') =>
    result.runs.reduce((n, r) => n + r[key], 0);
  return {
    at: new Date().toISOString(),
    ok: true,
    runs: result.runs.filter(r => r.claimed > 0).length,
    claimed: total('claimed'),
    done: total('done'),
    retried: total('retried'),
    failed: total('failed'),
    deferred: total('deferred'),
    lost: total('lost'),
    settleErrors: total('settleErrors'),
    exhausted: total('exhausted'),
    more: result.more,
    errors: result.runs.flatMap(r => (r.error ? [r.error] : [])).slice(0, 5),
    retryCount,
  };
}

function failedStatus(message: string, retryCount: number): StoredStatus {
  return {
    at: new Date().toISOString(), ok: false, runs: 0, claimed: 0, done: 0, retried: 0, failed: 0, deferred: 0,
    lost: 0, settleErrors: 0, exhausted: 0, more: false, errors: [message], retryCount,
  };
}

/** Wake the principal's runner. Call after enqueueEvent(); cheap and idempotent. */
export async function notifyRunner(namespace: DurableObjectNamespace, principalInput?: string): Promise<void> {
  const principal = normalizePrincipal(principalInput);
  const stub = namespace.get(namespace.idFromName(principal));
  const res = await stub.fetch('https://agent-runner/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal }),
  });
  if (!res.ok) throw new Error(`notifyRunner: ${res.status} ${await res.text()}`);
}

/**
 * enqueueEvent + notifyRunner. The principal is validated before anything is
 * written. A duplicate still notifies (harmless), so a redelivery after a
 * lost notify gets the event moving.
 */
export async function enqueueAndNotify(
  db: D1Database,
  namespace: DurableObjectNamespace,
  input: EnqueueEventInput,
): Promise<EnqueueEventResult> {
  const principal = normalizePrincipal(input.principal);
  const result = await enqueueEvent(db, { ...input, principal });
  await notifyRunner(namespace, principal);
  return result;
}
