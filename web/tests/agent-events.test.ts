import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSqliteD1 } from './helpers/sqlite-d1.js';
import {
  enqueueEvent, claimBatch, renewClaim, completeEvent, failEvent, deferEvent, countOpenEvents,
  MAX_EVENT_PAYLOAD_BYTES, DEFAULT_LEASE_MS,
} from '../src/kernel/events.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = read('../migrations/0002_agent_events.sql');
const SCHEMA = read('../schema.sql');

const T0 = new Date('2026-11-16T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const SEC = 1000;
const MIN = 60 * SEC;

let db: D1Database;

function row(id: string) {
  return (db as any).raw.prepare('SELECT * FROM agent_events WHERE id = ?').get(id);
}

/** Every agent_events statement (table + indexes), whitespace-normalised. */
function agentEventsDdl(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  return withoutComments
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => /^CREATE (TABLE|INDEX) IF NOT EXISTS \w+( ON)? ?agent_events\b/.test(s) || /^CREATE TABLE IF NOT EXISTS agent_events\b/.test(s));
}

beforeEach(() => {
  // Build from the full schema.sql, which also proves it applies.
  db = createSqliteD1(SCHEMA);
});

describe('schema', () => {
  it('schema.sql and the migration declare identical agent_events DDL', () => {
    const fromSchema = agentEventsDdl(SCHEMA);
    expect(fromSchema.length).toBe(4); // table + 3 indexes
    expect(fromSchema).toEqual(agentEventsDdl(MIGRATION));
  });

  it('the migration applies on its own', () => {
    const fresh = createSqliteD1(MIGRATION);
    expect((fresh as any).raw.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_events'").get()).toBeTruthy();
  });
});

describe('enqueueEvent', () => {
  it('inserts a pending event with defaults', async () => {
    const res = await enqueueEvent(db, { source: 'chat', kind: 'user_message', payload: { text: 'hi' } }, T0);
    expect(res.duplicate).toBe(false);
    const r = row(res.id);
    expect(r).toMatchObject({ principal: 'operator', source: 'chat', kind: 'user_message', status: 'pending', attempts: 0, max_attempts: 3 });
    expect(JSON.parse(r.payload)).toEqual({ text: 'hi' });
    expect(r.available_at).toBe(T0.toISOString());
  });

  it('dedups on (principal, source, source_id) and returns the existing id', async () => {
    const a = await enqueueEvent(db, { source: 'github', sourceId: 'delivery-1', kind: 'webhook' }, T0);
    const b = await enqueueEvent(db, { source: 'github', sourceId: 'delivery-1', kind: 'webhook' }, T0);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect((await countOpenEvents(db)).pending).toBe(1);
  });

  it('does not dedup the same source id across principals', async () => {
    const alice = await enqueueEvent(db, { source: 'telegram', sourceId: '42', kind: 'user_message', principal: 'alice' }, T0);
    const bob = await enqueueEvent(db, { source: 'telegram', sourceId: '42', kind: 'user_message', principal: 'bob', payload: { b: 1 } }, T0);
    expect(bob.duplicate).toBe(false);
    expect(bob.id).not.toBe(alice.id);
    expect((await countOpenEvents(db, 'bob')).pending).toBe(1);
    expect(JSON.parse(row(bob.id).payload)).toEqual({ b: 1 });
  });

  it('does not dedup across sources or when source_id is absent', async () => {
    await enqueueEvent(db, { source: 'github', sourceId: 'x', kind: 'webhook' }, T0);
    const other = await enqueueEvent(db, { source: 'stripe', sourceId: 'x', kind: 'webhook' }, T0);
    const n1 = await enqueueEvent(db, { source: 'chat', kind: 'user_message' }, T0);
    const n2 = await enqueueEvent(db, { source: 'chat', kind: 'user_message', sourceId: '  ' }, T0);
    expect([other.duplicate, n1.duplicate, n2.duplicate]).toEqual([false, false, false]);
    expect((await countOpenEvents(db)).pending).toBe(4);
  });

  it('stays a duplicate after the first copy is done (dedup is for the life of the row)', async () => {
    const a = await enqueueEvent(db, { source: 'github', sourceId: 'd1', kind: 'webhook' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    await completeEvent(db, a.id, batch.claimId);
    expect(await enqueueEvent(db, { source: 'github', sourceId: 'd1', kind: 'webhook' }, at(MIN))).toEqual({ id: a.id, duplicate: true });
    expect(row(a.id).status).toBe('done');
  });

  it('accepts a payload of exactly the limit and rejects one byte more', async () => {
    const exact = 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES - 2); // JSON adds two quotes
    await expect(enqueueEvent(db, { source: 's', kind: 'k', payload: exact })).resolves.toMatchObject({ duplicate: false });
    await expect(enqueueEvent(db, { source: 's', kind: 'k', payload: exact + 'x' })).rejects.toThrow(/payload exceeds/);
  });

  it('stores null as null, and rejects payloads JSON cannot represent', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k', payload: null }, T0);
    expect(row(id).payload).toBe('null');
    await expect(enqueueEvent(db, { source: 's', kind: 'k', payload: () => 1 })).rejects.toThrow(/not JSON-serialisable/);
    await expect(enqueueEvent(db, { source: 's', kind: 'k', payload: Symbol('x') })).rejects.toThrow(/not JSON-serialisable/);
  });

  it('validates source, kind, maxAttempts and dates', async () => {
    await expect(enqueueEvent(db, { source: ' ', kind: 'k' })).rejects.toThrow(/source is required/);
    await expect(enqueueEvent(db, { source: 's', kind: '' })).rejects.toThrow(/kind is required/);
    await expect(enqueueEvent(db, { source: 's', kind: 'k', maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
    await expect(enqueueEvent(db, { source: 's', kind: 'k', maxAttempts: NaN })).rejects.toThrow(/maxAttempts/);
    await expect(enqueueEvent(db, { source: 's', kind: 'k', availableAt: new Date('nope') })).rejects.toThrow(/availableAt/);
  });
});

describe('claimBatch', () => {
  it('claims all ready events for one principal in one batch, oldest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await enqueueEvent(db, { source: 'chat', kind: 'user_message', payload: { i } }, at(i * SEC))).id);
    }
    await enqueueEvent(db, { source: 'chat', kind: 'user_message', principal: 'someone-else' }, T0);

    const batch = await claimBatch(db, { now: at(5 * SEC) });
    expect(batch.events.map(e => e.id)).toEqual(ids);
    expect(batch.leaseUntil).toBe(at(5 * SEC + DEFAULT_LEASE_MS).toISOString());
    expect(batch.events.every(e => e.status === 'claimed' && e.claimId === batch.claimId && e.attempts === 1 && e.leaseUntil === batch.leaseUntil)).toBe(true);
    expect(batch.events[0].payload).toEqual({ i: 0 });

    expect((await claimBatch(db, { now: at(6 * SEC) })).events).toHaveLength(0);
    expect((await countOpenEvents(db, 'someone-else')).pending).toBe(1);
  });

  it('respects limit and available_at', async () => {
    for (let i = 0; i < 5; i++) await enqueueEvent(db, { source: 's', kind: 'k' }, at(i));
    await enqueueEvent(db, { source: 's', kind: 'later', availableAt: at(10 * MIN) }, T0);
    expect((await claimBatch(db, { limit: 2, now: at(SEC), leaseMs: 60 * MIN })).events).toHaveLength(2);
    expect((await claimBatch(db, { now: at(SEC), leaseMs: 60 * MIN })).events).toHaveLength(3);
    const later = await claimBatch(db, { now: at(11 * MIN) });
    expect(later.events.map(e => e.kind)).toEqual(['later']);
  });

  it('rejects non-finite or out-of-range options', async () => {
    await expect(claimBatch(db, { limit: NaN })).rejects.toThrow(/limit/);
    await expect(claimBatch(db, { limit: 0 })).rejects.toThrow(/limit/);
    await expect(claimBatch(db, { leaseMs: NaN })).rejects.toThrow(/leaseMs/);
    await expect(claimBatch(db, { now: new Date('nope') })).rejects.toThrow(/now/);
  });

  it('reclaims a lapsed lease (crashed run) and fences the old claim out', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const first = await claimBatch(db, { now: T0 });
    expect((await claimBatch(db, { now: at(5 * MIN) })).events).toHaveLength(0);

    const second = await claimBatch(db, { now: at(11 * MIN) });
    expect(second.events.map(e => e.id)).toEqual([id]);
    expect(second.events[0].attempts).toBe(2);

    expect(await completeEvent(db, id, first.claimId)).toBe(false);
    expect(await failEvent(db, id, first.claimId, 'late')).toBe(false);
    expect(await renewClaim(db, first.claimId, { now: at(11 * MIN) })).toBe(0);
    expect(await completeEvent(db, id, second.claimId, { runId: 'run-2' })).toBe(true);
    expect(row(id)).toMatchObject({ status: 'done', run_id: 'run-2', claim_id: null, lease_until: null });
  });

  it('a caller with a short lease cannot take events under another claim’s live lease', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const long = await claimBatch(db, { now: T0, leaseMs: 30 * MIN });
    const greedy = await claimBatch(db, { now: at(11 * MIN), leaseMs: 1 });
    expect(greedy.events).toHaveLength(0);
    expect(row(id).claim_id).toBe(long.claimId);
  });

  it('fails a lapsed claim with no attempts left (default maxAttempts = 3)', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    for (let lap = 0; lap < 3; lap++) {
      expect((await claimBatch(db, { now: at(lap * 11 * MIN) })).events).toHaveLength(1);
    }
    const fourth = await claimBatch(db, { now: at(33 * MIN) });
    expect(fourth.events).toHaveLength(0);
    expect(fourth.exhausted).toBe(1);
    expect(row(id)).toMatchObject({ status: 'failed', attempts: 3, error: 'lease lapsed with no attempts left' });
  });
});

