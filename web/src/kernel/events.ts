// --- Agent events: the durable event inbox (aegis-oss#100) ---
//
// Every source of work (chat, webhooks, timers, approvals, other agents)
// calls enqueueEvent() and returns. It never starts a run itself. One runner
// per principal then calls claimBatch(), does the work in a single run, and
// settles each event with completeEvent(), failEvent() or deferEvent().
//
// Guarantees:
// - Dedup: (source, source_id) is unique. A redelivered webhook is a no-op.
// - Atomic claim: one UPDATE ... RETURNING statement, so two runners can't
//   claim the same row.
// - Crash replay: a claim older than claimTimeoutMs is reclaimed. After
//   maxAttempts claims the event fails instead of looping.
// - Fencing: settling needs the claim_id the run got, so a run that lost its
//   claim to a reclaim can't overwrite the newer run's result.

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
  claimId: string | null;
  claimedAt: string | null;
  availableAt: string;
  runId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueEventInput {
  source: string;
  kind: string;
  payload?: unknown;
  /** ID the source gives this delivery. Same (source, sourceId) twice is a duplicate. */
  sourceId?: string | null;
  /** Defaults to 'operator'. */
  principal?: string;
  /** Not claimable before this time. Defaults to now. */
  availableAt?: Date;
}

export interface EnqueueEventResult {
  id: string;
  duplicate: boolean;
}

export interface ClaimOptions {
  principal?: string;
  /** Max events in one run. Default 20. */
  limit?: number;
  /** A claim older than this is treated as a crashed run. Default 10 min. */
  claimTimeoutMs?: number;
  /** Claims allowed before the event fails. Default 3. */
  maxAttempts?: number;
  now?: Date;
}

export interface ClaimedBatch {
  claimId: string;
  events: AgentEvent[];
  /** Stale events that hit maxAttempts and were failed by this call. */
  exhausted: number;
}

export interface FailOptions {
  /** Put the event back for another attempt (if attempts remain). Default true. */
  retry?: boolean;
  /** Delay before the retry is claimable. Default 30 s × attempts. */
  retryDelayMs?: number;
  maxAttempts?: number;
  runId?: string;
  now?: Date;
}

export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_PRINCIPAL = 'operator';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 30 * 1000;
const MAX_ERROR_CHARS = 1000;

interface EventRow {
  id: string;
  principal: string;
  source: string;
  source_id: string | null;
  kind: string;
  payload: string;
  status: AgentEventStatus;
  attempts: number;
  claim_id: string | null;
  claimed_at: string | null;
  available_at: string;
  run_id: string | null;
  error: string | null;
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
    claimId: row.claim_id,
    claimedAt: row.claimed_at,
    availableAt: row.available_at,
    runId: row.run_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireText(value: string | undefined | null, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`agent event: ${field} is required`);
  return trimmed;
}

function iso(date: Date): string {
  return date.toISOString();
}

