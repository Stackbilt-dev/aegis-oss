// --- Agent events: the durable event inbox (aegis-oss#100) ---
//
// Every source of work (chat, webhooks, timers, approvals, other agents)
// calls enqueueEvent() and returns. It never starts a run itself. One runner
// per principal then calls claimBatch(), does the work in a single run, and
// settles each event with completeEvent(), failEvent() or deferEvent().
// Design and semantics: docs/agent-events.md.
//
// Guarantees:
// - Dedup: (principal, source, source_id) is unique, for the life of the row.
//   A redelivered webhook is a no-op, even after the first copy is done.
// - Atomic claim: one UPDATE ... RETURNING statement, so two runners can't
//   claim the same row at the same moment.
// - Leases: a claim holds its events until lease_until. A long run keeps them
//   with renewClaim(). A lease that runs out (a crashed run) is reclaimed.
//   Each claim sets its own lease, so one caller's lease length never
//   shortens another's.
// - Attempts: each event stores its own max_attempts. A claim that would go
//   past it fails the event instead of looping.
// - Fencing: settling and renewing need the claim_id the run got, so a run
//   that lost its lease can't overwrite the newer run's result. Fencing
//   protects the row, not side effects the old run already caused, so renew
//   the lease before it lapses.

export type AgentEventStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'deferred';

export interface AgentEvent {
  id: string;
  principal: string;
  source: string;
  sourceId: string | null;
  kind: string;
  payload: unknown;
  status: AgentEventStatus;
  attempts: number;
  maxAttempts: number;
  claimId: string | null;
  claimedAt: string | null;
  leaseUntil: string | null;
  availableAt: string;
  runId: string | null;
  error: string | null;
  deferReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueEventInput {
  source: string;
  kind: string;
  /** Any JSON-serialisable value. Defaults to {}. */
  payload?: unknown;
  /**
   * ID the source gives this delivery. The same (principal, source, sourceId)
   * twice is a duplicate, whatever the first one's status. Omit it to skip dedup.
   */
  sourceId?: string | null;
  /** Defaults to 'operator'. */
  principal?: string;
  /** Not claimable before this time. Defaults to now. */
  availableAt?: Date;
  /** Claims allowed before the event fails. Default 3, max 20. */
  maxAttempts?: number;
}

export interface EnqueueEventResult {
  id: string;
  duplicate: boolean;
}

export interface ClaimOptions {
  principal?: string;
  /** Max events in one run. Default 20, max 100. */
  limit?: number;
  /** How long this claim holds its events before they can be reclaimed. Default 10 min. */
  leaseMs?: number;
  now?: Date;
}

export interface ClaimedBatch {
  claimId: string;
  /** When this claim's lease ends unless renewed. */
  leaseUntil: string;
  events: AgentEvent[];
  /** Events whose lease lapsed with no attempts left, failed by this call. */
  exhausted: number;
}

export interface FailOptions {
  /** Put the event back for another attempt (if attempts remain). Default true. */
  retry?: boolean;
  /** Delay before the retry is claimable. Default 30 s × attempts so far. */
  retryDelayMs?: number;
  runId?: string;
  now?: Date;
}

export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_PRINCIPAL = 'operator';
/** Principal names double as the runner Durable Object name, so they are kept to a safe charset. */
export const PRINCIPAL_PATTERN = /^[\w.@:-]{1,128}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_ATTEMPTS_CAP = 20;
export const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 30 * 1000;
const MAX_TEXT_CHARS = 1000;

interface EventRow {
  id: string;
  principal: string;
  source: string;
  source_id: string | null;
  kind: string;
  payload: string;
  status: AgentEventStatus;
  attempts: number;
  max_attempts: number;
  claim_id: string | null;
  claimed_at: string | null;
  lease_until: string | null;
  available_at: string;
  run_id: string | null;
  error: string | null;
  defer_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEvent(row: EventRow): AgentEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    principal: row.principal,
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimId: row.claim_id,
    claimedAt: row.claimed_at,
    leaseUntil: row.lease_until,
    availableAt: row.available_at,
    runId: row.run_id,
    error: row.error,
    deferReason: row.defer_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireText(value: string | undefined | null, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new Error(`agent event: ${field} is required`);
  return trimmed;
}

/** A positive finite integer within [1, max], or the default when undefined. */
function boundedInt(value: number | undefined, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`agent event: ${field} must be a finite number >= 1`);
  }
  return Math.min(Math.floor(value), max);
}

function validDate(value: Date | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`agent event: ${field} must be a valid Date`);
  }
  return value;
}

/**
 * Trim a principal, default it to 'operator', and check it against
 * PRINCIPAL_PATTERN. Every inbox function and the runner use this, so an
 * event can never be stored under a name no runner accepts.
 */
