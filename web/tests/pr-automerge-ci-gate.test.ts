// PR auto-merge CI gate: fail closed.
// GitHub Actions results come from the Checks API, not commit statuses. The
// old gate read only the combined status, which is "pending" with zero
// statuses on an Actions-only repo, and treated that as "no CI configured"
// -- so a PR whose checks all failed could be auto-merged. Without branch
// protection, the operator config names the checks each repo must pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ciVerdict, runPrAutomerge } from '../src/kernel/scheduled/pr-automerge.js';
import { operatorConfig, setOperatorConfig } from '../src/operator/index.js';

const noStatuses = { total: 0, statuses: [] };
const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
const REQ = ['typecheck'];

describe('ciVerdict', () => {
  it('refuses a repo with no required checks configured, even when everything is green', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('typecheck', 'completed', 'success')] }, []))
      .toEqual({ ok: false, reason: 'no required checks configured for this repo' });
  });

  it('refuses when the required check has not reported yet, even if another check is green', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('lint', 'completed', 'success')] }, REQ))
      .toEqual({ ok: false, reason: 'required check typecheck has not passed' });
    expect(ciVerdict({ total: 1, statuses: [{ context: 'deploy-preview', state: 'success' }] }, { total: 0, runs: [] }, REQ).ok).toBe(false);
  });

  it('refuses a required check that was skipped or neutral', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('typecheck', 'completed', 'skipped')] }, REQ).ok).toBe(false);
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('typecheck', 'completed', 'neutral')] }, REQ).ok).toBe(false);
  });

  it('refuses a failed check run even when legacy statuses are empty (the old hole)', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('typecheck', 'completed', 'failure')] }, REQ).ok).toBe(false);
  });

  it('refuses when any other check failed or is still running', () => {
    const ok = run('typecheck', 'completed', 'success');
    expect(ciVerdict(noStatuses, { total: 2, runs: [ok, run('test', 'completed', 'failure')] }, REQ).ok).toBe(false);
    expect(ciVerdict(noStatuses, { total: 2, runs: [ok, run('test', 'in_progress', null)] }, REQ).ok).toBe(false);
    expect(ciVerdict({ total: 1, statuses: [{ context: 'ci', state: 'pending' }] }, { total: 1, runs: [ok] }, REQ).ok).toBe(false);
  });

  it('refuses when not every check run or status could be read (pagination)', () => {
    const ok = run('typecheck', 'completed', 'success');
    expect(ciVerdict(noStatuses, { total: 150, runs: [ok] }, REQ).ok).toBe(false);
    const thirty = Array.from({ length: 30 }, (_, i) => ({ context: `s${i}`, state: 'success' }));
    expect(ciVerdict({ total: 31, statuses: thirty }, { total: 1, runs: [ok] }, REQ))
      .toEqual({ ok: false, reason: 'too many commit statuses to verify (31)' });
  });

  it('accepts a required check reported as a commit status', () => {
    expect(ciVerdict({ total: 1, statuses: [{ context: 'typecheck', state: 'success' }] }, { total: 0, runs: [] }, REQ)).toEqual({ ok: true });
  });

  it('passes when every required check succeeded and the rest passed (skipped extras allowed)', () => {
    expect(ciVerdict(
      { total: 1, statuses: [{ context: 'ci', state: 'success' }] },
      { total: 3, runs: [run('typecheck', 'completed', 'success'), run('b', 'completed', 'skipped'), run('c', 'completed', 'neutral')] },
      REQ,
    )).toEqual({ ok: true });
  });
});

describe('runPrAutomerge end to end (mocked GitHub)', () => {
  const HEAD_SHA = 'abc123def456';
  const original = operatorConfig;
  let merges: Array<Record<string, unknown>>;
  let checkRuns: unknown;
  let mergeable: boolean | null;
  let logs: string[];

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

  function requireChecks(map: Record<string, string[]>) {
    setOperatorConfig({
      ...original,
      integrations: { ...original.integrations, github: { ...original.integrations.github, automerge: { requiredChecks: map } } },
    } as never);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z')); // even hour: the task runs
    merges = [];
    logs = [];
    mergeable = true;
    checkRuns = { total_count: 1, check_runs: [run('typecheck', 'completed', 'success')] };
    requireChecks({ 'ExampleOrg/demo': ['typecheck'] });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logs.push('WARN ' + a.join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/pulls/7')) {
        return json({ number: 7, state: 'open', mergeable, additions: 3, deletions: 1, changed_files: 1, head: { ref: 'auto/task1234', sha: HEAD_SHA }, base: { ref: 'main' } });
      }
      if (u.includes('/pulls/7/files')) return json([{ filename: 'docs/readme.md' }]);
      if (u.includes(`/commits/${HEAD_SHA}/status?per_page=100`)) return json({ state: 'pending', total_count: 0, statuses: [] });
      if (u.includes(`/commits/${HEAD_SHA}/check-runs`)) return json(checkRuns);
      if (u.endsWith('/pulls/7/merge') && init?.method === 'PUT') {
        merges.push(JSON.parse(String(init.body)));
        return json({ sha: 'merged-sha', merged: true, message: 'Pull Request successfully merged' });
      }
      return new Response('not mocked: ' + u, { status: 404 });
    }));
  });

  afterEach(() => {
    setOperatorConfig(original as never);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const skipped = (reason: string) => logs.some((l) => l.includes('Skipped ExampleOrg/demo#7') && l.includes(reason));

  it('does not merge an Actions-only PR whose required check failed', async () => {
    checkRuns = { total_count: 1, check_runs: [run('typecheck', 'completed', 'failure')] };
    const { env: e, updates } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
    expect(updates).toEqual([]);
    expect(skipped('required check typecheck has not passed')).toBe(true);
  });

  it('does not merge while only some other check has reported', async () => {
    checkRuns = { total_count: 1, check_runs: [run('lint', 'completed', 'success')] };
    const { env: e } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
    expect(skipped('required check typecheck has not passed')).toBe(true);
  });

  it('does not merge a repo with no required checks configured', async () => {
    requireChecks({});
    const { env: e } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
    expect(skipped('no required checks configured')).toBe(true);
  });

  it('does not merge while GitHub has not computed mergeability', async () => {
    mergeable = null;
    const { env: e } = env();
    await runPrAutomerge(e);
    expect(merges).toEqual([]);
    expect(skipped('mergeability not computed yet')).toBe(true);
  });

  it('merges a green PR, pinned to the head commit that was checked', async () => {
    const { env: e, updates } = env();
    await runPrAutomerge(e);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ merge_method: 'squash', sha: HEAD_SHA });
    expect(updates).toEqual([['https://github.com/ExampleOrg/demo/pull/7/merged', 'task-1234abcd']]);
    expect(logs.some((l) => l.startsWith('WARN'))).toBe(false);
  });
});
