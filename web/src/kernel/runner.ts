// --- Agent runner loop (aegis-oss#100) ---
//
// Drains one principal's event inbox (kernel/events.ts): claim a batch, hand
// it to the consumer's handler as one run, keep the lease alive while the
// handler works, then settle each event from the handler's outcome.
// The Durable Object wrapper (durable-objects/agent-runner.ts) decides when
// to call this; this module holds no Durable Object code so it can be tested
// on its own. See docs/agent-events.md#runner.
//
// The runner owns settling. A handler must not call completeEvent /
// failEvent / deferEvent itself; it returns outcomes instead.

import {
  claimBatch,
  renewClaim,
  completeEvent,
  failEvent,
  deferEvent,
  normalizePrincipal,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  type AgentEvent,
} from './events.js';

/** What happened to one event in a run. */
export type RunOutcome =
  | { status: 'done' }
  /** Try again later (counts as an attempt; fails once max_attempts is used). */
  | { status: 'retry'; error: string; retryDelayMs?: number }
  /** Fail now, no retry. */
  | { status: 'failed'; error: string }
  /** Park while waiting on something outside the run, e.g. an approval. */
  | { status: 'deferred'; reason: string };

export interface RunContext {
  principal: string;
  /** Unique per run; recorded on every event the run settles. */
  runId: string;
  /** Aborted when the run has lost its lease on every event. Stop side effects. */
  signal: AbortSignal;
  /** Extend the lease now. Returns how many events this run still holds. Auto-renewal also runs. */
  renew(): Promise<number>;
}

/**
 * Handles one batch as one run. Return:
 * - nothing (undefined or null): every event is done;
 * - one RunOutcome: applies to every event;
 * - a map of event id → RunOutcome: per event. An event missing from the
 *   map, or mapped to something that isn't a valid outcome, is retried.
 * Throwing, or returning anything else, retries every event.
 */
export type BatchHandler = (
  events: AgentEvent[],
  ctx: RunContext,
) => Promise<void | null | RunOutcome | Record<string, RunOutcome>>;

export interface DrainOptions {
  principal?: string;
  /** Max events per run. Default 20. */
  batchLimit?: number;
  /** Lease per claim, 1 ms–24 h. Default 10 min; renewed every leaseMs / 3 while the handler runs. */
  leaseMs?: number;
}

export interface DrainSummary {
  runId: string | null;
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  deferred: number;
  /** Settles refused because the run no longer held the event (lease lost). */
  lost: number;
  /** Settles that threw (e.g. D1 unavailable); those events stay claimed until their lease lapses. */
  settleErrors: number;
  /** Lapsed claims with no attempts left, failed while claiming. */
  exhausted: number;
  /** Set when the handler threw or returned an invalid result, or a settle threw. */
  error?: string;
}

const MAX_ERROR_CHARS = 1000;
const OUTCOME_STATUSES = new Set(['done', 'retry', 'failed', 'deferred']);

function isOutcome(value: unknown): value is RunOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.status !== 'string' || !OUTCOME_STATUSES.has(v.status)) return false;
  if ((v.status === 'retry' || v.status === 'failed') && typeof v.error !== 'string') return false;
  if (v.status === 'deferred' && typeof v.reason !== 'string') return false;
  return true;
}

function looksLikeOutcome(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'status' in value;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS) || 'handler threw';
}

/** Validate and clamp a lease the same way claimBatch does, so the renew interval matches the real lease. */
export function normalizeLeaseMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error('agent runner: leaseMs must be a finite number >= 1');
  }
  return Math.min(Math.floor(value), MAX_LEASE_MS);
}

/**
 * Turn whatever the handler returned into one outcome per event.
 * Runs inside the handler's error boundary, so a bad result never escapes.
 */
function resolveOutcomes(events: AgentEvent[], result: unknown): Map<string, RunOutcome> {
  const outcomes = new Map<string, RunOutcome>();
  const all = (outcome: RunOutcome) => { for (const e of events) outcomes.set(e.id, outcome); };

  if (result === undefined || result === null) {
    all({ status: 'done' });
  } else if (looksLikeOutcome(result)) {
    all(isOutcome(result) ? result : { status: 'retry', error: 'handler returned an invalid outcome' });
  } else if (typeof result === 'object' && !Array.isArray(result)) {
    const map = result as Record<string, unknown>;
    for (const e of events) {
      const value = map[e.id];
      if (value === undefined) outcomes.set(e.id, { status: 'retry', error: 'handler returned no outcome for this event' });
      else if (isOutcome(value)) outcomes.set(e.id, value);
      else outcomes.set(e.id, { status: 'retry', error: 'handler returned an invalid outcome for this event' });
    }
  } else {
    all({ status: 'retry', error: `handler returned an invalid result (${Array.isArray(result) ? 'array' : typeof result})` });
  }
  return outcomes;
}