export function normalizePrincipal(value: string | undefined | null): string {
  if (value == null) return DEFAULT_PRINCIPAL;
  if (typeof value !== 'string') throw new Error('agent event: principal must be a string');
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_PRINCIPAL;
  if (!PRINCIPAL_PATTERN.test(trimmed)) {
    throw new Error(`agent event: principal must match ${PRINCIPAL_PATTERN.source}`);
  }
  return trimmed;
}

function iso(date: Date): string {
  return date.toISOString();
}

function clip(text: string | undefined | null): string | null {
  return text == null ? null : text.slice(0, MAX_TEXT_CHARS);
}

/**
 * Insert an event. If (principal, source, sourceId) already exists, in any
 * status, returns that event's ID with duplicate: true and inserts nothing.
 */
export async function enqueueEvent(db: D1Database, input: EnqueueEventInput, now: Date = new Date()): Promise<EnqueueEventResult> {
  const source = requireText(input.source, 'source');
  const kind = requireText(input.kind, 'kind');
  const principal = normalizePrincipal(input.principal);
  const sourceId = typeof input.sourceId === 'string' && input.sourceId.trim() ? input.sourceId.trim() : null;
  const maxAttempts = boundedInt(input.maxAttempts, DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_CAP, 'maxAttempts');
  validDate(now, 'now');
  const availableAt = validDate(input.availableAt, 'availableAt') ?? now;

  const payload = JSON.stringify(input.payload === undefined ? {} : input.payload);
  if (typeof payload !== 'string') {
    throw new Error('agent event: payload is not JSON-serialisable');
  }
  if (new TextEncoder().encode(payload).length > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error(`agent event: payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
  }

  const id = crypto.randomUUID();
  const ts = iso(now);

  const inserted = await db.prepare(
    `INSERT INTO agent_events (id, principal, source, source_id, kind, payload, status, attempts, max_attempts, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
     ON CONFLICT (principal, source, source_id) DO NOTHING
     RETURNING id`,
  ).bind(id, principal, source, sourceId, kind, payload, maxAttempts, iso(availableAt), ts, ts).first<{ id: string }>();

  if (inserted) return { id: inserted.id, duplicate: false };

  const existing = await db.prepare(
    'SELECT id FROM agent_events WHERE principal = ? AND source = ? AND source_id = ?',
  ).bind(principal, source, sourceId).first<{ id: string }>();
  if (!existing) throw new Error('agent event: insert returned no row and no duplicate was found');
  return { id: existing.id, duplicate: true };
}

/**
 * Claim up to `limit` ready events for one principal, oldest first, and hold
 * them for `leaseMs`. Ready means pending and past available_at, or claimed
 * with a lapsed lease (a crashed or stalled run) and attempts left. Lapsed
 * claims with no attempts left are failed instead.
 */
export async function claimBatch(db: D1Database, options: ClaimOptions = {}): Promise<ClaimedBatch> {
  const principal = normalizePrincipal(options.principal);
  const limit = boundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit');
  const leaseMs = boundedInt(options.leaseMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'leaseMs');
  const now = validDate(options.now, 'now') ?? new Date();
  const ts = iso(now);
  const leaseUntil = iso(new Date(now.getTime() + leaseMs));
  const claimId = crypto.randomUUID();

  const exhaustedResult = await db.prepare(
    `UPDATE agent_events
       SET status = 'failed', error = 'lease lapsed with no attempts left',
           claim_id = NULL, lease_until = NULL, updated_at = ?
     WHERE principal = ? AND status = 'claimed' AND lease_until < ? AND attempts >= max_attempts`,
  ).bind(ts, principal, ts).run();

  const claimed = await db.prepare(
    `UPDATE agent_events
       SET status = 'claimed', claim_id = ?, claimed_at = ?, lease_until = ?,
           attempts = attempts + 1, updated_at = ?
     WHERE id IN (
       SELECT id FROM agent_events
        WHERE principal = ?
          AND attempts < max_attempts
          AND ((status = 'pending' AND available_at <= ?)
            OR (status = 'claimed' AND lease_until < ?))
        ORDER BY created_at, id
        LIMIT ?
     )
     RETURNING *`,
  ).bind(claimId, ts, leaseUntil, ts, principal, ts, ts, limit).all<EventRow>();

  const events = (claimed.results ?? [])
    .map(rowToEvent)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));

  return { claimId, leaseUntil, events, exhausted: exhaustedResult.meta?.changes ?? 0 };
}

/**
 * Extend the lease on every event this claim still holds. Call it during a
 * long run, well before leaseUntil. Returns how many events it still holds
 * (unsettled and not reclaimed). Fewer than claimed means another run took
 * some after a lapse; 0 means stop work.
 */
export async function renewClaim(db: D1Database, claimId: string, opts: { leaseMs?: number; now?: Date } = {}): Promise<number> {
  const leaseMs = boundedInt(opts.leaseMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'leaseMs');
  const now = validDate(opts.now, 'now') ?? new Date();
  const result = await db.prepare(
    `UPDATE agent_events SET lease_until = ?, updated_at = ?
      WHERE claim_id = ? AND status = 'claimed'`,
  ).bind(iso(new Date(now.getTime() + leaseMs)), iso(now), requireText(claimId, 'claimId')).run();
  return result.meta?.changes ?? 0;
}

async function settle(db: D1Database, sql: string, bindings: unknown[]): Promise<boolean> {
  const result = await db.prepare(sql).bind(...bindings).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Mark a claimed event done. Returns false if this claim no longer holds it. */
export async function completeEvent(db: D1Database, id: string, claimId: string, opts: { runId?: string; now?: Date } = {}): Promise<boolean> {
  return settle(db,
    `UPDATE agent_events SET status = 'done', run_id = ?, error = NULL, claim_id = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
    [opts.runId ?? null, iso(validDate(opts.now, 'now') ?? new Date()), id, claimId]);
}

/**
 * Mark a claimed event failed. With retry (the default) and attempts left
 * under the event's max_attempts, it goes back to pending after a backoff;
 * otherwise it fails for good. Returns false if this claim no longer holds it.
 */
export async function failEvent(db: D1Database, id: string, claimId: string, error: string, opts: FailOptions = {}): Promise<boolean> {
  const now = validDate(opts.now, 'now') ?? new Date();
  const message = clip(error || 'unknown error');
  const ts = iso(now);
  const runId = opts.runId ?? null;

  if (opts.retry !== false) {
    const row = await db.prepare(
      "SELECT attempts, max_attempts FROM agent_events WHERE id = ? AND status = 'claimed' AND claim_id = ?",
    ).bind(id, claimId).first<{ attempts: number; max_attempts: number }>();
    if (!row) return false;
    if (row.attempts < row.max_attempts) {
      const delay = opts.retryDelayMs !== undefined
        ? Math.max(0, Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 0)
        : DEFAULT_RETRY_BASE_MS * row.attempts;
      return settle(db,
        `UPDATE agent_events
            SET status = 'pending', available_at = ?, error = ?, run_id = ?,
                claim_id = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
        [iso(new Date(now.getTime() + delay)), message, runId, ts, id, claimId]);
    }
  }

  return settle(db,
    `UPDATE agent_events SET status = 'failed', error = ?, run_id = ?, claim_id = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
    [message, runId, ts, id, claimId]);
}

/**
 * Park a claimed event while the run waits on something outside it, such as
 * an operator approval. The answer arrives as a new event; the parked one
 * stays as the record, with its reason in defer_reason. Resuming is #100
 * step 2. Returns false if this claim no longer holds it.
 */
export async function deferEvent(db: D1Database, id: string, claimId: string, opts: { runId?: string; reason?: string; now?: Date } = {}): Promise<boolean> {
  return settle(db,
    `UPDATE agent_events SET status = 'deferred', run_id = ?, defer_reason = ?, claim_id = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
    [opts.runId ?? null, clip(opts.reason), iso(validDate(opts.now, 'now') ?? new Date()), id, claimId]);
}

/** Open events for a principal by status, e.g. for /health or a runner's alarm. */
export async function countOpenEvents(db: D1Database, principalInput?: string): Promise<{ pending: number; claimed: number; deferred: number }> {
  const principal = normalizePrincipal(principalInput);
  const result = await db.prepare(
    `SELECT status, COUNT(*) AS n FROM agent_events
      WHERE principal = ? AND status IN ('pending', 'claimed', 'deferred')
      GROUP BY status`,
  ).bind(principal).all<{ status: string; n: number }>();
  const counts = { pending: 0, claimed: 0, deferred: 0 };
  for (const row of result.results ?? []) {
    if (row.status === 'pending' || row.status === 'claimed' || row.status === 'deferred') {
      counts[row.status] = Number(row.n);
    }
  }
  return counts;
}

/**
 * When the next event for a principal could become claimable: the earliest
 * pending available_at or claimed lease_until. null when nothing is open.
 * A runner uses it to set its next wake-up.
 */
export async function nextReadyAt(db: D1Database, principalInput?: string): Promise<Date | null> {
  const principal = normalizePrincipal(principalInput);
  const row = await db.prepare(
    `SELECT MIN(t) AS next FROM (
       SELECT MIN(available_at) AS t FROM agent_events WHERE principal = ? AND status = 'pending'
       UNION ALL
       SELECT MIN(lease_until) AS t FROM agent_events WHERE principal = ? AND status = 'claimed'
     )`,
  ).bind(principal, principal).first<{ next: string | null }>();
  return row?.next ? new Date(row.next) : null;
}
