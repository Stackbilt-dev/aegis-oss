// --- Agent runner loop (aegis-oss#100) ---
//
// Drains one principal's event inbox (kernel/events.ts): claim a batch, hand
// it to the consumer's handler as one run, keep the lease alive while the
// handler works, then settle each event from the handler's outcome.
// The Durable Object wrapper (durable-objects/agent-runner.ts) decides when
// to call this; this module holds no Durable Object code so it can be tested
// on its own. See docs/agent-events.md#runner.

import {
  claimBatch,
  renewClaim,
  completeEvent,
  failEvent,
  deferEvent,
  DEFAULT_LEASE_MS,
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
  claimId: string;
  /** Unique per run; recorded on every event the run settles. */
  runId: string;
  /** Aborted when the run has lost its lease on every event. Stop side effects. */
  signal: AbortSignal;
  /** Extend the lease now. Returns how many events this run still holds. Auto-renewal also runs. */
  renew(): Promise<number>;
}

/**
 * Handles one batch as one run. Return:
 * - nothing: every event is done;
 * - one RunOutcome: applies to every event;
 * - a map of event id → RunOutcome: per event. An event missing from the
 *   map is retried, so a handler that forgets one doesn't drop it.
 * Throwing retries every event with the error message.
 */
export type BatchHandler = (
  events: AgentEvent[],
  ctx: RunContext,
) => Promise<void | RunOutcome | Record<string, RunOutcome>>;

export interface DrainOptions {
  principal?: string;
  /** Max events per run. Default 20. */
  batchLimit?: number;
  /** Lease per claim. Default 10 min; renewed every leaseMs / 3 while the handler runs. */
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
  /** Lapsed claims with no attempts left, failed while claiming. */
  exhausted: number;
  /** Set when the handler threw. */
  error?: string;
}

const MAX_ERROR_CHARS = 1000;

function isOutcome(value: unknown): value is RunOutcome {
  return typeof value === 'object' && value !== null && typeof (value as { status?: unknown }).status === 'string';
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS) || 'handler threw';
}

/** Claim one batch, run the handler once, settle every event. claimed = 0 means the inbox had nothing ready. */
export async function drainOnce(db: D1Database, handler: BatchHandler, options: DrainOptions = {}): Promise<DrainSummary> {
  const principal = options.principal?.trim() || 'operator';
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const batch = await claimBatch(db, { principal, limit: options.batchLimit, leaseMs });
  const summary: DrainSummary = {
    runId: null, claimed: batch.events.length, done: 0, retried: 0, failed: 0, deferred: 0, lost: 0, exhausted: batch.exhausted,
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

  let result: Awaited<ReturnType<BatchHandler>> = undefined;
  let thrown: string | undefined;
  try {
    result = await handler(batch.events, { principal, claimId: batch.claimId, runId, signal: controller.signal, renew });
  } catch (err) {
    thrown = errorText(err);
  } finally {
    clearInterval(timer);
  }

  for (const event of batch.events) {
    let outcome: RunOutcome;
    if (thrown !== undefined) {
      outcome = { status: 'retry', error: thrown };
    } else if (result === undefined) {
      outcome = { status: 'done' };
    } else if (isOutcome(result)) {
      outcome = result;
    } else {
      outcome = result[event.id] ?? { status: 'retry', error: 'handler returned no outcome for this event' };
    }

    let settled: boolean;
    switch (outcome.status) {
      case 'done':
        settled = await completeEvent(db, event.id, batch.claimId, { runId });
        if (settled) summary.done++;
        break;
      case 'retry':
        settled = await failEvent(db, event.id, batch.claimId, outcome.error, { runId, retryDelayMs: outcome.retryDelayMs });
        if (settled) {
          // failEvent decides retry vs. final failure from the event's own attempts.
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
      default:
        settled = await failEvent(db, event.id, batch.claimId, `unknown outcome status: ${String((outcome as { status: unknown }).status)}`, { runId });
        if (settled) summary.retried++;
    }
    if (!settled) summary.lost++;
  }

  if (thrown !== undefined) summary.error = thrown;
  return summary;
}

export interface RunUntilIdleResult {
  runs: DrainSummary[];
  /** True when maxRuns was reached with events still being claimed; wake again soon. */
  more: boolean;
}

/** Run drainOnce until the inbox has nothing ready, at most maxRuns times (default 5). */
export async function runUntilIdle(
  db: D1Database,
  handler: BatchHandler,
  options: DrainOptions & { maxRuns?: number } = {},
): Promise<RunUntilIdleResult> {
  const maxRuns = Math.max(1, Math.floor(options.maxRuns ?? 5));
  const runs: DrainSummary[] = [];
  for (let i = 0; i < maxRuns; i++) {
    const summary = await drainOnce(db, handler, options);
    if (summary.claimed === 0) {
      if (summary.exhausted > 0) runs.push(summary);
      return { runs, more: false };
    }
    runs.push(summary);
  }
  return { runs, more: true };
}
