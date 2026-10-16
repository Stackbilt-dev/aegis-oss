// PR ready flag: label green autonomous-task PRs for a human merge; never merge.
// Replaces PR auto-merge (0.10.0). The old gate read only the legacy
// combined-status API -- "pending" with zero statuses on an Actions-only repo
// -- and treated that as "no CI", so failed PRs could be merged.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ciVerdict, runPrReadyFlag, READY_LABEL } from '../src/kernel/scheduled/pr-ready.js';
import { operatorConfig, setOperatorConfig } from '../src/operator/index.js';

const noStatuses = { total: 0, statuses: [] };
const run = (name: string, status: string, conclusion: string | null, app: string | null = 'github-actions') => ({ name, status, conclusion, app });
const green = run('typecheck', 'completed', 'success');

describe('ciVerdict', () => {
  it('needs at least one successful GitHub Actions check run (the old hole: no CI passed)', () => {
    expect(ciVerdict(noStatuses, { total: 0, runs: [] }, [])).toEqual({ ok: false, reason: 'no successful GitHub Actions check run on head commit' });
    expect(ciVerdict({ total: 1, statuses: [{ context: 'ci', state: 'success' }] }, { total: 0, runs: [] }, []).ok).toBe(false);
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('x', 'completed', 'success', 'other-app')] }, []).ok).toBe(false);
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('x', 'completed', 'skipped')] }, []).ok).toBe(false);
  });

  it('refuses a failed or unfinished check, and a non-success status', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [run('typecheck', 'completed', 'failure')] }, []).ok).toBe(false);
    expect(ciVerdict(noStatuses, { total: 2, runs: [green, run('test', 'in_progress', null)] }, []).ok).toBe(false);
    expect(ciVerdict({ total: 1, statuses: [{ context: 'ci', state: 'pending' }] }, { total: 1, runs: [green] }, []).ok).toBe(false);
  });

  it('requires each configured check as a successful GitHub Actions run', () => {
    expect(ciVerdict(noStatuses, { total: 1, runs: [green] }, ['test'])).toEqual({ ok: false, reason: 'required check test has not passed' });
    expect(ciVerdict(noStatuses, { total: 2, runs: [green, run('test', 'completed', 'skipped')] }, ['test']).ok).toBe(false);
    expect(ciVerdict({ total: 1, statuses: [{ context: 'test', state: 'success' }] }, { total: 1, runs: [green] }, ['test']).ok).toBe(false);
  });

  it('refuses to judge a partial list (pagination)', () => {
    expect(ciVerdict(noStatuses, { total: 150, runs: [green] }, []).ok).toBe(false);
    const thirty = Array.from({ length: 30 }, (_, i) => ({ context: `s${i}`, state: 'success' }));
    expect(ciVerdict({ total: 31, statuses: thirty }, { total: 1, runs: [green] }, [])).toEqual({ ok: false, reason: 'too many commit statuses to verify (31)' });
  });

  it('passes when everything passed (extra skipped/neutral runs allowed)', () => {
    expect(ciVerdict({ total: 1, statuses: [{ context: 'ci', state: 'success' }] },
      { total: 3, runs: [green, run('b', 'completed', 'skipped'), run('c', 'completed', 'neutral')] }, [])).toEqual({ ok: true });
  });
});