/** Claim one batch, run the handler once, settle every event. claimed = 0 means the inbox had nothing ready. */
export async function drainOnce(db: D1Database, handler: BatchHandler, options: DrainOptions = {}): Promise<DrainSummary> {
  const principal = normalizePrincipal(options.principal);
  const leaseMs = normalizeLeaseMs(options.leaseMs);
  const batch = await claimBatch(db, { principal, limit: options.batchLimit, leaseMs });
  const summary: DrainSummary = {
    runId: null, claimed: batch.events.length, done: 0, retried: 0, failed: 0, deferred: 0,
    lost: 0, settleErrors: 0, exhausted: batch.exhausted,
  };
  if (batch.events.length === 0) return summary;

  const runId = crypto.randomUUID();
  summary.runId = runId;
  const controller = new AbortController();
  const renew = async () => {
    const held = await renewClaim(db, batch.claimId, { leaseMs });
    if (held === 0) controller.abort(new Error('lease lost'));
    return held;
  };
  const timer = setInterval(() => {
    renew().catch(() => { /* next tick retries; a lapse shows up as lost settles */ });
  }, Math.max(1, Math.floor(leaseMs / 3)));

  let outcomes: Map<string, RunOutcome>;
  const errors: string[] = [];
  try {
    const result = await handler(batch.events, { principal, runId, signal: controller.signal, renew });
    outcomes = resolveOutcomes(batch.events, result);
    const invalid = [...outcomes.values()].find(o => o.status === 'retry' && o.error.startsWith('handler returned an invalid'));
    if (invalid && invalid.status === 'retry') errors.push(invalid.error);
  } catch (err) {
    const message = errorText(err);
    errors.push(message);
    outcomes = new Map(batch.events.map(e => [e.id, { status: 'retry', error: message } as RunOutcome]));
  } finally {
    clearInterval(timer);
  }

  for (const event of batch.events) {
    const outcome = outcomes.get(event.id) ?? { status: 'retry', error: 'handler returned no outcome for this event' };
    try {
      let settled: boolean;
      switch (outcome.status) {
        case 'done':
          settled = await completeEvent(db, event.id, batch.claimId, { runId });
          if (settled) summary.done++;
          break;
        case 'retry':
          settled = await failEvent(db, event.id, batch.claimId, outcome.error, { runId, retryDelayMs: outcome.retryDelayMs });
          // failEvent decides retry vs. final failure from the event's own attempts.
          if (settled) {
            if (event.attempts < event.maxAttempts) summary.retried++;
            else summary.failed++;
          }
          break;
        case 'failed':
          settled = await failEvent(db, event.id, batch.claimId, outcome.error, { runId, retry: false });
          if (settled) summary.failed++;
          break;
        case 'deferred':
          settled = await deferEvent(db, event.id, batch.claimId, { runId, reason: outcome.reason });
          if (settled) summary.deferred++;
          break;
      }
      if (!settled) summary.lost++;
    } catch (err) {
      // Keep settling the rest; this event stays claimed and is reclaimed when its lease lapses.
      summary.settleErrors++;
      if (summary.settleErrors === 1) errors.push(`settle failed: ${errorText(err)}`);
    }
  }

  if (errors.length > 0) summary.error = errors.join('; ').slice(0, MAX_ERROR_CHARS);
  return summary;
}

export interface RunUntilIdleOptions extends DrainOptions {
  /** Max runs before returning. Default 5. */
  maxRuns?: number;
  /**
   * Don't start another run after this many ms have passed. A run already
   * started is not interrupted. Default: no deadline. The Durable Object
   * passes one so a wake-up stays inside the platform's alarm time limit.
   */
  deadlineMs?: number;
}

export interface RunUntilIdleResult {
  runs: DrainSummary[];
  /** True when maxRuns or the deadline stopped it with work possibly left; wake again soon. */
  more: boolean;
}

/** Run drainOnce until the inbox has nothing ready, at most maxRuns times or until deadlineMs. */
export async function runUntilIdle(
  db: D1Database,
  handler: BatchHandler,
  options: RunUntilIdleOptions = {},
): Promise<RunUntilIdleResult> {
  const maxRuns = Math.max(1, Math.floor(options.maxRuns ?? 5));
  const stopAt = options.deadlineMs !== undefined ? Date.now() + Math.max(0, options.deadlineMs) : Infinity;
  const runs: DrainSummary[] = [];
  for (let i = 0; i < maxRuns; i++) {
    if (i > 0 && Date.now() >= stopAt) return { runs, more: true };
    const summary = await drainOnce(db, handler, options);
    if (summary.claimed === 0) {
      if (summary.exhausted > 0) runs.push(summary);
      return { runs, more: false };
    }
    runs.push(summary);
  }
  return { runs, more: true };
}
