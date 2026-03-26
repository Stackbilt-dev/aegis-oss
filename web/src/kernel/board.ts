// --- Project Board State Manager ---
// D1 CRUD for board_items. Called by ARGUS webhooks, issue-watcher,
// CC task lifecycle, and board-sync reconciliation.

export type BoardColumn = 'backlog' | 'queued' | 'in_progress' | 'blocked' | 'shipped';

export interface BoardItem {
  id: string;
  project_id: string;
  content_type: 'issue' | 'pr';
  content_node_id: string;
  repo: string;
  number: number;
  title: string;
  status: BoardColumn;
  labels: string;
  assignee: string | null;
  cc_task_id: string | null;
  updated_at: string;
  synced_at: string;
}

// --- Config ---
// Override via operator config for your org
export const PROJECT_TITLE = 'AEGIS Operations';
export const ORG_LOGIN = 'ExampleOrg';

// --- D1 Operations ---

/** Upsert a board item into D1. */
export async function upsertBoardItem(db: D1Database, item: Partial<BoardItem> & { repo: string; number: number }): Promise<void> {
  await db.prepare(`
    INSERT INTO board_items (id, project_id, content_type, content_node_id, repo, number, title, status, labels, assignee, cc_task_id, updated_at, synced_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), datetime('now'))
    ON CONFLICT(repo, number) DO UPDATE SET
      id = COALESCE(?1, board_items.id),
      project_id = COALESCE(?2, board_items.project_id),
      content_type = COALESCE(?3, board_items.content_type),
      content_node_id = COALESCE(?4, board_items.content_node_id),
      title = COALESCE(?7, board_items.title),
      status = COALESCE(?8, board_items.status),
      labels = COALESCE(?9, board_items.labels),
      assignee = COALESCE(?10, board_items.assignee),
      cc_task_id = COALESCE(?11, board_items.cc_task_id),
      updated_at = datetime('now'),
      synced_at = datetime('now')
  `).bind(
    item.id ?? null,
    item.project_id ?? null,
    item.content_type ?? null,
    item.content_node_id ?? null,
    item.repo,
    item.number,
    item.title ?? null,
    item.status ?? null,
    item.labels ?? null,
    item.assignee ?? null,
    item.cc_task_id ?? null,
  ).run();
}

export async function ensureOnBoard(
  db: D1Database,
  githubToken: string,
  projectId: string,
  repo: string,
  issueNumber: number,
  title: string,
  status: string,
): Promise<void> {
  throw new Error('not implemented');
}

export async function moveBoardItemLocal(
  db: D1Database,
  repo: string,
  issueNumber: number,
  status: 'queued' | 'in_progress' | 'shipped' | 'blocked' | 'backlog',
): Promise<void> {
  throw new Error('not implemented');
}

export async function linkTaskToBoard(
  db: D1Database,
  taskId: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  throw new Error('not implemented');
}
