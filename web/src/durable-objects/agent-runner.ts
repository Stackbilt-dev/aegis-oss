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
// Durable Objects are declared by class name in wrangler, so configuration
// is baked into the class:
//   export const AgentRunnerDO = createAgentRunnerDO({ handle: async (events, ctx, env) => { ... } });
//
// HTTP surface (internal; reach it through notifyRunner / a stub):
//   POST /notify  {"principal": "..."}  — schedule a run
//   GET  /status                          — principal, next alarm, last result

import { enqueueEvent, nextReadyAt, type AgentEvent, type EnqueueEventInput, type EnqueueEventResult } from '../kernel/events.js';
import { runUntilIdle, type RunContext, type RunOutcome, type RunUntilIdleResult } from '../kernel/runner.js';

export interface AgentRunnerConfig<E> {
  /** Run one batch. Same contract as BatchHandler in kernel/runner.ts, plus the Worker env. */
  handle(events: AgentEvent[], ctx: RunContext, env: E): Promise<void | RunOutcome | Record<string, RunOutcome>>;
  /** Where the agent_events table lives. Default env.DB. */
  db?(env: E): D1Database;
  /** Delay from the first notify to the run, to batch bursts. Default 2 s. */
  debounceMs?: number;
  /** Max events per run. Default 20. */
  batchLimit?: number;
  /** Lease per claim. Default 10 min. */
  leaseMs?: number;
  /** Runs per alarm before yielding; more work reschedules immediately. Default 5. */
  maxRunsPerAlarm?: number;
  /** Called with each alarm's result, e.g. for logging. Errors are ignored. */
  onResult?(result: RunUntilIdleResult & { principal: string }, env: E): void | Promise<void>;
}

interface StoredStatus {
  at: string;
  runs: number;
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  deferred: number;
  lost: number;
  exhausted: number;
  more: boolean;
  errors: string[];
}

const DEFAULT_DEBOUNCE_MS = 2000;
const PRINCIPAL_KEY = 'principal';
const STATUS_KEY = 'last_result';
const PRINCIPAL_RE = /^[\w.@:-]{1,128}$/;

export function createAgentRunnerDO<E extends { DB?: D1Database } = { DB: D1Database }>(config: AgentRunnerConfig<E>) {
  const debounceMs = Math.max(0, config.debounceMs ?? DEFAULT_DEBOUNCE_MS);
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
        if (typeof principal !== 'string' || !PRINCIPAL_RE.test(principal)) {
          return Response.json({ error: 'principal must match ' + PRINCIPAL_RE.source }, { status: 400 });
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

    async alarm(): Promise<void> {
      const principal = await this.state.storage.get<string>(PRINCIPAL_KEY);
      if (!principal) return;
      const db = dbFor(this.env);

      const result = await runUntilIdle(
        db,
        (events, ctx) => config.handle(events, ctx, this.env),
        { principal, batchLimit: config.batchLimit, leaseMs: config.leaseMs, maxRuns: config.maxRunsPerAlarm },
      );

      await this.state.storage.put(STATUS_KEY, summarise(result));
      if (config.onResult) {
        try {
          await config.onResult({ ...result, principal }, this.env);
        } catch { /* reporting must not break the runner */ }
      }

      if (result.more) {
        await this.scheduleNoLaterThan(Date.now());
        return;
      }
      const next = await nextReadyAt(db, principal);
      if (next) await this.scheduleNoLaterThan(Math.max(next.getTime(), Date.now()));
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

function summarise(result: RunUntilIdleResult): StoredStatus {
  const total = (key: 'claimed' | 'done' | 'retried' | 'failed' | 'deferred' | 'lost' | 'exhausted') =>
    result.runs.reduce((n, r) => n + r[key], 0);
  return {
    at: new Date().toISOString(),
    runs: result.runs.filter(r => r.claimed > 0).length,
    claimed: total('claimed'),
    done: total('done'),
    retried: total('retried'),
    failed: total('failed'),
    deferred: total('deferred'),
    lost: total('lost'),
    exhausted: total('exhausted'),
    more: result.more,
    errors: result.runs.flatMap(r => (r.error ? [r.error] : [])).slice(0, 5),
  };
}

/** Wake the principal's runner. Call after enqueueEvent(); cheap and idempotent. */
export async function notifyRunner(namespace: DurableObjectNamespace, principal: string = 'operator'): Promise<void> {
  const stub = namespace.get(namespace.idFromName(principal));
  const res = await stub.fetch('https://agent-runner/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ principal }),
  });
  if (!res.ok) throw new Error(`notifyRunner: ${res.status} ${await res.text()}`);
}

/**
 * enqueueEvent + notifyRunner. A duplicate still notifies (harmless), so a
 * redelivery after a lost notify gets the event moving.
 */
export async function enqueueAndNotify(
  db: D1Database,
  namespace: DurableObjectNamespace,
  input: EnqueueEventInput,
): Promise<EnqueueEventResult> {
  const result = await enqueueEvent(db, input);
  await notifyRunner(namespace, input.principal?.trim() || 'operator');
  return result;
}
