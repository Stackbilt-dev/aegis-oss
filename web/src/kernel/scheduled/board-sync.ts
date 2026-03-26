// --- Board Sync -- GitHub Projects v2 Reconciliation ---
// Hourly safety net: fetches all project items from GitHub and
// reconciles with D1 board_items cache. Catches manual moves,
// external additions, and any webhook events we missed.
//
// Runs every 2 hours (time-gated in scheduled/index.ts).
// Cost: 2-4 GraphQL API calls per run.

import { type EdgeEnv } from '../dispatch.js';
import { listProjectItems, type ProjectItem } from '../../github-projects.js';
import { upsertBoardItem, type BoardColumn, PROJECT_TITLE, ORG_LOGIN } from '../board.js';
import { findOrCreateProject } from '../../github-projects.js';

/** Map GitHub Projects Status field values to our internal column names. */
function resolveStatus(item: ProjectItem): BoardColumn {
  const statusNode = item.fieldValues.nodes.find(n => n.field?.name === 'Status');
  const statusName = statusNode?.name ?? '';
  const map: Record<string, BoardColumn> = {
    'Backlog': 'backlog',
    'Queued': 'queued',
    'In Progress': 'in_progress',
    'Blocked': 'blocked',
    'Shipped': 'shipped',
  };
  return map[statusName] ?? 'backlog';
}

export async function runBoardSync(env: EdgeEnv): Promise<void> {
  if (!env.githubToken) {
    console.log('[board-sync] No GITHUB_TOKEN -- skipping');
    return;
  }

  // Get project ID (cached in D1 via web_events)
  const cachedId = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'board_project_id'"
  ).first<{ received_at: string }>();

  let projectId = cachedId?.received_at;
  if (!projectId) {
    try {
      projectId = await findOrCreateProject(env.githubToken, ORG_LOGIN, PROJECT_TITLE);
      await env.db.prepare(
        "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('board_project_id', ?)"
      ).bind(projectId).run();
    } catch (err) {
      console.error(`[board-sync] Failed to find/create project: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  // Fetch all items from the project (paginated)
  const allItems: ProjectItem[] = [];
  let cursor: string | null = null;
  const maxPages = 4; // Safety: 50 items/page x 4 = 200 max

  for (let page = 0; page < maxPages; page++) {
    const result = await listProjectItems(env.githubToken, projectId, cursor ?? undefined);
    allItems.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  // Track which repo+number combinations we see from GitHub
  const seenKeys = new Set<string>();

  // Upsert each item into D1
  for (const item of allItems) {
    if (!item.content) continue; // Draft items have no content

    const repo = item.content.repository.nameWithOwner;
    const number = item.content.number;
    const key = `${repo}:${number}`;
    seenKeys.add(key);

    const labels = item.content.labels.nodes.map(l => l.name);
    const assignee = item.content.assignees.nodes[0]?.login ?? null;
    const status = resolveStatus(item);

    await upsertBoardItem(env.db, {
      id: item.id,
      project_id: projectId,
      content_type: item.content.__typename === 'PullRequest' ? 'pr' : 'issue',
      content_node_id: '', // Not available from list query -- set on first add
      repo,
      number,
      title: item.content.title,
      status,
      labels: JSON.stringify(labels),
      assignee,
    });
  }

  // Remove D1 items that no longer exist on the project
  // (deleted via GitHub UI or removed from project)
  const localItems = await env.db.prepare(
    "SELECT repo, number FROM board_items WHERE status != 'shipped'"
  ).all<{ repo: string; number: number }>();

  for (const local of localItems.results ?? []) {
    const key = `${local.repo}:${local.number}`;
    if (!seenKeys.has(key)) {
      await env.db.prepare(
        'DELETE FROM board_items WHERE repo = ? AND number = ?'
      ).bind(local.repo, local.number).run();
    }
  }

  console.log(`[board-sync] Synced ${allItems.length} items, ${seenKeys.size} active`);
}
