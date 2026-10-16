// PR auto-merge CI gate: fail closed.
// GitHub Actions results come from the Checks API, not commit statuses. The
// old gate read only the combined status, which is "pending" with zero
// statuses on an Actions-only repo, and treated that as "no CI configured"
// -- so a PR whose checks all failed could be auto-merged.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ciVerdict, runPrAutomerge } from '../src/kernel/scheduled/pr-automerge.js';

const noStatuses = { total: 0, statuses: [] };
const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });

describe('ciVerdict', () => {
  it('refuses when there is no CI at all', () => {
    expect(ciVerdict(noStatuses, { total: 0, runs: [] })).toEqual({ ok: false, reason: 'no CI statuses or check runs on head commit' });
  });

  it('refuses a failed check run even when legacy statuses are empty (the old hole)', () => {
    const v = ciVerdict(noStatuses, { total: 1, runs: [run('typecheck', 'completed', 'failure')] });
    expect(v.ok).toBe(false);
  });

  it('waits for in-progress check runs', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('test', 'in_progress', null)] }).ok).toBe(false);
  });

  it('refuses a failed or pending legacy status', () => {
    expect(ciVerdict({ total: 1, statuses: [{ context: 'ci', state: 'failure' }] }, { total: 0, runs: [] }).ok).toBe(false);
    expect(ciVerdict({ total: 1, statuses: [{ context: 'ci', state: 'pending' }] }, { total: 0, runs: [] }).ok).toBe(false);
  });

  it('refuses when not every check run could be read', () => {
    expect(ciVerdict(noStatuses, { total: 150, runs: [run('a', 'completed', 'success')] }).ok).toBe(false);
  });

  it('passes when every status and check run succeeded (skipped and neutral allowed)', () => {
    expect(ciVerdict(
      { total: 1, statuses: [{ context: 'ci', state: 'success' }] },
      { total: 3, runs: [run('a', 'completed', 'success'), run('b', 'completed', 'skipped'), run('c', 'completed', 'neutral')] },
    )).toEqual({ ok: true });
  });
});

describe('runPrAutomerge end to end (mocked GitHub)', () => {
  const HEAD_SHA = 'abc123def456';
  let merges: Array<Record<string, unknown>>;
  let checkRuns: unknown;
  let mergeable: boolean | null;

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  function env() {
    const updates: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => ({
            results: sql.includes('FROM cc_tasks')
              ? [{ id: 'task-1234abcd', title: 'docs: fix typo', repo: 'demo', category: 'docs', pr_url: 'https://github.com/ExampleOrg/demo/pull/7' }]
              : [],
          }),
          run: async () => { updates.push(args); return { success: true }; },
        }),
      }),
    };
    return { env: { githubToken: 'test-token', db } as never, updates };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z')); // even hour: the task runs
    merges = [];
    mergeable = true;
    checkRuns = { total_count: 1, check_runs: [run('typecheck', 'completed', 'success')] };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/pulls/7')) {
        return json({ number: 7, state: 'open', mergeable, additions: 3, deletions: 1, changed_files: 1, head: { ref: 'auto/task1234', sha: HEAD_SHA }, base: { ref: 'main' } });
      }
      if (u.endsWith('/pulls/7/files?per_page=100') || u.includes('/pulls/7/files')) return json([{ filename: 'docs/readme.md' }]);
      if (u.includes(`/commits/${HEAD_SHA}/status`)) return json({ state: 'pending', total_count: 0, statuses: [] });
      if (u.includes(`/commits/${HEAD_SHA}/check-runs`)) return json(checkRuns);
      if (u.endsWith('/pulls/7/merge') && init?.method === 'PUT') {
        merges.push(JSON.parse(String(init.body)));
        return json({ sha: 'merged-sha', merged: true, message: 'Pull Request successfully merged' });
      }
      return new Response('not mocked: ' + u, { status: 404 });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not merge an Actions-only PR whose check failed', async () => {
    checkRuns = { total_count: 1, check_runs: [run('typecheck', 'completed', 'failure')] };
    const { env: e, updates } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('does not merge a PR with no CI at all', async () => {
    checkRuns = { total_count: 0, check_runs: [] };
    const { env: e } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
  });

  it('does not merge while GitHub has not computed mergeability', async () => {
    mergeable = null;
    const { env: e } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
  });

  it('merges a green PR, pinned to the head commit that was checked', async () => {
    const { env: e, updates } = env();
    await runPrAutomerge(e);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ merge_method: 'squash', sha: HEAD_SHA });
    expect(updates).toEqual([['https://github.com/ExampleOrg/demo/pull/7/merged', 'task-1234abcd']]);
  });
});
