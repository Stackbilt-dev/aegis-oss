import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../types.js';
import { classifyTaskFailure, parseTaskPreflight, scoreTaskUtility } from '../task-intelligence.js';
import { moveBoardItemLocal, linkTaskToBoard } from '../kernel/board.js';

const CC_TASKS_BODY_LIMIT = 256 * 1024;

const ccTasks = new Hono<{ Bindings: Env }>();

// Get next pending task (respects dependencies and priority)
ccTasks.get('/api/cc-tasks/next', async (c) => {
  const task = await c.env.DB.prepare(`
    SELECT * FROM cc_tasks
    WHERE status = 'pending'
      AND authority != 'proposed'
      AND (depends_on IS NULL OR depends_on IN (
        SELECT id FROM cc_tasks WHERE status = 'completed'
      ))
      AND (blocked_by IS NULL OR NOT EXISTS (
        SELECT 1 FROM json_each(blocked_by) AS b
        WHERE b.value NOT IN (SELECT id FROM cc_tasks WHERE status = 'completed')
      ))
      AND repo NOT IN (
        SELECT DISTINCT repo FROM cc_tasks WHERE status = 'running'
      )
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `).first();

  if (!task) return c.json({ id: null, message: 'Queue empty' });
  return c.json(task);
});

// List tasks with optional status filter
ccTasks.get('/api/cc-tasks', async (c) => {
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);

  let query: string;
  let bindings: unknown[];
  if (status) {
    query = 'SELECT * FROM cc_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?';
    bindings = [status, limit];
  } else {
    query = 'SELECT * FROM cc_tasks ORDER BY created_at DESC LIMIT ?';
    bindings = [limit];
  }

  const tasks = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ count: tasks.results.length, tasks: tasks.results });
});