describe('runPrReadyFlag (mocked GitHub)', () => {
  const HEAD_SHA = 'abc123def456';
  const original = operatorConfig;
  let pr: Record<string, unknown>;
  let checkRuns: { total_count: number; check_runs: ReturnType<typeof run>[] };
  let calls: { url: string; method: string; body?: unknown }[];
  let logs: string[];
  let sqls: string[];

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  function env() {
    const updates: unknown[][] = [];
    const db = {
      prepare: (sql: string) => {
        sqls.push(sql);
        return {
          bind: (...args: unknown[]) => ({
            all: async () => ({ results: [{ id: 'task-1234abcd', title: 'docs: fix typo', pr_url: 'https://github.com/ExampleOrg/demo/pull/7' }] }),
            run: async () => { updates.push(args); return { success: true }; },
          }),
        };
      },
    };
    return { env: { githubToken: 'test-token', db } as never, updates };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T22:00:00Z'));
    calls = []; logs = []; sqls = [];
    pr = {
      number: 7, state: 'open', mergeable: true, additions: 3, deletions: 1, changed_files: 1,
      head: { ref: 'auto/task1234', sha: HEAD_SHA, repo: { full_name: 'ExampleOrg/demo' } },
      base: { ref: 'main', repo: { default_branch: 'main' } },
    };
    checkRuns = { total_count: 1, check_runs: [green] };
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logs.push('WARN ' + a.join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.endsWith('/pulls/7') && method === 'GET') return json(pr);
      if (u.includes(`/commits/${HEAD_SHA}/status?per_page=100`)) return json({ state: 'pending', total_count: 0, statuses: [] });
      if (u.includes(`/commits/${HEAD_SHA}/check-runs`)) {
        return json({ ...checkRuns, check_runs: checkRuns.check_runs.map((r) => ({ ...r, app: r.app ? { slug: r.app } : null })) });
      }
      if (u.endsWith('/issues/7/labels') && method === 'POST') return json([{ name: READY_LABEL }]);
      return new Response('not mocked: ' + u, { status: 404 });
    }));
  });

  afterEach(() => {
    setOperatorConfig(original as never);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const labelled = () => calls.some((c) => c.url.endsWith('/issues/7/labels') && c.method === 'POST');
  const merged = () => calls.some((c) => c.url.includes('/merge'));
  const notReady = (reason: string) => logs.some((l) => l.includes('Not ready ExampleOrg/demo#7') && l.includes(reason));

  it('labels a green PR from the task branch, and never merges', async () => {
    const { env: e, updates } = env();
    await runPrReadyFlag(e);
    expect(calls.find((c) => c.url.endsWith('/issues/7/labels'))?.body).toEqual({ labels: [READY_LABEL] });
    expect(merged()).toBe(false);
    expect(updates).toEqual([]);
  });

  it('reads newest tasks first and skips PRs already finished', async () => {
    const { env: e } = env();
    await runPrReadyFlag(e);
    expect(sqls[0]).toContain('ORDER BY completed_at DESC');
    expect(sqls[0]).toContain("NOT LIKE '%/closed'");
  });

  it('marks a closed or merged PR done so it stops being re-read', async () => {
    pr.state = 'closed';
    const { env: e, updates } = env();
    await runPrReadyFlag(e);
    expect(updates).toEqual([['https://github.com/ExampleOrg/demo/pull/7/closed', 'task-1234abcd']]);
    expect(labelled()).toBe(false);
  });

  it.each([
    ['a fork', () => { (pr.head as any).repo = { full_name: 'Outsider/demo' }; }, 'head is from Outsider/demo'],
    ['a deleted fork', () => { (pr.head as any).repo = null; }, 'head is from a deleted fork'],
    ['a non-task branch', () => { (pr.head as any).ref = 'feature/x'; }, 'is not an auto/ task branch'],
    ['a non-default base', () => { (pr.base as any).ref = 'release'; }, 'targets release, not main'],
    ['unknown mergeability', () => { pr.mergeable = null; }, 'mergeability not computed yet'],
    ['conflicts', () => { pr.mergeable = false; }, 'merge conflicts'],
    ['a failed check next to a green one', () => { checkRuns = { total_count: 2, check_runs: [green, run('test', 'completed', 'failure')] }; }, 'check test: failure'],
    ['no CI', () => { checkRuns = { total_count: 0, check_runs: [] }; }, 'no successful GitHub Actions check run'],
  ])('does not flag %s', async (_name, setup, reason) => {
    setup();
    const { env: e } = env();
    await runPrReadyFlag(e);
    expect(labelled()).toBe(false);
    expect(merged()).toBe(false);
    expect(notReady(reason)).toBe(true);
  });

  it('honours required checks from the operator config', async () => {
    setOperatorConfig({
      ...original,
      integrations: { ...original.integrations, github: { ...original.integrations.github, prReady: { requiredChecks: { 'ExampleOrg/demo': ['test'] } } } },
    } as never);
    const { env: e } = env();
    await runPrReadyFlag(e);
    expect(labelled()).toBe(false);
    expect(notReady('required check test has not passed')).toBe(true);
  });
});
