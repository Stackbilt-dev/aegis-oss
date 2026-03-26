// --- CI Failure Watcher ---
// Polls GitHub Actions workflow runs for watched repos and surfaces
// failures via the agenda system. Zero LM calls -- pure GitHub API
// + string matching. Runs hourly in the heartbeat phase.

import { type EdgeEnv } from '../dispatch.js';
import { listWorkflowRuns, resolveRepoName, type WorkflowRun } from '../../github.js';
import { addAgendaItem } from '../memory/agenda.js';

const WATCHED_REPO = 'aegis-oss';
const WATERMARK_KEY = 'last_ci_watcher_run';
const CHECK_INTERVAL_HOURS = 1;

// Keywords in workflow run names or commit messages that indicate
// breaking-change risk to key interfaces.
const BREAKING_CHANGE_KEYWORDS = [
  'breaking',
  'interface',
  'type change',
  'constructor',
  'signature',
  'schema',
  'migration',
];

/** Check if a workflow run is relevant to breaking-change interfaces */
function isBreakingChangeRelated(run: WorkflowRun): boolean {
  const text = `${run.name} ${run.branch}`.toLowerCase();
  return BREAKING_CHANGE_KEYWORDS.some(kw => text.includes(kw));
}

export async function runCiWatcher(env: EdgeEnv): Promise<void> {
  if (!env.githubToken) {
    console.log('[ci-watcher] Skipped: missing githubToken');
    return;
  }

  // Rate-limit: run once per hour
  const lastRun = await env.db.prepare(
    `SELECT received_at FROM web_events WHERE event_id = ?`
  ).bind(WATERMARK_KEY).first<{ received_at: string }>();

  if (lastRun) {
    const hoursSince = (Date.now() - new Date(lastRun.received_at + 'Z').getTime()) / (1000 * 60 * 60);
    if (hoursSince < CHECK_INTERVAL_HOURS) return;
  }

  const repo = resolveRepoName(WATCHED_REPO);

  // Fetch recent workflow runs (main branch + PRs)
  let runs: WorkflowRun[];
  try {
    runs = await listWorkflowRuns(env.githubToken, repo, undefined, 10);
  } catch (err) {
    console.warn(`[ci-watcher] Failed to list workflow runs for ${repo}:`, err instanceof Error ? err.message : String(err));
    return;
  }

  if (runs.length === 0) {
    console.log(`[ci-watcher] ${repo}: no workflow runs found`);
    await advanceWatermark(env.db);
    return;
  }

  // Find failed runs that completed since our last check
  const sinceDate = lastRun
    ? new Date(lastRun.received_at + 'Z')
    : new Date(Date.now() - CHECK_INTERVAL_HOURS * 60 * 60 * 1000);

  const newFailures = runs.filter(r =>
    r.conclusion === 'failure' &&
    r.status === 'completed' &&
    new Date(r.created_at) > sinceDate
  );

  if (newFailures.length === 0) {
    console.log(`[ci-watcher] ${repo}: no new failures`);
    await advanceWatermark(env.db);
    return;
  }

  console.log(`[ci-watcher] ${repo}: ${newFailures.length} new CI failure(s)`);

  for (const run of newFailures) {
    // Dedup: skip if we already created an agenda item for this run
    const existing = await env.db.prepare(
      `SELECT 1 FROM web_events WHERE event_id = ? LIMIT 1`
    ).bind(`ci-fail:${repo}:${run.id}`).first();

    if (existing) continue;

    const isBreaking = isBreakingChangeRelated(run);
    const priority = run.branch === 'main'
      ? 'high'
      : (isBreaking ? 'high' : 'medium');

    const breakingTag = isBreaking ? ' [possible breaking change]' : '';
    const branchTag = run.branch === 'main' ? ' (main branch)' : ` (branch: ${run.branch})`;

    await addAgendaItem(
      env.db,
      `CI failure: "${run.name}"${branchTag}${breakingTag}`,
      `Workflow run #${run.id} failed on ${run.branch} (event: ${run.event}). ` +
        `Created: ${run.created_at}. ` +
        `${isBreaking ? 'May affect key interfaces or schemas. ' : ''}` +
        `URL: ${run.url}`,
      priority,
    );

    // Mark this run as reported
    await env.db.prepare(
      `INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))`
    ).bind(`ci-fail:${repo}:${run.id}`).run();

    console.log(`[ci-watcher] Agenda item created for run #${run.id} (${priority} priority${breakingTag})`);
  }

  await advanceWatermark(env.db);
}

async function advanceWatermark(db: D1Database): Promise<void> {
  await db.prepare(
    `INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))`
  ).bind(WATERMARK_KEY).run();
}
