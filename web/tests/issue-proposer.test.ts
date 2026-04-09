// Tests for the issue-proposer detectors — focused on repo canonicalization
// behavior that prevents duplicate/phantom "affected repo" buckets when the
// same physical repo is recorded with multiple spellings (e.g. "Stackbilt-dev/aegis",
// "aegis", "aegis-daemon"). Regression guard for Stackbilt-dev/aegis#429, #430, #431.

import { describe, it, expect } from 'vitest';
import {
  canonicalizeRepoName,
  detectTaskFailurePatterns,
  detectRepoFailureRates,
} from '../src/kernel/scheduled/issue-proposer.js';

// ─── Mock D1 ───────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(allResults: Record<string, unknown>[][]) {
  const queries: MockQuery[] = [];
  let allIdx = 0;

  const db = {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async all() {
          const results = allResults[allIdx++] ?? [];
          return { results };
        },
      };
    },
    _queries: queries,
  };

  return db as unknown as D1Database & { _queries: MockQuery[] };
}

// ─── Canonicalization unit tests ───────────────────────────────

describe('canonicalizeRepoName', () => {
  it('strips org prefix', () => {
    expect(canonicalizeRepoName('Stackbilt-dev/aegis')).toBe('aegis');
    expect(canonicalizeRepoName('octocat/hello-world')).toBe('hello-world');
  });

  it('passes bare repo names through unchanged (after lowercasing)', () => {
    expect(canonicalizeRepoName('aegis')).toBe('aegis');
    expect(canonicalizeRepoName('charter')).toBe('charter');
  });

  it('strips .git suffix', () => {
    expect(canonicalizeRepoName('Stackbilt-dev/aegis.git')).toBe('aegis');
    expect(canonicalizeRepoName('aegis.git')).toBe('aegis');
  });

  it('lowercases for case-insensitive grouping', () => {
    expect(canonicalizeRepoName('Stackbilt-dev/AEGIS')).toBe('aegis');
    expect(canonicalizeRepoName('Aegis')).toBe('aegis');
  });

  it('returns empty string for empty/null-ish input', () => {
    expect(canonicalizeRepoName('')).toBe('');
  });

  it('does NOT resolve local-dir aliases (scope: portable OSS template)', () => {
    // aegis-daemon stays distinct from aegis at this layer. Operators who
    // want that collapse should normalize at cc_tasks INSERT time or extend
    // REPO_ALIASES in github.ts in their deployment.
    expect(canonicalizeRepoName('aegis-daemon')).toBe('aegis-daemon');
  });
});

// ─── detectRepoFailureRates normalization ──────────────────────

