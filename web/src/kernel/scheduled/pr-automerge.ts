// --- PR Auto-Merge ---
// Closes the self-improvement loop by auto-merging PRs from
// autonomous tasks that meet safety criteria.
//
// Gates:
//   1. Task category is auto_safe (docs, tests, research)
//   2. CI is green: every check the operator config requires for the repo
//      (integrations.github.automerge.requiredChecks) succeeded on the head
//      commit, and every other status and check run there passed. A repo with
//      no required checks is never auto-merged.
//   3. Diff is under LOC cap
//   4. Every changed file is one the category may touch (docs: Markdown and
//      docs/; research: research/ and Markdown; tests: new test files only),
//      so a PR can't edit CI, tests or config that judge it
//   5. PR is open and GitHub reports it mergeable (unknown is not enough);
//      the merge is pinned to the head commit that was checked
//
// Runs in Phase 1 (free -- GitHub API only, no LLM).

import { type EdgeEnv } from '../dispatch.js';
import {
  getCombinedStatus,
  getCheckRuns,
  getPullRequestStats,
  getPullRequestFileDetails,
  type PullRequestFile,
  mergePullRequest,
} from '../../github.js';
import { operatorConfig } from '../../operator/index.js';

import { AUTOMERGE_SAFE_CATEGORIES } from '../../schema-enums.js';

// --- Configuration ---

/** Max total LOC changed (additions + deletions) */
const MAX_LOC = 500;

/**
 * What each category's PR may touch. The PR controls the workflows, tests and
 * config that produce its own checks, so anything outside these is refused --
 * including .github/, existing tests and every config file.
 */
const MARKDOWN = /\.(md|mdx)$/i;
const DOCS_ASSET = /\.(md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__)\/.+\.(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;

function fileAllowed(category: string, file: PullRequestFile): boolean {
  const paths = [file.filename, ...(file.previousFilename ? [file.previousFilename] : [])];
  if (paths.some((p) => p.startsWith('.github/') || /(^|\/)\./.test(p))) return false;
  switch (category) {
    case 'docs':
      return paths.every((p) => MARKDOWN.test(p) || (p.startsWith('docs/') && DOCS_ASSET.test(p)));
    case 'research':
      return paths.every((p) => p.startsWith('research/') || MARKDOWN.test(p));
    case 'tests':
      // New test files only: editing or deleting an existing test could weaken
      // the very checks that are about to judge this PR.
      return file.status === 'added' && TEST_FILE.test(file.filename);
    default:
      return false;
  }
}

/** First out-of-scope file for the category, as a skip reason, or null. */
export function filesOutsideCategory(category: string, files: PullRequestFile[]): string | null {
  for (const f of files) {
    if (!fileAllowed(category, f)) {
      const from = f.previousFilename ? ` (renamed from ${f.previousFilename})` : '';
      return `${category} PR touches ${f.filename}${from} (${f.status}), outside what ${category} tasks may change`;
    }
  }
  return null;
}

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

  // Gate: PR stats (open, mergeable, LOC)
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

  // Gate: every changed file is one the category may touch
  const files = await getPullRequestFileDetails(githubToken, candidate.ghRepo, candidate.prNumber);
  if (stats.changed_files > files.length) {
    return { merged: false, reason: `too many changed files to verify (${stats.changed_files})` };
  }
  const outOfScope = filesOutsideCategory(candidate.category, files);
  if (outOfScope) {
    return { merged: false, reason: outOfScope };
  }

  // Gate: CI on the exact head commit -- legacy statuses and check runs
  const [ciStatus, checkRuns] = await Promise.all([
    getCombinedStatus(githubToken, candidate.ghRepo, stats.headSha),
    getCheckRuns(githubToken, candidate.ghRepo, stats.headSha),
  ]);
  const required = operatorConfig.integrations.github.automerge?.requiredChecks?.[candidate.ghRepo] ?? [];
  const ci = ciVerdict(ciStatus, checkRuns, required);
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
 * a repo only uses Actions -- which used to pass. Now: the repo must have
 * required checks configured; each must be a completed GitHub Actions check
 * run concluding `success` (skipped or neutral don't count); every other
 * commit status must be `success` and every other check run completed with
 * `success`, `neutral` or `skipped`; and everything must have been readable
 * in one page of 100.
 */
export function ciVerdict(
  status: { total: number; statuses: { context: string; state: string }[] },
  checks: { total: number; runs: { name: string; status: string; conclusion: string | null; app?: string | null }[] },
  required: string[],
): { ok: true } | { ok: false; reason: string } {
  // "Some check is green" is not "CI passed": a job waiting on another job, a
  // path-filtered workflow or a slow integration may not have reported yet.
  // Without branch protection nothing else knows which checks matter, so the
  // operator names them per repo; no names, no auto-merge.
  if (required.length === 0) {
    return { ok: false, reason: 'no required checks configured for this repo' };
  }
  if (checks.total > checks.runs.length) {
    return { ok: false, reason: `too many check runs to verify (${checks.total})` };
  }
  if (status.total > status.statuses.length) {
    return { ok: false, reason: `too many commit statuses to verify (${status.total})` };
  }
  for (const name of required) {
    // Only a GitHub Actions check run counts: a commit status or another
    // app's check run can be posted under any name by anything with a token.
    const passed = checks.runs.some((r) =>
      r.name === name && r.app === 'github-actions' && r.status === 'completed' && r.conclusion === 'success');
    if (!passed) return { ok: false, reason: `required check ${name} has not passed` };
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
