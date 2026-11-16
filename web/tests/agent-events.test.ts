import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSqliteD1 } from './helpers/sqlite-d1.js';
import {
  enqueueEvent, claimBatch, completeEvent, failEvent, deferEvent, countOpenEvents,
  MAX_EVENT_PAYLOAD_BYTES,
} from '../src/kernel/events.js';

const MIGRATION = readFileSync(fileURLToPath(new URL('../migrations/0002_agent_events.sql', import.meta.url)), 'utf8');
const SCHEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');

const T0 = new Date('2026-11-16T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

let db: D1Database;

function row(id: string) {
  return (db as any).raw.prepare('SELECT * FROM agent_events WHERE id = ?').get(id);
}

beforeEach(() => {
  db = createSqliteD1(MIGRATION);
});

describe('schema', () => {
  it('schema.sql carries the same agent_events DDL as the migration', () => {
    const ddl = (sql: string) => sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS agent_events')).trim();
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS agent_events');
    expect(ddl(SCHEMA)).toBe(ddl(MIGRATION));
  });
});

describe('enqueueEvent', () => {
  it('inserts a pending event with defaults', async () => {
    const res = await enqueueEvent(db, { source: 'chat', kind: 'user_message', payload: { text: 'hi' } }, T0);
    expect(res.duplicate).toBe(false);
    const r = row(res.id);
    expect(r).toMatchObject({ principal: 'operator', source: 'chat', kind: 'user_message', status: 'pending', attempts: 0 });
    expect(JSON.parse(r.payload)).toEqual({ text: 'hi' });
    expect(r.available_at).toBe(T0.toISOString());
  });

  it('dedups on (source, source_id) and returns the existing id', async () => {
    const a = await enqueueEvent(db, { source: 'github', sourceId: 'delivery-1', kind: 'webhook' }, T0);
    const b = await enqueueEvent(db, { source: 'github', sourceId: 'delivery-1', kind: 'webhook' }, T0);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(await countOpenEvents(db)).toEqual({ pending: 1, claimed: 0 });
  });

  it('does not dedup across sources or when source_id is absent', async () => {
    await enqueueEvent(db, { source: 'github', sourceId: 'x', kind: 'webhook' }, T0);
    const other = await enqueueEvent(db, { source: 'stripe', sourceId: 'x', kind: 'webhook' }, T0);
    const n1 = await enqueueEvent(db, { source: 'chat', kind: 'user_message' }, T0);
    const n2 = await enqueueEvent(db, { source: 'chat', kind: 'user_message' }, T0);
    expect([other.duplicate, n1.duplicate, n2.duplicate]).toEqual([false, false, false]);
    expect((await countOpenEvents(db)).pending).toBe(4);
  });

  it('rejects missing source/kind and oversized payloads', async () => {
    await expect(enqueueEvent(db, { source: ' ', kind: 'k' })).rejects.toThrow(/source is required/);
    await expect(enqueueEvent(db, { source: 's', kind: '' })).rejects.toThrow(/kind is required/);
    await expect(enqueueEvent(db, { source: 's', kind: 'k', payload: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) }))
      .rejects.toThrow(/payload exceeds/);
  });
});

