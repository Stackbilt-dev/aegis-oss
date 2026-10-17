// Approved proposed tasks: the sandbox claim runs them, the views stop
// listing them as awaiting approval, and the admission rules still treat
// them as proposed. Runs the full schema.sql on SQLite.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claimNextSandboxTask } from '../src/factory/claim.js';
import { acceptanceAdmissionError, parseAcceptanceSpec } from '../src/factory/acceptance.js';
import { generateBriefing } from '../src/kernel/briefing.js';
import { digestTasks } from '../src/kernel/scheduled/digest.js';
import { getDashboardData } from '../src/dashboard.js';

const SCHEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');

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
const APPROVED = { approved_at: '2026-10-16 00:00:00', approved_by: 'mcp' };

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  db = d1(sqlite);
});

describe('sandbox claim', () => {
  it('claims an approved proposed task and never one awaiting approval', async () => {
    insert('waiting', 'proposed', { executor: 'do_sandbox', priority: 1 });
    insert('approved', 'proposed', { executor: 'do_sandbox', priority: 2, ...APPROVED });
    const claimed = await claimNextSandboxTask(db);
    expect(claimed?.id).toBe('approved');
    expect(claimed?.authority).toBe('proposed');
    expect(await claimNextSandboxTask(db)).toBeNull();
    const status = (id: string) => (sqlite.prepare('SELECT status FROM cc_tasks WHERE id = ?').get(id) as { status: string }).status;
    expect(status('waiting')).toBe('pending');
    expect(status('approved')).toBe('running');
  });

  it('claims auto_safe and operator tasks but not other executors', async () => {
    insert('local', 'operator', { executor: 'claude_code', priority: 1 });
    insert('safe', 'auto_safe', { executor: 'do_sandbox', priority: 2 });
    expect((await claimNextSandboxTask(db))?.id).toBe('safe');
    expect(await claimNextSandboxTask(db)).toBeNull();
  });
});

describe('acceptance admission', () => {
  const none = parseAcceptanceSpec('do it');
  it('requires a block for auto_safe and proposed tasks, approved or not', () => {
    expect(acceptanceAdmissionError(none, 'auto_safe')).toMatch(/must declare/);
    expect(acceptanceAdmissionError(none, 'proposed')).toMatch(/proposed do_sandbox tasks must declare/);
  });
  it('lets operator tasks run without one', () => {
    expect(acceptanceAdmissionError(none, 'operator')).toBeNull();
  });
});

describe('awaiting-approval views', () => {
  beforeEach(() => {
    insert('waiting', 'proposed', { title: 'still waiting' });
    insert('approved', 'proposed', { title: 'already approved', ...APPROVED });
  });

  it('the briefing asks only about the task still awaiting approval', async () => {
    // The briefing also reads two tables schema.sql doesn't create.
    sqlite.exec('CREATE TABLE events (ts TEXT); CREATE TABLE digest_sections (section TEXT, payload TEXT, created_at TEXT)');
    const briefing = await generateBriefing({ db } as any);
    const ask = briefing.decisions.find((d) => d.includes('awaiting approval'));
    expect(ask).toContain('still waiting');
    expect(ask).not.toContain('already approved');
    expect(ask).toMatch(/^1 proposed task /);
  });

  it('the digest lists only the task still awaiting approval', async () => {
    const { proposedTasks } = await digestTasks(db, '2000-01-01T00:00:00Z');
    expect(proposedTasks.map((t) => t.id)).toEqual(['waiting']);
  });

  it('the dashboard counts only the task still awaiting approval and marks the approved one', async () => {
    const data = await getDashboardData(db);
    expect(data.tasks.proposed).toBe(1);
    const approved = data.tasks.recent.find((t) => t.id === 'approved');
    expect(approved?.approved_at).toBe(APPROVED.approved_at);
  });
});