describe('detectRepoFailureRates (repo canonicalization)', () => {
  it('flags the canonical bucket (not the raw spelling) when failure rate exceeds threshold', async () => {
    // 6 failed Stackbilt-dev/aegis + 1 completed aegis + 3 failed aegis-daemon
    // Canonical "aegis" bucket: 6 failed + 1 completed = 7/7 → 85.7% failure
    // aegis-daemon stays distinct → 3/3 = 100% but under min-total (< 4)
    const db = createMockDb([
      [
        ...Array(6).fill(0).map(() => ({ repo: 'Stackbilt-dev/aegis', status: 'failed' })),
        { repo: 'aegis', status: 'completed' },
        ...Array(3).fill(0).map(() => ({ repo: 'aegis-daemon', status: 'failed' })),
      ],
    ]);

    const proposals = await detectRepoFailureRates(db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toContain('aegis');
    // Crucially: title uses the canonical form, NOT the org-prefixed spelling
    expect(proposals[0].title).not.toContain('Stackbilt-dev/aegis');
    expect(proposals[0].body).toContain('(6/7 tasks failed)');
    expect(proposals[0].dedupKey).toBe('issue-proposer:repo-fail:aegis');
  });

  it('does not flag buckets below the 4-task minimum even at 100% failure', async () => {
    // This was the #431 symptom: 8 pre-fix failures on "Stackbilt-dev/aegis"
    // stayed at 100% forever because no new completions ever landed in that
    // literal bucket. Canonicalization alone doesn't fix it if the only
    // failures pre-date every fix — we still need the min-total gate. This
    // test just verifies the gate still works.
    const db = createMockDb([
      [
        { repo: 'Stackbilt-dev/aegis', status: 'failed' },
        { repo: 'Stackbilt-dev/aegis', status: 'failed' },
        { repo: 'Stackbilt-dev/aegis', status: 'failed' },
      ],
    ]);

    const proposals = await detectRepoFailureRates(db);
    expect(proposals).toHaveLength(0); // total = 3, below min of 4
  });

  it('does not re-fire after a fix once new completions dilute the bucket', async () => {
    // Positive scenario: 8 old failures + 12 new successes. Canonicalized
    // bucket = 8/20 = 40%, under the >50% threshold. This is the key fix
    // for #431 — pre-canonicalization, the 8 old failures lived in their
    // own Stackbilt-dev/aegis bucket forever at 100%.
    const db = createMockDb([
      [
        ...Array(8).fill(0).map(() => ({ repo: 'Stackbilt-dev/aegis', status: 'failed' })),
        ...Array(12).fill(0).map(() => ({ repo: 'aegis', status: 'completed' })),
      ],
    ]);

    const proposals = await detectRepoFailureRates(db);
    expect(proposals).toHaveLength(0);
  });

  it('caps at 5 proposals ordered by failed count desc', async () => {
    const rows: Record<string, unknown>[] = [];
    // 7 distinct repos, all over threshold (5 failed / 1 completed)
    for (const repo of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      for (let i = 0; i < 5; i++) rows.push({ repo, status: 'failed' });
      rows.push({ repo, status: 'completed' });
    }

    const proposals = await detectRepoFailureRates(createMockDb([rows]));
    expect(proposals).toHaveLength(5);
  });
});

// ─── detectTaskFailurePatterns affected-repos dedup ────────────

describe('detectTaskFailurePatterns (affected repos dedup)', () => {
  it('dedupes canonicalized repos in the "Affected repos" display field', async () => {
    // 3 max_turns_exceeded failures spread across different spellings of
    // the same canonical repo. Pre-fix, the detector's GROUP_CONCAT showed
    // three entries (`Stackbilt-dev/aegis,aegis,aegis`); now it shows one.
    const db = createMockDb([
      [
        { failure_kind: 'max_turns_exceeded', repo: 'Stackbilt-dev/aegis' },
        { failure_kind: 'max_turns_exceeded', repo: 'aegis' },
        { failure_kind: 'max_turns_exceeded', repo: 'AEGIS' },
      ],
    ]);

    const proposals = await detectTaskFailurePatterns(db);
    expect(proposals).toHaveLength(1);
    // Single canonical entry in the affected-repos list
    expect(proposals[0].body).toContain('**Affected repos**: aegis\n');
    expect(proposals[0].body).not.toContain('Stackbilt-dev/aegis');
    expect(proposals[0].body).not.toContain('AEGIS');
  });

  it('counts occurrences correctly across spelling variants', async () => {
    // 4 failures on the canonical aegis bucket + 2 on charter. Only aegis
    // passes the >=3 threshold.
    const db = createMockDb([
      [
        { failure_kind: 'max_turns_exceeded', repo: 'Stackbilt-dev/aegis' },
        { failure_kind: 'max_turns_exceeded', repo: 'aegis' },
        { failure_kind: 'max_turns_exceeded', repo: 'Stackbilt-dev/AEGIS' },
        { failure_kind: 'max_turns_exceeded', repo: 'aegis' },
        { failure_kind: 'max_turns_exceeded', repo: 'charter' },
        { failure_kind: 'max_turns_exceeded', repo: 'Stackbilt-dev/charter' },
      ],
    ]);

    const proposals = await detectTaskFailurePatterns(db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('Recurring task failure: max_turns_exceeded (6x in 7d)');
    expect(proposals[0].body).toContain('**Affected repos**: aegis, charter\n');
  });
});
