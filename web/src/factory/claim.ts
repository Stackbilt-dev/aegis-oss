// The sandbox executor's claim, kept apart from executor-do so it can be
// tested without the Workers runtime.

import { TASK_RUNNABLE_SQL } from '../schema-enums.js';

/**
 * Claims the next runnable do_sandbox task: pending, and not a proposed task
 * still awaiting approval. Marks it running and returns it, or null.
 */
export async function claimNextSandboxTask(db: D1Database): Promise<CCTaskRow | null> {
  return db.prepare(
    `UPDATE cc_tasks
     SET status = 'running', started_at = datetime('now'), session_id = 'do-sandbox'
     WHERE id = (
       SELECT id FROM cc_tasks
       WHERE status = 'pending'
         AND executor = 'do_sandbox'
         AND ${TASK_RUNNABLE_SQL}
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
     )
     RETURNING id, title, prompt, repo, category, authority, github_issue_repo, github_issue_number`,
  ).first<CCTaskRow>();
}

export interface CCTaskRow {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  category: string;
  authority: string;
  github_issue_repo: string | null;
  github_issue_number: number | null;
}
