// --- PR Auto-Merge ---
// Closes the self-improvement loop by auto-merging PRs from
// autonomous tasks that meet safety criteria.
//
// Gates:
//   1. Task category is auto_safe (docs, tests, research)
//   2. CI is green: every commit status and check run on the head commit
//      succeeded, and there is at least one (no CI means no auto-merge)
//   3. Diff is under LOC cap
//   4. No sensitive files touched
//   5. PR is open and GitHub reports it mergeable (unknown is not enough);
//      the merge is pinned to the head commit that was checked
//
// Runs in Phase 1 (free -- GitHub API only, no LLM).

import { type EdgeEnv } from '../dispatch.js';
import {
  getCombinedStatus,
  getCheckRuns,
  getPullRequestStats,
  getPullRequestFiles,
  mergePullRequest,
} from '../../github.js';

import { AUTOMERGE_SAFE_CATEGORIES } from '../../schema-enums.js';

// --- Configuration ---

/** Max total LOC changed (additions + deletions) */
const MAX_LOC = 500;

/** Files that block auto-merge if touched */
const SENSITIVE_PATTERNS = [
  /\.env/i,
  /secret/i,
  /credential/i,
  /wrangler\.toml$/,
  /package\.json$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
];

/** Max PRs to process per run (rate limiting) */
const MAX_PER_RUN = 3;

/** Repos where auto-merge is disabled (production deploy targets) */
const PROTECTED_REPOS = new Set<string>([
  // Add your production repos here, e.g.:
  // 'ExampleOrg/my-production-app',
]);

// --- Types ---

interface MergeCandidate {
  taskId: string;
  title: string;
  repo: string;
  category: string;
  prUrl: string;
  prNumber: number;
  ghRepo: string;
}

// --- Main ---

export async function runPrAutomerge(env: EdgeEnv): Promise<void> {
  if (!env.githubToken) return;

  // Time guard: run every 2 hours (00, 02, 04, ..., 22 UTC)
  const hour = new Date().getUTCHours();
  if (hour % 2 !== 0) return;

  // Find completed tasks with PRs in safe categories
  const rows = await env.db.prepare(`
    SELECT id, title, repo, category, pr_url
    FROM cc_tasks
    WHERE status = 'completed'
      AND pr_url IS NOT NULL
      AND category IN ('docs', 'tests', 'research')
      AND pr_url NOT LIKE '%/merged%'
    ORDER BY completed_at ASC
    LIMIT ?
  `).bind(MAX_PER_RUN * 2).all<{
    id: string;
    title: string;
    repo: string;
    category: string;
    pr_url: string;
  }>();

  if (rows.results.length === 0) return;

  // Parse PR URLs into merge candidates
  const candidates: MergeCandidate[] = [];
  for (const row of rows.results) {
    const match = row.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) continue;

    const ghRepo = match[1];
    const prNumber = parseInt(match[2], 10);

    // Skip protected repos
    if (PROTECTED_REPOS.has(ghRepo)) {
      console.log(`[pr-automerge] Skipped ${ghRepo}#${prNumber} -- protected repo`);
      continue;
    }

    // Double-check category
    if (!AUTOMERGE_SAFE_CATEGORIES.has(row.category as any)) continue;

    candidates.push({
      taskId: row.id,
      title: row.title,
      repo: row.repo,
      category: row.category,
      prUrl: row.pr_url,
      prNumber,
      ghRepo,
    });
  }

  let merged = 0;

  for (const candidate of candidates.slice(0, MAX_PER_RUN)) {
    try {
      const result = await evaluateAndMerge(env, candidate);
      if (result.merged) {
        merged++;
        // Mark in cc_tasks so we don't re-process
        await env.db.prepare(
          `UPDATE cc_tasks SET pr_url = ? WHERE id = ?`
        ).bind(`${candidate.prUrl}/merged`, candidate.taskId).run();
        console.log(`[pr-automerge] Merged ${candidate.ghRepo}#${candidate.prNumber} -- "${candidate.title}"`);
      } else {
        console.log(`[pr-automerge] Skipped ${candidate.ghRepo}#${candidate.prNumber}: ${result.reason}`);
      }
    } catch (err) {
      console.warn(`[pr-automerge] Error processing ${candidate.ghRepo}#${candidate.prNumber}:`,
        err instanceof Error ? err.message : String(err));
    }
  }

  if (merged > 0) {
    console.log(`[pr-automerge] Merged ${merged} PR(s) this cycle`);
  }
}

// --- Evaluation ---

interface EvalResult {
  merged: boolean;
  reason?: string;
}

async function evaluateAndMerge(
  env: EdgeEnv,
  candidate: MergeCandidate,
): Promise<EvalResult> {
  const { githubToken } = env;
  if (!githubToken) return { merged: false, reason: 'no token' };

  // Gate 1: PR stats (open, mergeable, LOC)
  const stats = await getPullRequestStats(githubToken, candidate.ghRepo, candidate.prNumber);

  if (stats.state !== 'open') {
    return { merged: false, reason: `PR state: ${stats.state}` };
  }

  if (stats.mergeable !== true) {
    return { merged: false, reason: stats.mergeable === false ? 'not mergeable (conflicts)' : 'mergeability not computed yet' };
  }

  const totalLoc = stats.additions + stats.deletions;
  if (totalLoc > MAX_LOC) {
    return { merged: false, reason: `LOC ${totalLoc} > ${MAX_LOC} cap` };
  }

  // Gate 2: Sensitive files
  const files = await getPullRequestFiles(githubToken, candidate.ghRepo, candidate.prNumber);
  for (const file of files) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(file)) {
        return { merged: false, reason: `sensitive file: ${file}` };
      }
    }
  }

  // Gate 3: CI on the exact head commit -- legacy statuses and check runs
  const [ciStatus, checkRuns] = await Promise.all([
    getCombinedStatus(githubToken, candidate.ghRepo, stats.headSha),
    getCheckRuns(githubToken, candidate.ghRepo, stats.headSha),
  ]);
  const ci = ciVerdict(ciStatus, checkRuns);
  if (!ci.ok) {
    return { merged: false, reason: ci.reason };
  }

  // All gates passed -- merge with squash
  const commitMsg = `${candidate.title} (#${candidate.prNumber})\n\nAuto-merged by AEGIS (category: ${candidate.category}, task: ${candidate.taskId.slice(0, 8)})`;
  const mergeResult = await mergePullRequest(
    githubToken,
    candidate.ghRepo,
    candidate.prNumber,
    'squash',
    commitMsg,
    stats.headSha,
  );

  if (!mergeResult.merged) {
    return { merged: false, reason: `merge failed: ${mergeResult.message}` };
  }

  return { merged: true };
}

// --- CI verdict ---

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Fail closed. GitHub Actions report through the Checks API, not commit
 * statuses, and the combined status reads "pending" with zero statuses when
 * a repo only uses Actions -- which used to pass. Now every status must be
 * success, every check run completed with a passing conclusion, and at least
 * one of either must exist.
 */
export function ciVerdict(
  status: { total: number; statuses: { context: string; state: string }[] },
  checks: { total: number; runs: { name: string; status: string; conclusion: string | null }[] },
): { ok: true } | { ok: false; reason: string } {
  if (status.total === 0 && checks.total === 0) {
    return { ok: false, reason: 'no CI statuses or check runs on head commit' };
  }
  if (checks.total > checks.runs.length) {
    return { ok: false, reason: `too many check runs to verify (${checks.total})` };
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
