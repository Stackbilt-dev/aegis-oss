// Approving a proposed task keeps it isolated.
// Approval used to rewrite authority to 'operator', so the local task runner
// ran approved work -- often from untrusted issue bodies -- in the operator's
// own checkout with no branch or PR, and nothing marked it as untrusted
// afterwards. Approval now records approved_at/approved_by and keeps
// 'proposed'. Runs the real cc_tasks schema and migration on SQLite.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { ccTasks } from '../src/routes/cc-tasks.js';
import * as handlers from '../src/mcp/handlers.js';
import { runTaskExecutorDispatch } from '../src/factory/dispatch.js';
import { CCTaskContract } from '../src/contracts/cc-task.contract.js';
import { TASK_RUNNABLE_SQL, TASK_AWAITING_APPROVAL_SQL } from '../src/schema-enums.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const SCHEMA = read('../schema.sql');
const CC_TASKS_DDL = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS cc_tasks'), SCHEMA.indexOf(');', SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS cc_tasks')) + 2);

function d1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        first: async () => (sqlite.prepare(sql).get(...(args as never[])) ?? null),
        all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
        run: async () => {
          const r = sqlite.prepare(sql).run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

let sqlite: DatabaseSync;
let db: D1Database;
const insert = (id: string, authority: string, extra: Record<string, unknown> = {}) => {
  const row = { id, title: `task ${id}`, repo: 'demo', prompt: 'do it', authority, category: 'docs', ...extra };
  const cols = Object.keys(row);
  sqlite.prepare(`INSERT INTO cc_tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as never[]));
};
const task = (id: string) => sqlite.prepare('SELECT authority, approved_at, approved_by, status FROM cc_tasks WHERE id = ?').get(id) as Record<string, unknown>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(CC_TASKS_DDL);
  db = d1(sqlite);
});

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { (c.env as any) = { DB: db, AEGIS_TOKEN: 't' }; await next(); });
  a.route('/', ccTasks);
  return a;
}
const post = (path: string) => app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

describe('migration 0002', () => {
  it('adds approved_at/approved_by to a pre-0.11.0 cc_tasks table', () => {
    const old = new DatabaseSync(':memory:');
    old.exec(CC_TASKS_DDL.replace(/,\s*approved_at TEXT[^\n]*\n\s*approved_by TEXT[^\n]*\n/, '\n'));
    expect((old.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('cc_tasks') WHERE name LIKE 'approved_%'").get() as { n: number }).n).toBe(0);
    old.exec(read('../migrations/0002_cc_tasks_approval.sql'));
    expect((old.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('cc_tasks') WHERE name LIKE 'approved_%'").get() as { n: number }).n).toBe(2);
  });
});

describe('approval keeps the task proposed', () => {
  it('REST approve records who and when; the task stays proposed; a second approve is refused', async () => {
    insert('t1', 'proposed');
    expect((await post('/api/cc-tasks/t1/approve')).status).toBe(200);
    expect(task('t1')).toMatchObject({ authority: 'proposed', approved_by: 'rest', status: 'pending' });
    expect(task('t1').approved_at).toBeTruthy();
    expect((await post('/api/cc-tasks/t1/approve')).status).toBe(404);
  });

  it('MCP approve and batch approve do the same, and never touch other authorities', async () => {
    insert('m1', 'proposed'); insert('m2', 'proposed'); insert('m3', 'proposed'); insert('op', 'operator'); insert('safe', 'auto_safe');
    await handlers.toolAegisApproveCcTask({ id: 'm1' }, { db } as any);
    await handlers.toolAegisBatchApprove({ ids: 'all' }, { db } as any);
    for (const id of ['m1', 'm2', 'm3']) expect(task(id)).toMatchObject({ authority: 'proposed', approved_by: 'mcp' });
    expect(task('op')).toMatchObject({ authority: 'operator', approved_at: null });
    expect(task('safe')).toMatchObject({ authority: 'auto_safe', approved_at: null });
  });

  it('reject still cancels a proposed task', async () => {
    insert('r1', 'proposed');
    expect((await post('/api/cc-tasks/r1/reject')).status).toBe(200);
    expect(task('r1').status).toBe('cancelled');
  });
});

describe('what runs, and where', () => {
  it('the task queue hands out an approved proposed task, never an unapproved one', async () => {
    insert('p1', 'proposed');
    const none = await app().request('/api/cc-tasks/next');
    expect(await none.json()).toMatchObject({ id: null });
    await post('/api/cc-tasks/p1/approve');
    const next = await (await app().request('/api/cc-tasks/next')).json() as { id: string; authority: string };
    // authority 'proposed' reaches the runner, which isolates every non-operator task
    expect(next).toMatchObject({ id: 'p1', authority: 'proposed' });
  });

  it('the sandbox dispatcher picks up an approved proposed task, not an unapproved one', async () => {
    const fetches: string[] = [];
    const env = { db, taskExecutor: { idFromName: () => 'id', get: () => ({ fetch: async (r: Request) => { fetches.push(r.url); return Response.json({ dispatched: true, taskId: 's1' }); } }) } };
    insert('s1', 'proposed', { executor: 'do_sandbox' });
    await runTaskExecutorDispatch(env as any);
    expect(fetches).toEqual([]);
    await post('/api/cc-tasks/s1/approve');
    await runTaskExecutorDispatch(env as any);
    expect(fetches).toEqual(['https://internal/run']);
  });

  it('the shared SQL splits tasks the same way everywhere', () => {
    insert('a', 'proposed'); insert('b', 'proposed', { approved_at: '2026-10-16 00:00:00' }); insert('c', 'auto_safe'); insert('d', 'operator');
    const ids = (where: string) => (sqlite.prepare(`SELECT id FROM cc_tasks WHERE ${where} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    expect(ids(TASK_AWAITING_APPROVAL_SQL)).toEqual(['a']);
    expect(ids(TASK_RUNNABLE_SQL)).toEqual(['b', 'c', 'd']);
  });

  it('the task summary lists only tasks still awaiting approval as proposed', async () => {
    insert('w1', 'proposed'); insert('w2', 'proposed', { approved_at: '2026-10-16 00:00:00' });
    const out = await handlers.toolAegisTaskSummary({ db } as any);
    const parsed = JSON.parse(out.content[0].text as string);
    expect(parsed.proposed.tasks.map((t: { id: string }) => t.id)).toEqual(['w1']);
    expect(parsed.pending.tasks.map((t: { id: string }) => t.id)).toEqual(['w2']);
  });
});

describe('contract invariant', () => {
  const inv = CCTaskContract.invariants.find((i) => i.name === 'proposed_task_needs_approval')!;
  it('flags a running proposed task only when it was never approved', () => {
    expect(inv.check({ authority: 'proposed', status: 'running', approvedAt: null })).not.toBe(true);
    expect(inv.check({ authority: 'proposed', status: 'running', approvedAt: '2026-10-16T00:00:00Z' })).toBe(true);
  });
});

describe('reject', () => {
  it('cancels an approved task that has not started, and refuses a running one', async () => {
    insert('r1', 'proposed', { approved_at: '2026-10-16 00:00:00', approved_by: 'rest' });
    expect((await post('/api/cc-tasks/r1/reject')).status).toBe(200);
    expect(task('r1').status).toBe('cancelled');
    insert('r2', 'proposed', { status: 'running', approved_at: '2026-10-16 00:00:00' });
    expect((await post('/api/cc-tasks/r2/reject')).status).toBe(404);
  });
});
