import { type EdgeEnv } from '../dispatch.js';
import { getActiveAgendaItems, PROPOSED_ACTION_PREFIX } from '../memory/index.js';
import { listIssues } from '../../github.js';

// ─── Stale Proposed Action Expiry ─────────────────────────────
// Proposed actions from self-improvement, dreaming, and goal loops
// lose context relevance quickly. Auto-dismiss after 7 days if
// the operator hasn't approved or rejected them.
const PROPOSAL_EXPIRY_DAYS = 7;

// ─── Stale GitHub Issue Ref Cleanup (#81) ─────────────────────

export const ISSUE_REF_PATTERN = /#(\d+)/g;

const MAX_REPOS = 5; // Cap repo-specific API calls to stay within subrequest budget

export async function resolveStaleIssueRefs(
  db: D1Database,
  items: Array<{ id: number; item: string; context: string | null }>,
  githubToken: string,
  githubRepo: string,
): Promise<void> {
  // Extract unique issue numbers referenced in agenda items
  const issueRefs = new Map<number, number[]>(); // issueNumber → agendaItemIds
  for (const item of items) {
    const matches = item.item.matchAll(ISSUE_REF_PATTERN);
    for (const match of matches) {
      const issueNum = parseInt(match[1], 10);
      if (issueNum > 0 && issueNum < 10000) {
        const ids = issueRefs.get(issueNum) ?? [];
        ids.push(item.id);
        issueRefs.set(issueNum, ids);
      }
    }
  }

  if (issueRefs.size === 0) return;

  // Build repo → issueNumbers mapping from cc_tasks linkages
  // issueNumber → repo (specific repo from cc_tasks, or default)
  const issueToRepo = new Map<number, string>();
  try {
    const issueNumbers = [...issueRefs.keys()];
    // D1 doesn't support WHERE IN with bind params for dynamic lists, batch in chunks
    const placeholders = issueNumbers.map(() => '?').join(',');
    const linked = await db.prepare(
      `SELECT DISTINCT github_issue_number, github_issue_repo FROM cc_tasks
       WHERE github_issue_repo IS NOT NULL
       AND github_issue_number IN (${placeholders})`
    ).bind(...issueNumbers).all<{ github_issue_number: number; github_issue_repo: string }>();

    for (const row of linked.results ?? []) {
      issueToRepo.set(row.github_issue_number, row.github_issue_repo);
    }
  } catch (err) {
    // Non-fatal — fall back to default repo for all
    console.warn(`[escalation] cc_tasks linkage query failed:`, err instanceof Error ? err.message : String(err));
  }

  // Group issues by repo (linked repo or default)
  const repoToIssues = new Map<string, number[]>();
  for (const issueNum of issueRefs.keys()) {
    const repo = issueToRepo.get(issueNum) ?? githubRepo;
    const nums = repoToIssues.get(repo) ?? [];
    nums.push(issueNum);
    repoToIssues.set(repo, nums);
  }

  // Fetch open issues per distinct repo (capped to MAX_REPOS)
  try {
    const repos = [...repoToIssues.keys()].slice(0, MAX_REPOS);
    const openByRepo = new Map<string, Set<number>>();

    // Fetch all repos in parallel
    const results = await Promise.allSettled(
      repos.map(async (repo) => {
        const openIssues = await listIssues(githubToken, repo, 'open');
        return { repo, numbers: new Set(openIssues.map(i => i.number)) };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        openByRepo.set(result.value.repo, result.value.numbers);
      } else {
        console.warn(`[escalation] Failed to fetch issues for a repo:`, result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }

    let resolved = 0;
    for (const [issueNum, agendaIds] of issueRefs) {
      const repo = issueToRepo.get(issueNum) ?? githubRepo;
      const openNumbers = openByRepo.get(repo);
      // Skip if we couldn't fetch this repo's issues
      if (!openNumbers) continue;

      if (!openNumbers.has(issueNum)) {
        // Issue is closed — auto-resolve the agenda items
        for (const agendaId of agendaIds) {
          await db.prepare(
            "UPDATE agent_agenda SET status = 'done', resolved_at = datetime('now'), context = COALESCE(context, '') || ? WHERE id = ? AND status = 'active'"
          ).bind(` [auto-resolved: GitHub ${repo}#${issueNum} is closed]`, agendaId).run();
          resolved++;
        }
      }
    }

    if (resolved > 0) {
      console.log(`[escalation] Auto-resolved ${resolved} agenda item(s) referencing closed GitHub issues across ${openByRepo.size} repo(s)`);
    }
  } catch (err) {
    // Non-fatal — don't block escalation if GitHub is unreachable
    console.warn(`[escalation] Stale issue ref check failed:`, err instanceof Error ? err.message : String(err));
  }
}

// ─── Stale Agenda Escalation (#61) ────────────────────────────

export const ESCALATION_THRESHOLDS: Record<string, { days: number; newPriority: string }> = {
  low: { days: 7, newPriority: 'medium' },
  medium: { days: 3, newPriority: 'high' },
};
export const STALE_HIGH_ALERT_DAYS = 1;

export type StaleHighItem = { id: number; item: string; context: string | null; ageDays: number };

/**
 * Run agenda escalation: bump stale priorities and return stale high-priority items.
 * Does NOT send its own email — stale items are returned to the caller (heartbeat)
 * which folds them into a single consolidated health report.
 */
export async function runAgendaEscalation(env: EdgeEnv): Promise<StaleHighItem[]> {
  const items = await getActiveAgendaItems(env.db);
  if (items.length === 0) return [];

  // Auto-resolve agenda items that reference closed GitHub issues (#81)
  if (env.githubToken && env.githubRepo) {
    await resolveStaleIssueRefs(env.db, items, env.githubToken, env.githubRepo);
  }

  // Auto-dismiss stale proposed actions (>7 days without operator review)
  const now = Date.now();
  let expired = 0;
  for (const item of items) {
    if (!item.item.startsWith(PROPOSED_ACTION_PREFIX)) continue;
    const ts = item.created_at.endsWith('Z') ? item.created_at : item.created_at + 'Z';
    const ageDays = (now - new Date(ts).getTime()) / 86_400_000;
    if (ageDays > PROPOSAL_EXPIRY_DAYS) {
      await env.db.prepare(
        "UPDATE agent_agenda SET status = 'dismissed', resolved_at = datetime('now'), context = COALESCE(context, '') || ? WHERE id = ? AND status = 'active'"
      ).bind(` [auto-expired: ${Math.floor(ageDays)}d without review]`, item.id).run();
      expired++;
    }
  }
  if (expired > 0) {
    console.log(`[escalation] Auto-expired ${expired} stale proposed action(s) (>${PROPOSAL_EXPIRY_DAYS}d)`);
  }

  // Re-fetch after expiry so escalation loop doesn't process expired items
  const activeItems = items.filter(i => {
    if (!i.item.startsWith(PROPOSED_ACTION_PREFIX)) return true;
    const ts = i.created_at.endsWith('Z') ? i.created_at : i.created_at + 'Z';
    return (now - new Date(ts).getTime()) / 86_400_000 <= PROPOSAL_EXPIRY_DAYS;
  });

  let escalated = 0;
  const staleHighItems: StaleHighItem[] = [];

  for (const item of activeItems) {
    const ts = item.created_at.endsWith('Z') ? item.created_at : item.created_at + 'Z';
    const ageDays = (now - new Date(ts).getTime()) / 86_400_000;
    const threshold = ESCALATION_THRESHOLDS[item.priority];

    if (threshold && ageDays > threshold.days) {
      const date = new Date().toISOString().slice(0, 10);
      const annotation = ` [escalated: ${item.priority}\u2192${threshold.newPriority} ${date}]`;
      await env.db.prepare(
        "UPDATE agent_agenda SET priority = ?, context = COALESCE(context, '') || ? WHERE id = ?"
      ).bind(threshold.newPriority, annotation, item.id).run();
      console.log(`[escalation] Agenda #${item.id} escalated: ${item.priority} \u2192 ${threshold.newPriority} (${ageDays.toFixed(1)}d stale)`);
      escalated++;
    } else if (item.priority === 'high' && ageDays > STALE_HIGH_ALERT_DAYS) {
      staleHighItems.push({ id: item.id, item: item.item, context: item.context, ageDays });
    }
  }

  if (escalated > 0) {
    console.log(`[escalation] ${escalated} agenda item(s) escalated this cycle`);
  }

  return staleHighItems;
}