/** Insert an event. Returns the existing ID with duplicate: true if (source, sourceId) is already queued. */
export async function enqueueEvent(db: D1Database, input: EnqueueEventInput, now: Date = new Date()): Promise<EnqueueEventResult> {
  const source = requireText(input.source, 'source');
  const kind = requireText(input.kind, 'kind');
  const principal = input.principal?.trim() || DEFAULT_PRINCIPAL;
  const sourceId = input.sourceId?.trim() || null;
  const payload = JSON.stringify(input.payload ?? {});
  if (new TextEncoder().encode(payload).length > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error(`agent event: payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
  }
  const id = crypto.randomUUID();
  const ts = iso(now);
  const availableAt = iso(input.availableAt ?? now);

  const inserted = await db.prepare(
    `INSERT INTO agent_events (id, principal, source, source_id, kind, payload, status, attempts, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT (source, source_id) DO NOTHING
     RETURNING id`,
  ).bind(id, principal, source, sourceId, kind, payload, availableAt, ts, ts).first<{ id: string }>();

  if (inserted) return { id: inserted.id, duplicate: false };

  const existing = await db.prepare(
    'SELECT id FROM agent_events WHERE source = ? AND source_id = ?',
  ).bind(source, sourceId).first<{ id: string }>();
  if (!existing) throw new Error('agent event: insert returned no row and no duplicate was found');
  return { id: existing.id, duplicate: true };
}

/**
 * Claim up to `limit` ready events for one principal, oldest first.
 * Pending events whose available_at has passed are claimable, and so are
 * claims older than claimTimeoutMs (a crashed run). Stale claims that have
 * already used maxAttempts are failed instead of reclaimed.
 */
export async function claimBatch(db: D1Database, options: ClaimOptions = {}): Promise<ClaimedBatch> {
  const principal = options.principal?.trim() || DEFAULT_PRINCIPAL;
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const now = options.now ?? new Date();
  const ts = iso(now);
  const staleBefore = iso(new Date(now.getTime() - (options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS)));
  const claimId = crypto.randomUUID();

  const exhaustedResult = await db.prepare(
    `UPDATE agent_events
       SET status = 'failed', error = 'claim timed out after max attempts', claim_id = NULL, updated_at = ?
     WHERE principal = ? AND status = 'claimed' AND claimed_at < ? AND attempts >= ?`,
  ).bind(ts, principal, staleBefore, maxAttempts).run();

  const claimed = await db.prepare(
    `UPDATE agent_events
       SET status = 'claimed', claim_id = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?
     WHERE id IN (
       SELECT id FROM agent_events
        WHERE principal = ?
          AND ((status = 'pending' AND available_at <= ?)
            OR (status = 'claimed' AND claimed_at < ? AND attempts < ?))
        ORDER BY created_at, id
        LIMIT ?
     )
     RETURNING *`,
  ).bind(claimId, ts, ts, principal, ts, staleBefore, maxAttempts, limit).all<EventRow>();

  const events = (claimed.results ?? [])
    .map(rowToEvent)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)));

  return { claimId, events, exhausted: exhaustedResult.meta?.changes ?? 0 };
}

async function settle(db: D1Database, sql: string, bindings: unknown[]): Promise<boolean> {
  const result = await db.prepare(sql).bind(...bindings).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Mark a claimed event done. Returns false if this claim no longer holds it. */
export async function completeEvent(db: D1Database, id: string, claimId: string, opts: { runId?: string; now?: Date } = {}): Promise<boolean> {
  return settle(db,
    `UPDATE agent_events SET status = 'done', run_id = ?, error = NULL, claim_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
    [opts.runId ?? null, iso(opts.now ?? new Date()), id, claimId]);
}

/**
 * Mark a claimed event failed. With retry (the default) and attempts left,
 * it goes back to pending after a backoff; otherwise it fails for good.
 * Returns false if this claim no longer holds it.
 */
export async function failEvent(db: D1Database, id: string, claimId: string, error: string, opts: FailOptions = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const message = (error || 'unknown error').slice(0, MAX_ERROR_CHARS);
  const ts = iso(now);

  if (opts.retry !== false) {
    const row = await db.prepare(
      "SELECT attempts FROM agent_events WHERE id = ? AND status = 'claimed' AND claim_id = ?",
    ).bind(id, claimId).first<{ attempts: number }>();
    if (!row) return false;
    if (row.attempts < maxAttempts) {
      const delay = opts.retryDelayMs ?? DEFAULT_RETRY_BASE_MS * row.attempts;
      return settle(db,
        `UPDATE agent_events SET status = 'pending', available_at = ?, error = ?, run_id = ?, claim_id = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
        [iso(new Date(now.getTime() + delay)), message, opts.runId ?? null, ts, id, claimId]);
    }
  }

  return settle(db,
    `UPDATE agent_events SET status = 'failed', error = ?, run_id = ?, claim_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
    [message, opts.runId ?? null, ts, id, claimId]);
}

/**
 * Park a claimed event while the run waits on something outside it, such as
 * an operator approval. The answer arrives as a new event; the parked one
 * stays as the record. Returns false if this claim no longer holds it.
 */
export async function deferEvent(db: D1Database, id: string, claimId: string, opts: { runId?: string; reason?: string; now?: Date } = {}): Promise<boolean> {
  return settle(db,
    `UPDATE agent_events SET status = 'deferred', run_id = ?, error = ?, claim_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_id = ?`,
    [opts.runId ?? null, opts.reason?.slice(0, MAX_ERROR_CHARS) ?? null, iso(opts.now ?? new Date()), id, claimId]);
}

/** Count pending (ready or backing off) and claimed events for a principal, e.g. for /health or a runner's alarm. */
export async function countOpenEvents(db: D1Database, principal: string = DEFAULT_PRINCIPAL): Promise<{ pending: number; claimed: number }> {
  const result = await db.prepare(
    `SELECT status, COUNT(*) AS n FROM agent_events
      WHERE principal = ? AND status IN ('pending', 'claimed')
      GROUP BY status`,
  ).bind(principal).all<{ status: string; n: number }>();
  const counts = { pending: 0, claimed: 0 };
  for (const row of result.results ?? []) {
    if (row.status === 'pending') counts.pending = Number(row.n);
    if (row.status === 'claimed') counts.claimed = Number(row.n);
  }
  return counts;
}