describe('claimBatch', () => {
  it('claims all ready events for one principal in one batch, oldest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await enqueueEvent(db, { source: 'chat', kind: 'user_message', payload: { i } }, at(i * 1000))).id);
    }
    await enqueueEvent(db, { source: 'chat', kind: 'user_message', principal: 'someone-else' }, T0);

    const batch = await claimBatch(db, { now: at(5000) });
    expect(batch.events.map(e => e.id)).toEqual(ids);
    expect(batch.events.every(e => e.status === 'claimed' && e.claimId === batch.claimId && e.attempts === 1)).toBe(true);
    expect(batch.events[0].payload).toEqual({ i: 0 });

    const again = await claimBatch(db, { now: at(6000) });
    expect(again.events).toHaveLength(0);
    expect(await countOpenEvents(db, 'someone-else')).toEqual({ pending: 1, claimed: 0 });
  });

  it('respects limit and available_at', async () => {
    for (let i = 0; i < 5; i++) await enqueueEvent(db, { source: 's', kind: 'k' }, at(i));
    await enqueueEvent(db, { source: 's', kind: 'later', availableAt: at(10 * MIN) }, T0);
    expect((await claimBatch(db, { limit: 2, now: at(1000) })).events).toHaveLength(2);
    expect((await claimBatch(db, { now: at(1000) })).events).toHaveLength(3);
    // Long claim timeout so the five rows claimed above aren't reclaimed as stale.
    const later = await claimBatch(db, { now: at(11 * MIN), claimTimeoutMs: 60 * MIN });
    expect(later.events.map(e => e.kind)).toEqual(['later']);
  });

  it('reclaims a stale claim (crashed run) and fences the old claim out', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const first = await claimBatch(db, { now: T0 });
    expect((await claimBatch(db, { now: at(5 * MIN) })).events).toHaveLength(0);

    const second = await claimBatch(db, { now: at(11 * MIN) });
    expect(second.events.map(e => e.id)).toEqual([id]);
    expect(second.events[0].attempts).toBe(2);

    expect(await completeEvent(db, id, first.claimId)).toBe(false);
    expect(await completeEvent(db, id, second.claimId, { runId: 'run-2' })).toBe(true);
    expect(row(id)).toMatchObject({ status: 'done', run_id: 'run-2', claim_id: null });
  });

  it('fails a stale claim that has used maxAttempts instead of reclaiming it', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    await claimBatch(db, { now: T0, maxAttempts: 2 });
    await claimBatch(db, { now: at(11 * MIN), maxAttempts: 2 });
    const third = await claimBatch(db, { now: at(22 * MIN), maxAttempts: 2 });
    expect(third.events).toHaveLength(0);
    expect(third.exhausted).toBe(1);
    expect(row(id)).toMatchObject({ status: 'failed', error: 'claim timed out after max attempts' });
  });
});

describe('settling', () => {
  it('failEvent retries with backoff while attempts remain, then fails', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    let batch = await claimBatch(db, { now: T0, maxAttempts: 2 });
    expect(await failEvent(db, id, batch.claimId, 'boom', { now: T0, maxAttempts: 2, retryDelayMs: MIN })).toBe(true);
    expect(row(id)).toMatchObject({ status: 'pending', error: 'boom', claim_id: null, available_at: at(MIN).toISOString() });

    expect((await claimBatch(db, { now: at(30_000) })).events).toHaveLength(0);
    batch = await claimBatch(db, { now: at(MIN), maxAttempts: 2 });
    expect(batch.events[0].attempts).toBe(2);
    expect(await failEvent(db, id, batch.claimId, 'boom again', { now: at(MIN), maxAttempts: 2 })).toBe(true);
    expect(row(id)).toMatchObject({ status: 'failed', error: 'boom again' });
  });

  it('failEvent with retry: false fails immediately', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    expect(await failEvent(db, id, batch.claimId, 'bad input', { retry: false })).toBe(true);
    expect(row(id).status).toBe('failed');
  });

  it('deferEvent parks the event and drops it from the open counts', async () => {
    const { id } = await enqueueEvent(db, { source: 's', kind: 'k' }, T0);
    const batch = await claimBatch(db, { now: T0 });
    expect(await countOpenEvents(db)).toEqual({ pending: 0, claimed: 1 });
    expect(await deferEvent(db, id, batch.claimId, { runId: 'r1', reason: 'awaiting approval' })).toBe(true);
    expect(row(id)).toMatchObject({ status: 'deferred', run_id: 'r1', error: 'awaiting approval' });
    expect(await countOpenEvents(db)).toEqual({ pending: 0, claimed: 0 });
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
