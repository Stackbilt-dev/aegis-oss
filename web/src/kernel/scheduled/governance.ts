// Task Governance Limits — safety checks before auto-creating cc_tasks
// Prevents runaway task creation by enforcing caps on active AEGIS tasks.

/**
 * Check whether AEGIS is allowed to create another task.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export async function checkTaskGovernanceLimits(
  db: D1Database,
  opts: { repo: string; title: string; category: string },
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  // Per-repo cap: max 5 active AEGIS tasks per repo
  const repoPending = await db.prepare(
    `SELECT COUNT(*) as c FROM cc_tasks WHERE status IN ('pending', 'running') AND created_by LIKE 'aegis%' AND repo = ?`
  ).bind(opts.repo).first<{ c: number }>();

  if (repoPending && repoPending.c >= 5) {
    return { allowed: false, reason: `Per-repo cap reached (${repoPending.c}/5 active AEGIS tasks for ${opts.repo})` };
  }

  // Global active cap: max 20 pending/running AEGIS tasks across all repos
  // Completed tasks don't block new work — cap is self-regulating via consumption
  const activeCount = await db.prepare(
    `SELECT COUNT(*) as c FROM cc_tasks WHERE status IN ('pending', 'running') AND created_by LIKE 'aegis%'`
  ).first<{ c: number }>();

  if (activeCount && activeCount.c >= 20) {
    return { allowed: false, reason: `Active task cap reached (${activeCount.c}/20 pending/running AEGIS tasks)` };
  }

  // Duplicate title detection: prevent creating tasks with identical titles that are active or completed
  const duplicate = await db.prepare(
    `SELECT COUNT(*) as c FROM cc_tasks WHERE title = ? AND status IN ('pending', 'running', 'completed')`
  ).bind(opts.title).first<{ c: number }>();

  if (duplicate && duplicate.c > 0) {
    return { allowed: false, reason: `Duplicate task: "${opts.title}" is already pending` };
  }

  return { allowed: true };
}
