// --- PR Ready Flag ---
// Labels autonomous-task PRs that are ready for a human merge. It never
// merges: without branch protection and sandboxed CI, no file category is
// safe to merge by rule -- docs steer later agents, Markdown is served on
// some sites, and new tests are code that runs in CI next to deploy
// credentials. (This replaces PR auto-merge, removed in 0.10.0.)
//
// A PR is flagged when:
//   1. it belongs to a completed task and is still open
//   2. it comes from an `auto/` branch in the same repo and targets the
//      repo's default branch
//   3. GitHub reports it mergeable (no conflicts)
//   4. CI on the head commit passed: every commit status is `success`,
//      every check run completed and passing, at least one GitHub Actions
//      check run succeeded, and every check the operator config requires
//      for the repo (integrations.github.prReady.requiredChecks) is a
//      successful GitHub Actions run
//
// Closed or merged PRs are marked done on the task row so the heartbeat
// moves on to newer ones.
//
// Runs in Phase 1 (free -- GitHub API only, no LLM).

import type { EdgeEnv } from '../dispatch.js';
import {
  addLabelsToIssue,
  getCombinedStatus,
  getCheckRuns,
  getPullRequestStats,
} from '../../github.js';
import { operatorConfig } from '../../operator/index.js';

// --- Configuration ---

/** Label added to PRs that are ready for a human merge. */
export const READY_LABEL = 'aegis:ready-to-merge';

/** Max PRs to evaluate per run (rate limiting) */
const MAX_PER_RUN = 5;

// --- Types ---

interface Candidate {
  taskId: string;
  title: string;
  prUrl: string;
  prNumber: number;
  ghRepo: string;
}

type Outcome =
  | { kind: 'flagged' }
  | { kind: 'closed'; state: string }
  | { kind: 'not_ready'; reason: string };

// --- Main ---

export async function runPrReadyFlag(env: EdgeEnv): Promise<void> {
  if (!env.githubToken) return;

  // Time guard: run every 2 hours (00, 02, 04, ..., 22 UTC)
  const hour = new Date().getUTCHours();
  if (hour % 2 !== 0) return;

  // Newest first, so new PRs are seen even when old ones are still open.
  // '/merged' and '/closed' suffixes mark PRs already finished.
  const rows = await env.db.prepare(`
    SELECT id, title, pr_url
    FROM cc_tasks
    WHERE status = 'completed'
      AND pr_url IS NOT NULL
      AND pr_url NOT LIKE '%/merged'
      AND pr_url NOT LIKE '%/closed'
    ORDER BY completed_at DESC
    LIMIT ?
  `).bind(MAX_PER_RUN).all<{ id: string; title: string; pr_url: string }>();

  for (const row of rows.results) {
    const match = row.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
    if (!match) continue;
    const candidate: Candidate = {
      taskId: row.id,
      title: row.title,
      prUrl: row.pr_url,
      ghRepo: match[1],
      prNumber: parseInt(match[2], 10),
    };

    try {
      const outcome = await evaluate(env.githubToken, candidate);
      const ref = `${candidate.ghRepo}#${candidate.prNumber}`;
      if (outcome.kind === 'closed') {
        await env.db.prepare(`UPDATE cc_tasks SET pr_url = ? WHERE id = ?`)
          .bind(`${candidate.prUrl}/closed`, candidate.taskId).run();
        console.log(`[pr-ready] ${ref} is ${outcome.state}; no longer tracked`);
      } else if (outcome.kind === 'flagged') {
        console.log(`[pr-ready] Flagged ${ref} ready to merge -- "${candidate.title}"`);
      } else {
        console.log(`[pr-ready] Not ready ${ref}: ${outcome.reason}`);
      }
    } catch (err) {
      console.warn(`[pr-ready] Error evaluating ${candidate.ghRepo}#${candidate.prNumber}:`,
        err instanceof Error ? err.message : String(err));
    }
  }
}

// --- Evaluation ---

async function evaluate(token: string, candidate: Candidate): Promise<Outcome> {
  const stats = await getPullRequestStats(token, candidate.ghRepo, candidate.prNumber);

  if (stats.state !== 'open') return { kind: 'closed', state: stats.state };

  // Provenance: the task's own branch in this repo, aimed at the default branch.
  if (stats.headRepo !== candidate.ghRepo) {
    return { kind: 'not_ready', reason: `head is from ${stats.headRepo ?? 'a deleted fork'}, not ${candidate.ghRepo}` };
  }
  if (!stats.head.startsWith('auto/')) {
    return { kind: 'not_ready', reason: `head branch ${stats.head} is not an auto/ task branch` };
  }
  if (stats.base !== stats.baseDefaultBranch) {
    return { kind: 'not_ready', reason: `targets ${stats.base}, not ${stats.baseDefaultBranch}` };
  }

  if (stats.mergeable !== true) {
    return { kind: 'not_ready', reason: stats.mergeable === false ? 'merge conflicts' : 'mergeability not computed yet' };
  }

  const [status, checks] = await Promise.all([
    getCombinedStatus(token, candidate.ghRepo, stats.headSha),
    getCheckRuns(token, candidate.ghRepo, stats.headSha),
  ]);
  const required = operatorConfig.integrations.github.prReady?.requiredChecks?.[candidate.ghRepo] ?? [];
  const ci = ciVerdict(status, checks, required);
  if (!ci.ok) return { kind: 'not_ready', reason: ci.reason };

  await addLabelsToIssue(token, candidate.ghRepo, candidate.prNumber, [READY_LABEL]);
  return { kind: 'flagged' };
}

// --- CI verdict ---

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Fail closed. GitHub Actions report through the Checks API, not commit
 * statuses, and the combined status reads "pending" with zero statuses when
 * a repo only uses Actions. Passing means: every commit status is `success`;
 * every check run completed with `success`, `neutral` or `skipped`; at least
 * one GitHub Actions check run concluded `success`; each required check is a
 * GitHub Actions run concluding `success`; and everything fit in one page of
 * 100 (more is refused rather than judged on a partial list).
 */
export function ciVerdict(
  status: { total: number; statuses: { context: string; state: string }[] },
  checks: { total: number; runs: { name: string; status: string; conclusion: string | null; app?: string | null }[] },
  required: string[],
): { ok: true } | { ok: false; reason: string } {
  if (checks.total > checks.runs.length) {
    return { ok: false, reason: `too many check runs to verify (${checks.total})` };
  }
  if (status.total > status.statuses.length) {
    return { ok: false, reason: `too many commit statuses to verify (${status.total})` };
  }
  const actionsPassed = (r: { status: string; conclusion: string | null; app?: string | null }) =>
    r.app === 'github-actions' && r.status === 'completed' && r.conclusion === 'success';
  if (!checks.runs.some(actionsPassed)) {
    return { ok: false, reason: 'no successful GitHub Actions check run on head commit' };
  }
  for (const name of required) {
    if (!checks.runs.some((r) => r.name === name && actionsPassed(r))) {
      return { ok: false, reason: `required check ${name} has not passed` };
    }
  }
  for (const s of status.statuses) {
    if (s.state !== 'success') return { ok: false, reason: `status ${s.context}: ${s.state}` };
  }
  for (const r of checks.runs) {
    if (r.status !== 'completed') return { ok: false, reason: `check ${r.name}: ${r.status}` };
    if (!PASSING_CONCLUSIONS.has(r.conclusion ?? '')) {
      return { ok: false, reason: `check ${r.name}: ${r.conclusion ?? 'no conclusion'}` };
    }
  }
  return { ok: true };
}
