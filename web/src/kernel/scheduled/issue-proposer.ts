// Issue Proposer — auto-file GitHub issues from detection systems
// Bridges internal detection (task failures, repo health, scheduled errors,
// argus findings, LLM trace anomalies) to GitHub issues.
// Dedup via web_events watermarks. Runs in the cron phase (6-hourly).

import { type EdgeEnv } from '../dispatch.js';
import { createIssue, searchIssues } from '../../github.js';
import { checkTaskGovernanceLimits } from './governance.js';

// ─── Configuration ──────────────────────────────────────────────

const COOLDOWN_HOURS = 6;
const WATERMARK_KEY = 'issue_proposer_last_run';
const MAX_ISSUES_PER_RUN = 3; // cap to avoid spamming

// Default labels applied to proposed issues — configurable via operatorConfig
const DEFAULT_LABELS = ['self-improvement', 'bug'];

// ─── Types ──────────────────────────────────────────────────────

interface ProposedIssue {
  title: string;
  body: string;
  labels: string[];
  detector: string;
  dedupKey: string; // unique key for web_events dedup
}

// ─── Repo canonicalization ──────────────────────────────────────
// Tasks are recorded with inconsistent repo values — sometimes the bare
// name (`aegis`), sometimes the full slug (`Stackbilt-dev/aegis`), sometimes
// the local directory name (`aegis-daemon`). SQL GROUP BY on the raw column
// treats all three as different repos, so fix-by-rename noise stays in the
// detector window forever and a single fix-commit-that's-already-live will
// still re-fire issues on every cadence.
//
// This function collapses all three forms into a single canonical key by:
//   1. Stripping any org prefix (e.g. `Stackbilt-dev/aegis` → `aegis`)
//   2. Stripping `.git` suffix
//   3. Lowercasing
//
// Note: This deliberately does NOT resolve local-dir-name aliases (like
// `aegis-daemon → aegis`) because those are operator-specific and live in
// github.ts's REPO_ALIASES, which is intentionally template-scoped in this
// OSS package. If an operator needs that mapping, they can normalize at
// cc_tasks INSERT time or extend this helper with an alias-lookup hook.
export function canonicalizeRepoName(repo: string): string {
  if (!repo) return '';
  const parts = repo.split('/');
  const raw = parts[parts.length - 1]; // last segment, org stripped
  return raw.replace(/\.git$/, '').toLowerCase();
}

// ─── Detectors ──────────────────────────────────────────────────

/**
 * Detector 1: Task failure patterns
 * Finds repeated failure_kind values in cc_tasks over the last 7 days.
 * If the same failure_kind appears 3+ times, propose an issue.
 *
 * Aggregation is done in JS (not SQL GROUP BY) so that `repo` values are
 * canonicalized first — otherwise "Stackbilt-dev/aegis", "aegis", and
 * any other form are counted as separate "affected repos" in the output.
 */
export async function detectTaskFailurePatterns(db: D1Database): Promise<ProposedIssue[]> {
  const rows = await db.prepare(`
    SELECT failure_kind, repo
    FROM cc_tasks
    WHERE status = 'failed'
      AND failure_kind IS NOT NULL
      AND completed_at > datetime('now', '-7 days')
  `).all<{ failure_kind: string; repo: string }>();

  // Bucket by failure_kind, collect canonical repo set per bucket
  const buckets = new Map<string, { cnt: number; repos: Set<string> }>();
  for (const row of rows.results) {
    const bucket = buckets.get(row.failure_kind) ?? { cnt: 0, repos: new Set<string>() };
    bucket.cnt += 1;
    const canonical = canonicalizeRepoName(row.repo);
    if (canonical) bucket.repos.add(canonical);
    buckets.set(row.failure_kind, bucket);
  }

  const ranked = Array.from(buckets.entries())
    .filter(([, b]) => b.cnt >= 3)
    .sort((a, b) => b[1].cnt - a[1].cnt)
    .slice(0, 5);

  return ranked.map(([failure_kind, b]) => ({
    title: `Recurring task failure: ${failure_kind} (${b.cnt}x in 7d)`,
    body: [
      `## Detection`,
      `The issue proposer detected a recurring task failure pattern.`,
      ``,
      `- **Failure kind**: \`${failure_kind}\``,
      `- **Occurrences**: ${b.cnt} in the last 7 days`,
      `- **Affected repos**: ${Array.from(b.repos).sort().join(', ')}`,
      ``,
      `## Suggested action`,
      `Investigate root cause of \`${failure_kind}\` failures and fix the underlying issue.`,
      ``,
      `_Auto-filed by issue-proposer (task-failure-patterns detector)_`,
    ].join('\n'),
    labels: DEFAULT_LABELS,
    detector: 'task-failure-patterns',
    dedupKey: `issue-proposer:task-fail:${failure_kind}`,
  }));
}

