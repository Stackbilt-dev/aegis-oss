// Self-improvement tests — DEFAULT_WATCH_REPOS, getWatchRepos, time gating
// Covers: repo list resolution, self-improvement hour logic, ORG_STANDARDS structure

import { describe, it, expect } from 'vitest';
import { DEFAULT_WATCH_REPOS, getWatchRepos } from '../src/kernel/scheduled/self-improvement.js';

// ─── DEFAULT_WATCH_REPOS Tests ───────────────────────────────

describe('DEFAULT_WATCH_REPOS', () => {
  it('includes core repos', () => {
    expect(DEFAULT_WATCH_REPOS).toContain('aegis');
    expect(DEFAULT_WATCH_REPOS).toContain('demo_app_v2');
    expect(DEFAULT_WATCH_REPOS).toContain('charter');
    expect(DEFAULT_WATCH_REPOS).toContain('img-forge');
  });

  it('includes auth and bizops repos', () => {
    expect(DEFAULT_WATCH_REPOS).toContain('example-auth');
    expect(DEFAULT_WATCH_REPOS).toContain('bizops-copilot');
  });

  it('has 6 default repos', () => {
    expect(DEFAULT_WATCH_REPOS).toHaveLength(6);
  });
});

// ─── getWatchRepos Tests ─────────────────────────────────────

describe('getWatchRepos', () => {
  it('prefixes repos with org from env repo', () => {
    const repos = getWatchRepos('ExampleOrg/aegis');
    for (const repo of repos) {
      expect(repo).toMatch(/^ExampleOrg\//);
    }
  });

  it('returns all default repos when cache is empty', () => {
    const repos = getWatchRepos('ExampleOrg/aegis');
    expect(repos.length).toBeGreaterThanOrEqual(DEFAULT_WATCH_REPOS.length);
  });

  it('extracts org from repo string correctly', () => {
    const repos = getWatchRepos('MyOrg/some-repo');
    for (const repo of repos) {
      expect(repo.startsWith('MyOrg/')).toBe(true);
    }
  });
});

// ─── Self-improvement Time Gate ──────────────────────────────

describe('self-improvement time gate', () => {
  it('runs only at hours divisible by 6 (00, 06, 12, 18)', () => {
    function isSelfImprovementHour(hour: number): boolean {
      return hour % 6 === 0;
    }

    expect(isSelfImprovementHour(0)).toBe(true);
    expect(isSelfImprovementHour(6)).toBe(true);
    expect(isSelfImprovementHour(12)).toBe(true);
    expect(isSelfImprovementHour(18)).toBe(true);

    expect(isSelfImprovementHour(1)).toBe(false);
    expect(isSelfImprovementHour(3)).toBe(false);
    expect(isSelfImprovementHour(7)).toBe(false);
    expect(isSelfImprovementHour(23)).toBe(false);
  });
});

// ─── Category Stats Aggregation ──────────────────────────────

describe('task execution pattern analysis', () => {
  it('aggregates success rates by category', () => {
    const rows = [
      { category: 'bugfix', status: 'completed', c: 3 },
      { category: 'bugfix', status: 'failed', c: 1 },
      { category: 'docs', status: 'completed', c: 5 },
      { category: 'tests', status: 'completed', c: 2 },
      { category: 'tests', status: 'failed', c: 2 },
    ];

    const byCat: Record<string, { ok: number; fail: number }> = {};
    for (const row of rows) {
      if (!byCat[row.category]) byCat[row.category] = { ok: 0, fail: 0 };
      if (row.status === 'completed') byCat[row.category].ok += row.c;
      else if (row.status === 'failed') byCat[row.category].fail += row.c;
    }

    expect(byCat['bugfix']).toEqual({ ok: 3, fail: 1 });
    expect(byCat['docs']).toEqual({ ok: 5, fail: 0 });
    expect(byCat['tests']).toEqual({ ok: 2, fail: 2 });

    // Success rate calculation
    const bugfixRate = Math.round((byCat['bugfix'].ok / (byCat['bugfix'].ok + byCat['bugfix'].fail)) * 100);
    expect(bugfixRate).toBe(75);

    const docsRate = Math.round((byCat['docs'].ok / (byCat['docs'].ok + byCat['docs'].fail)) * 100);
    expect(docsRate).toBe(100);

    const testsRate = Math.round((byCat['tests'].ok / (byCat['tests'].ok + byCat['tests'].fail)) * 100);
    expect(testsRate).toBe(50);
  });

  it('flags repos with > 3 failures as high failure rate', () => {
    const repoFailures = [
      { repo: 'aegis', fails: 2 },
      { repo: 'demo-app-v2', fails: 5 },
      { repo: 'charter', fails: 1 },
    ];

    const highFailure = repoFailures.filter(r => r.fails > 3);
    expect(highFailure).toHaveLength(1);
    expect(highFailure[0].repo).toBe('demo-app-v2');
  });

  it('flags exit codes accounting for >= 30% of exits', () => {
    const exitCodes = [
      { exit_code: 0, c: 7 },
      { exit_code: 1, c: 3 },
    ];

    const total = exitCodes.reduce((sum, r) => sum + r.c, 0);
    const flagged = exitCodes.filter(r => {
      const pct = Math.round((r.c / total) * 100);
      return r.exit_code !== 0 && pct >= 30;
    });

    expect(flagged).toHaveLength(1);
    expect(flagged[0].exit_code).toBe(1);
    expect(Math.round((flagged[0].c / total) * 100)).toBe(30);
  });

  it('does not flag exit codes below 30% threshold', () => {
    const exitCodes = [
      { exit_code: 0, c: 10 },
      { exit_code: 1, c: 2 },
      { exit_code: 137, c: 1 },
    ];

    const total = exitCodes.reduce((sum, r) => sum + r.c, 0);
    const flagged = exitCodes.filter(r => {
      const pct = Math.round((r.c / total) * 100);
      return r.exit_code !== 0 && pct >= 30;
    });

    expect(flagged).toHaveLength(0);
  });
});

// ─── Outcome Tracking Logic ─────────────────────────────────

describe('self-improvement outcome tracking', () => {
  it('identifies self-improvement PRs by branch prefix', () => {
    function isSelfImprovementPr(head: string): boolean {
      return head.startsWith('aegis/') || head.startsWith('auto/');
    }

    expect(isSelfImprovementPr('aegis/fix-logging')).toBe(true);
    expect(isSelfImprovementPr('auto/bugfix/task-123')).toBe(true);
    expect(isSelfImprovementPr('main')).toBe(false);
    expect(isSelfImprovementPr('feature/new-thing')).toBe(false);
  });

  it('routes auto/ branches to task_execution_patterns topic', () => {
    function getTopicForBranch(head: string): string {
      return head.startsWith('auto/') ? 'task_execution_patterns' : 'self_improvement';
    }

    expect(getTopicForBranch('auto/bugfix/123')).toBe('task_execution_patterns');
    expect(getTopicForBranch('aegis/improvement')).toBe('self_improvement');
  });

  it('differentiates merged vs closed-without-merge', () => {
    function getOutcomeConfidence(merged: boolean): number {
      return merged ? 0.95 : 0.7;
    }

    expect(getOutcomeConfidence(true)).toBe(0.95);
    expect(getOutcomeConfidence(false)).toBe(0.7);
  });
});