describe('renewClaim', () => {
  it('keeps a long run’s events past the original lease', async () => {
    for (let i = 0; i < 3; i++) await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    expect(await renewClaim(db, batch.claimId, { now: at(8 * MIN) })).toBe(3);
    expect((await claimBatch(db, { now: at(15 * MIN) })).events).toHaveLength(0);
    expect((await claimBatch(db, { now: at(19 * MIN) })).events).toHaveLength(3);
  });

  it('counts only events the claim still holds', async () => {
    const a = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    await completeEvent(db, a.id, batch.claimId);
    expect(await renewClaim(db, batch.claimId, { now: at(MIN) })).toBe(1);
    expect(await renewClaim(db, 'unknown-claim', { now: at(MIN) })).toBe(0);
  });
});

describe('settling', () => {
  it('failEvent backs off 30 s × attempts by default', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    let batch = await claimBatch(db, { now: T0 });
    await failEvent(db, id, batch.claimId, 'boom', { now: T0 });
    expect(row(id).available_at).toBe(at(30 * SEC).toISOString());

    batch = await claimBatch(db, { now: at(30 * SEC) });
    await failEvent(db, id, batch.claimId, 'boom', { now: at(30 * SEC) });
    expect(row(id).available_at).toBe(at(90 * SEC).toISOString());
  });

  it('uses the event’s own max_attempts for retries', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k', maxAttempts: 5 }, T0);
    let now = T0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const batch = await claimBatch(db, { now });
      expect(batch.events[0].attempts).toBe(attempt);
      await failEvent(db, id, batch.claimId, `fail ${attempt}`, { now, retryDelayMs: 0 });
      expect(row(id).status).toBe('pending');
    }
    const last = await claimBatch(db, { now });
    await failEvent(db, id, last.claimId, 'fail 5', { now, retryDelayMs: 0 });
    expect(row(id)).toMatchObject({ status: 'failed', attempts: 5, error: 'fail 5' });
  });

  it('failEvent with retry: false fails immediately', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    expect(await failEvent(db, id, batch.claimId, 'bad input', { retry: false })).toBe(true);
    expect(row(id).status).toBe('failed');
  });

  it('deferEvent parks the event with its reason outside the error column', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    expect(await countOpenEvents(db)).toEqual({ pending: 0, claimed: 1, deferred: 0 });
    expect(await deferEvent(db, id, batch.claimId, { runId: 'r1', reason: 'awaiting approval' })).toBe(true);
    expect(row(id)).toMatchObject({ status: 'deferred', run_id: 'r1', defer_reason: 'awaiting approval', error: null, lease_until: null });
    expect(await countOpenEvents(db)).toEqual({ pending: 0, claimed: 0, deferred: 1 });
    expect((await claimBatch(db, { now: at(60 * MIN) })).events).toHaveLength(0);
  });

  it('settling with a wrong claim id or an unclaimed event is refused', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    expect(await completeEvent(db, id, 'nope')).toBe(false);
    expect(await failEvent(db, id, 'nope', 'x')).toBe(false);
    expect(await deferEvent(db, id, 'nope')).toBe(false);
    expect(row(id).status).toBe('pending');
  });
});

describe('sqlite-d1 shim', () => {
  it('rejects undefined binds like D1', async () => {
    expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow(/D1_TYPE_ERROR/);
  });
});