/**
 * Detector 2: Repo failure rates
 * If a repo has >50% task failure rate over the last 7 days (min 4 tasks),
 * propose an issue.
 *
 * Aggregation is done in JS (not SQL GROUP BY) so that tasks recorded
 * with different repo spellings (e.g. "Stackbilt-dev/aegis" vs "aegis")
 * collapse into a single bucket. Otherwise pre-fix failures on one
 * spelling stay at 100% failure rate forever because no new completions
 * ever land in that bucket to dilute them (Stackbilt-dev/aegis#431).
 */
export async function detectRepoFailureRates(db: D1Database): Promise<ProposedIssue[]> {
  const rows = await db.prepare(`
    SELECT repo, status
    FROM cc_tasks
    WHERE completed_at > datetime('now', '-7 days')
      AND status IN ('completed', 'failed')
  `).all<{ repo: string; status: string }>();

  const buckets = new Map<string, { total: number; failed: number }>();
  for (const row of rows.results) {
    const canonical = canonicalizeRepoName(row.repo);
    if (!canonical) continue;
    const bucket = buckets.get(canonical) ?? { total: 0, failed: 0 };
    bucket.total += 1;
    if (row.status === 'failed') bucket.failed += 1;
    buckets.set(canonical, bucket);
  }

  const ranked = Array.from(buckets.entries())
    .filter(([, b]) => b.total >= 4 && b.failed / b.total > 0.5)
    .sort((a, b) => b[1].failed - a[1].failed)
    .slice(0, 5);

  return ranked.map(([repo, b]) => {
    const rate = Math.round((b.failed / b.total) * 100);
    return {
      title: `High task failure rate in ${repo} (${rate}% over 7d)`,
      body: [
        `## Detection`,
        `The issue proposer detected an elevated task failure rate.`,
        ``,
        `- **Repo**: \`${repo}\``,
        `- **Failure rate**: ${rate}% (${b.failed}/${b.total} tasks failed)`,
        `- **Period**: last 7 days`,
        ``,
        `## Suggested action`,
        `Review recent failures in \`${repo}\` to identify systemic issues (broken tests, missing deps, config drift).`,
        ``,
        `_Auto-filed by issue-proposer (repo-failure-rates detector)_`,
      ].join('\n'),
      labels: DEFAULT_LABELS,
      detector: 'repo-failure-rates',
      dedupKey: `issue-proposer:repo-fail:${repo}`,
    };
  });
}

/**
 * Detector 3: Scheduled task errors
 * If a scheduled task has >50% error rate in the last 24 hours (min 3 runs),
 * propose an issue.
 */
async function detectScheduledTaskErrors(db: D1Database): Promise<ProposedIssue[]> {
  const rows = await db.prepare(`
    SELECT task_name,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
           MAX(error_message) as last_error
    FROM task_runs
    WHERE created_at > datetime('now', '-24 hours')
    GROUP BY task_name
    HAVING total >= 3 AND (CAST(errors AS REAL) / total) > 0.5
    ORDER BY errors DESC
    LIMIT 5
  `).all<{ task_name: string; total: number; errors: number; last_error: string | null }>();

  return rows.results.map(r => {
    const rate = Math.round((r.errors / r.total) * 100);
    const errorSnippet = r.last_error ? r.last_error.slice(0, 200) : 'unknown';
    return {
      title: `Scheduled task failing: ${r.task_name} (${rate}% error rate, 24h)`,
      body: [
        `## Detection`,
        `The issue proposer detected a scheduled task with a high error rate.`,
        ``,
        `- **Task**: \`${r.task_name}\``,
        `- **Error rate**: ${rate}% (${r.errors}/${r.total} runs errored)`,
        `- **Period**: last 24 hours`,
        `- **Last error**: \`${errorSnippet}\``,
        ``,
        `## Suggested action`,
        `Investigate why \`${r.task_name}\` is failing. Check for API changes, missing bindings, or data issues.`,
        ``,
        `_Auto-filed by issue-proposer (scheduled-task-errors detector)_`,
      ].join('\n'),
      labels: DEFAULT_LABELS,
      detector: 'scheduled-task-errors',
      dedupKey: `issue-proposer:sched-err:${r.task_name}`,
    };
  });
}