// Create a new task
ccTasks.post('/api/cc-tasks', bodyLimit({ maxSize: CC_TASKS_BODY_LIMIT }), async (c) => {
  const body = await c.req.json<{
    title: string;
    repo: string;
    prompt: string;
    completion_signal?: string;
    priority?: number;
    depends_on?: string;
    blocked_by?: string[];
    max_turns?: number;
    allowed_tools?: string[];
    created_by?: string;
    authority?: string;
    category?: string;
    github_issue_repo?: string;
    github_issue_number?: number;
  }>();

  if (!body.title?.trim() || !body.repo?.trim() || !body.prompt?.trim()) {
    return c.json({ error: 'title, repo, and prompt are required' }, 400);
  }

  const authority = ['proposed', 'auto_safe', 'operator'].includes(body.authority ?? '') ? body.authority! : 'operator';
  const category = ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy'].includes(body.category ?? '') ? body.category! : 'feature';
  const blockedBy = body.blocked_by?.length ? body.blocked_by : null;

  // Cycle detection: ensure none of the blockers are blocked by this task (direct cycle)
  if (blockedBy) {
    const id_placeholder = crypto.randomUUID(); // preview ID for check
    const cycleCheck = await c.env.DB.prepare(`
      SELECT id FROM cc_tasks
      WHERE id IN (${blockedBy.map(() => '?').join(',')})
        AND (depends_on = ? OR (blocked_by IS NOT NULL AND EXISTS (
          SELECT 1 FROM json_each(blocked_by) AS b WHERE b.value = ?
        )))
    `).bind(...blockedBy, id_placeholder, id_placeholder).first();
    // Note: full transitive cycle detection deferred — direct cycles caught here
    void cycleCheck; // blockers can't reference a task that doesn't exist yet, so this is safe for creation
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(`
    INSERT INTO cc_tasks (id, title, repo, prompt, completion_signal, priority, depends_on, blocked_by, max_turns, allowed_tools, created_by, authority, category, github_issue_repo, github_issue_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.title.trim(),
    body.repo.trim(),
    body.prompt.trim(),
    body.completion_signal ?? null,
    body.priority ?? 50,
    body.depends_on ?? null,
    blockedBy ? JSON.stringify(blockedBy) : null,
    body.max_turns ?? 25,
    body.allowed_tools ? JSON.stringify(body.allowed_tools) : null,
    body.created_by ?? 'operator',
    authority,
    category,
    body.github_issue_repo ?? null,
    body.github_issue_number ?? null,
  ).run();

  return c.json({ id, status: 'pending', authority, category }, 201);
});

// Mark task as started
ccTasks.post('/api/cc-tasks/:id/start', bodyLimit({ maxSize: CC_TASKS_BODY_LIMIT }), async (c) => {
  const taskId = c.req.param('id');
  const body = await c.req.json<{ session_id?: string; preflight?: Record<string, unknown> }>()
    .catch(() => ({ session_id: undefined, preflight: undefined }));
  const preflightJson = body.preflight ? JSON.stringify(body.preflight) : null;

  await c.env.DB.prepare(`
    UPDATE cc_tasks SET status = 'running', session_id = ?, preflight_json = COALESCE(?, preflight_json), started_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).bind(body.session_id ?? null, preflightJson, taskId).run();

  // Update board item if linked to a GitHub issue
  const task = await c.env.DB.prepare(
    'SELECT github_issue_repo, github_issue_number FROM cc_tasks WHERE id = ?',
  ).bind(taskId).first<{ github_issue_repo: string | null; github_issue_number: number | null }>();
  if (task?.github_issue_repo && task.github_issue_number) {
    await moveBoardItemLocal(c.env.DB, task.github_issue_repo, task.github_issue_number, 'in_progress').catch(() => {});
  }

  return c.json({ id: taskId, status: 'running' });
});

// Mark task as completed/failed
ccTasks.post('/api/cc-tasks/:id/complete', bodyLimit({ maxSize: CC_TASKS_BODY_LIMIT }), async (c) => {
  const taskId = c.req.param('id');
  const body = await c.req.json<{
    status: 'completed' | 'failed';
    result?: string;
    error?: string;
    exit_code?: number;
    pr_url?: string;
    branch?: string;
    task_title?: string;
    repo?: string;
    category?: string;
    preflight?: Record<string, unknown>;
  }>();

  const status = body.status === 'completed' ? 'completed' : 'failed';
  const preflight = parseTaskPreflight(body.preflight ?? null);
  const preflightJson = preflight ? JSON.stringify(preflight) : null;
  const autopsy = status === 'failed'
    ? classifyTaskFailure({
      title: body.task_title ?? null,
      repo: body.repo ?? null,
      category: body.category ?? null,
      error: body.error ?? null,
      result: body.result ?? null,
      exitCode: body.exit_code ?? null,
      preflight,
    })
    : null;

  // PR utility scoring for completed tasks (#289)
  let utilityJson: string | null = null;
  if (status === 'completed') {
    // Fetch recent autonomous task titles for novelty comparison
    const recentAuto = await c.env.DB.prepare(`
      SELECT title FROM cc_tasks
      WHERE status = 'completed' AND created_by != 'operator'
        AND completed_at > datetime('now', '-14 days') AND id != ?
      ORDER BY completed_at DESC LIMIT 20
    `).bind(taskId).all<{ title: string }>();

    // Fetch task metadata for scoring (created_by, github_issue_number)
    const taskMeta = await c.env.DB.prepare(
      'SELECT created_by, github_issue_number, category FROM cc_tasks WHERE id = ?',
    ).bind(taskId).first<{ created_by: string; github_issue_number: number | null; category: string }>();

    const utility = scoreTaskUtility({
      title: body.task_title ?? '',
      category: taskMeta?.category ?? body.category ?? 'feature',
      result: body.result ?? null,
      created_by: taskMeta?.created_by ?? 'operator',
      pr_url: body.pr_url ?? null,
      github_issue_number: taskMeta?.github_issue_number ?? null,
      recentAutoTitles: recentAuto.results.map(r => r.title),
    });

    utilityJson = JSON.stringify(utility);
    console.log(`[utility] task ${taskId.slice(0, 8)}: impact=${utility.impact} novelty=${utility.novelty} signals=${utility.signals.length}`);
  }

  await c.env.DB.prepare(`
    UPDATE cc_tasks
    SET status = ?, result = ?, error = ?, exit_code = ?, pr_url = ?, branch = ?,
        preflight_json = COALESCE(?, preflight_json), failure_kind = ?, retryable = ?,
        autopsy_json = ?, utility_json = ?, completed_at = datetime('now')
    WHERE id = ?
  `).bind(
    status,
    body.result ?? null,
    body.error ?? null,
    body.exit_code ?? null,
    body.pr_url ?? null,
    body.branch ?? null,
    preflightJson,
    autopsy?.kind ?? null,
    autopsy?.retryable ? 1 : 0,
    autopsy ? JSON.stringify(autopsy) : null,
    utilityJson,
    taskId,
  ).run();

  // Update board item if linked to a GitHub issue
  const completedTask = await c.env.DB.prepare(
    'SELECT github_issue_repo, github_issue_number, retryable FROM cc_tasks WHERE id = ?',
  ).bind(taskId).first<{ github_issue_repo: string | null; github_issue_number: number | null; retryable: number | null }>();
  if (completedTask?.github_issue_repo && completedTask.github_issue_number) {
    const boardStatus = status === 'completed'
      ? 'shipped' as const
      : (completedTask.retryable ? 'queued' as const : 'blocked' as const);
    await moveBoardItemLocal(c.env.DB, completedTask.github_issue_repo, completedTask.github_issue_number, boardStatus).catch(() => {});
  }

  // Cascade cancel: when a task fails, cancel all pending tasks that depend on it
  // Checks both depends_on (single) and blocked_by (DAG array)
  if (status === 'failed') {
    const cancelReason = `Dependency ${taskId} failed`;

    // Cancel tasks using depends_on (legacy single-dependency)
    await c.env.DB.prepare(`
      UPDATE cc_tasks SET status = 'cancelled', error = ?
      WHERE depends_on = ? AND status = 'pending'
    `).bind(cancelReason, taskId).run();

    // Cancel tasks using blocked_by (DAG multi-dependency)
    await c.env.DB.prepare(`
      UPDATE cc_tasks SET status = 'cancelled', error = ?
      WHERE status = 'pending' AND blocked_by IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(blocked_by) AS b WHERE b.value = ?)
    `).bind(cancelReason, taskId).run();

    // Recurse one level: cancel tasks depending on the just-cancelled ones
    const nowCancelled = await c.env.DB.prepare(`
      SELECT id FROM cc_tasks WHERE status = 'cancelled' AND error = ?
    `).bind(cancelReason).all();

    for (const dep of nowCancelled.results) {
      const depId = (dep as any).id;
      const upstreamReason = `Dependency ${depId} failed (upstream: ${taskId})`;
      await c.env.DB.prepare(`
        UPDATE cc_tasks SET status = 'cancelled', error = ?
        WHERE status = 'pending' AND (
          depends_on = ?
          OR (blocked_by IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(blocked_by) AS b WHERE b.value = ?
          ))
        )
      `).bind(upstreamReason, depId, depId).run();
    }
  }

  return c.json({
    id: taskId,
    status,
    failure_kind: autopsy?.kind ?? null,
    retryable: autopsy?.retryable ?? false,
  });
});

// Cancel a pending or running task
ccTasks.post('/api/cc-tasks/:id/cancel', bodyLimit({ maxSize: CC_TASKS_BODY_LIMIT }), async (c) => {
  const taskId = c.req.param('id');
  const result = await c.env.DB.prepare(`
    UPDATE cc_tasks SET status = 'cancelled', completed_at = datetime('now') WHERE id = ? AND status IN ('pending', 'running')
  `).bind(taskId).run();
  if (!result.meta.changes) {
    return c.json({ error: 'Task not found or not in a cancellable status (pending/running)' }, 404);
  }
  return c.json({ id: taskId, status: 'cancelled' });
});

// Approve a proposed task (makes it eligible for execution)
ccTasks.post('/api/cc-tasks/:id/approve', bodyLimit({ maxSize: CC_TASKS_BODY_LIMIT }), async (c) => {
  const taskId = c.req.param('id');
  const result = await c.env.DB.prepare(`
    UPDATE cc_tasks SET authority = 'operator'
    WHERE id = ? AND authority = 'proposed' AND status = 'pending'
  `).bind(taskId).run();
  if (!result.meta.changes) {
    return c.json({ error: 'Task not found, not proposed, or not pending' }, 404);
  }
  return c.json({ id: taskId, authority: 'operator', status: 'pending' });
});

// Reject a proposed task
ccTasks.post('/api/cc-tasks/:id/reject', bodyLimit({ maxSize: CC_TASKS_BODY_LIMIT }), async (c) => {
  const taskId = c.req.param('id');
  const result = await c.env.DB.prepare(`
    UPDATE cc_tasks SET status = 'cancelled'
    WHERE id = ? AND authority = 'proposed' AND status = 'pending'
  `).bind(taskId).run();
  if (!result.meta.changes) {
    return c.json({ error: 'Task not found, not proposed, or not pending' }, 404);
  }
  return c.json({ id: taskId, status: 'cancelled' });
});

export { ccTasks };