/**
 * Detector 4: RuntimeGuard / Argus correlations
 * Looks for high-severity findings in digest_sections from argus/codebeast
 * that haven't been turned into issues yet.
 */
async function detectArgusCorrelations(db: D1Database): Promise<ProposedIssue[]> {
  const rows = await db.prepare(`
    SELECT id, section, payload
    FROM digest_sections
    WHERE section IN ('codebeast_findings', 'event_notification')
      AND consumed = 0
      AND created_at > datetime('now', '-48 hours')
    ORDER BY created_at DESC
    LIMIT 10
  `).all<{ id: string | number; section: string; payload: string }>();

  const proposals: ProposedIssue[] = [];
  for (const row of rows.results) {
    let parsed: { severity?: string; summary?: string; detail?: string };
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }

    if (parsed.severity !== 'high') continue;

    const summary = parsed.summary ?? 'High-severity finding';
    const detail = parsed.detail ?? '';

    proposals.push({
      title: `Argus alert: ${summary.slice(0, 80)}`,
      body: [
        `## Detection`,
        `The issue proposer detected a high-severity finding from the ${row.section} system.`,
        ``,
        `- **Source**: \`${row.section}\``,
        `- **Severity**: high`,
        `- **Summary**: ${summary}`,
        detail ? `- **Detail**: ${detail.slice(0, 500)}` : '',
        ``,
        `## Suggested action`,
        `Investigate this finding and determine if code changes are needed.`,
        ``,
        `_Auto-filed by issue-proposer (argus-correlations detector)_`,
      ].filter(Boolean).join('\n'),
      labels: DEFAULT_LABELS,
      detector: 'argus-correlations',
      dedupKey: `issue-proposer:argus:${row.id}`,
    });
  }

  return proposals;
}

/**
 * Detector 5: LLM trace anomalies
 * Checks executor error rates in episodic_memory. If a specific executor
 * has >40% failure rate in the last 48h (min 5 dispatches), propose an issue.
 */
async function detectLlmTraceAnomalies(db: D1Database): Promise<ProposedIssue[]> {
  const rows = await db.prepare(`
    SELECT
      json_extract(summary, '$') as raw_summary,
      COUNT(*) as total,
      SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) as failures
    FROM episodic_memory
    WHERE created_at > datetime('now', '-48 hours')
    GROUP BY intent_class
    HAVING total >= 5 AND (CAST(failures AS REAL) / total) > 0.4
    ORDER BY failures DESC
    LIMIT 5
  `).all<{ raw_summary: string; total: number; failures: number }>();

  // Also check executor-level failures via the summary field pattern [exec:xyz]
  const execRows = await db.prepare(`
    SELECT
      CASE
        WHEN summary LIKE '%[exec:claude]%' THEN 'claude'
        WHEN summary LIKE '%[exec:groq]%' THEN 'groq'
        WHEN summary LIKE '%[exec:workers_ai]%' THEN 'workers_ai'
        WHEN summary LIKE '%[exec:gpt_oss]%' THEN 'gpt_oss'
        ELSE 'unknown'
      END as executor,
      COUNT(*) as total,
      SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) as failures
    FROM episodic_memory
    WHERE created_at > datetime('now', '-48 hours')
    GROUP BY executor
    HAVING executor != 'unknown' AND total >= 5 AND (CAST(failures AS REAL) / total) > 0.4
    ORDER BY failures DESC
    LIMIT 3
  `).all<{ executor: string; total: number; failures: number }>();

  const proposals: ProposedIssue[] = [];

  for (const r of execRows.results) {
    const rate = Math.round((r.failures / r.total) * 100);
    proposals.push({
      title: `LLM executor degraded: ${r.executor} (${rate}% failure, 48h)`,
      body: [
        `## Detection`,
        `The issue proposer detected elevated failure rates for an LLM executor.`,
        ``,
        `- **Executor**: \`${r.executor}\``,
        `- **Failure rate**: ${rate}% (${r.failures}/${r.total} dispatches)`,
        `- **Period**: last 48 hours`,
        ``,
        `## Suggested action`,
        `Check if the \`${r.executor}\` executor has API issues, model changes, or configuration problems.`,
        `Review recent episodic_memory entries for error patterns.`,
        ``,
        `_Auto-filed by issue-proposer (llm-trace-anomalies detector)_`,
      ].join('\n'),
      labels: DEFAULT_LABELS,
      detector: 'llm-trace-anomalies',
      dedupKey: `issue-proposer:llm-trace:${r.executor}`,
    });
  }

  return proposals;
}

// ─── Dedup & Filing ─────────────────────────────────────────────

async function isAlreadyProposed(db: D1Database, dedupKey: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 FROM web_events WHERE event_id = ? LIMIT 1'
  ).bind(dedupKey).first();
  return row !== null;
}

async function markProposed(db: D1Database, dedupKey: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
  ).bind(dedupKey).run();
}

/**
 * Check if a similar issue already exists on GitHub (open) to avoid duplicates.
 * Uses a simplified title-keyword search.
 */
async function hasSimilarOpenIssue(
  token: string,
  repo: string,
  title: string,
): Promise<boolean> {
  // Extract key terms for search (first 3 significant words)
  const keywords = title
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 3)
    .join(' ');

  if (!keywords) return false;

  try {
    const results = await searchIssues(token, repo, `${keywords} is:open`);
    return results.length > 0;
  } catch {
    // Search API failure shouldn't block issue creation
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────

export async function runIssueProposer(env: EdgeEnv): Promise<void> {
  if (!env.githubToken || !env.githubRepo) {
    console.log('[issue-proposer] Skipped: missing githubToken or githubRepo');
    return;
  }

  // Time gate: run every 6 hours
  const hour = new Date().getUTCHours();
  if (hour % 6 !== 0) return;

  // Cooldown check
  const lastRun = await env.db.prepare(
    'SELECT received_at FROM web_events WHERE event_id = ?'
  ).bind(WATERMARK_KEY).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < COOLDOWN_HOURS * 60 * 60 * 1000) return;
  }

  // Run all detectors in parallel
  const [taskFailures, repoFailures, schedErrors, argus, llmTraces] = await Promise.all([
    detectTaskFailurePatterns(env.db),
    detectRepoFailureRates(env.db),
    detectScheduledTaskErrors(env.db),
    detectArgusCorrelations(env.db),
    detectLlmTraceAnomalies(env.db),
  ]);

  const allProposals = [
    ...taskFailures,
    ...repoFailures,
    ...schedErrors,
    ...argus,
    ...llmTraces,
  ];

  if (allProposals.length === 0) {
    console.log('[issue-proposer] No issues to propose');
    await markProposed(env.db, WATERMARK_KEY);
    return;
  }

  let filed = 0;
  for (const proposal of allProposals) {
    if (filed >= MAX_ISSUES_PER_RUN) break;

    // Dedup: check web_events
    if (await isAlreadyProposed(env.db, proposal.dedupKey)) continue;

    // Dedup: check GitHub for similar open issues
    if (await hasSimilarOpenIssue(env.githubToken, env.githubRepo, proposal.title)) {
      await markProposed(env.db, proposal.dedupKey);
      console.log(`[issue-proposer] Skipped (similar issue exists): ${proposal.title}`);
      continue;
    }

    // Governance: check task creation limits
    const governance = await checkTaskGovernanceLimits(env.db, {
      repo: env.githubRepo,
      title: proposal.title,
      category: 'bugfix',
    });
    if (!governance.allowed) {
      console.log(`[issue-proposer] Governance blocked: ${governance.reason}`);
      continue;
    }

    // File the issue
    try {
      const result = await createIssue(
        env.githubToken,
        env.githubRepo,
        proposal.title,
        proposal.body,
        proposal.labels,
      );

      await markProposed(env.db, proposal.dedupKey);
      filed++;

      console.log(
        `[issue-proposer] Filed #${result.number}: ${proposal.title} (detector: ${proposal.detector})`,
      );
    } catch (err) {
      console.error(
        `[issue-proposer] Failed to file issue: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Advance watermark
  await markProposed(env.db, WATERMARK_KEY);

  console.log(
    `[issue-proposer] Run complete — ${filed} issue(s) filed from ${allProposals.length} proposal(s)`,
  );
}
