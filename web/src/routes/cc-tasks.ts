import { Hono } from 'hono';
import type { Env } from '../types.js';
import { classifyTaskFailure, parseTaskPreflight } from '../task-intelligence.js';

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
ccTasks.post('/api/cc-tasks', async (c) => {
  const body = await c.req.json<{
    title: string;
    repo: string;
    prompt: string;
    completion_signal?: string;
    priority?: number;
    depends_on?: string;
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

  const id = crypto.randomUUID();
  await c.env.DB.prepare(`
    INSERT INTO cc_tasks (id, title, repo, prompt, completion_signal, priority, depends_on, max_turns, allowed_tools, created_by, authority, category, github_issue_repo, github_issue_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.title.trim(),
    body.repo.trim(),
    body.prompt.trim(),
    body.completion_signal ?? null,
    body.priority ?? 50,
    body.depends_on ?? null,
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
ccTasks.post('/api/cc-tasks/:id/start', async (c) => {
  const taskId = c.req.param('id');
  const body = await c.req.json<{ session_id?: string; preflight?: Record<string, unknown> }>()
    .catch(() => ({ session_id: undefined, preflight: undefined }));
  const preflightJson = body.preflight ? JSON.stringify(body.preflight) : null;

  await c.env.DB.prepare(`
    UPDATE cc_tasks SET status = 'running', session_id = ?, preflight_json = COALESCE(?, preflight_json), started_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).bind(body.session_id ?? null, preflightJson, taskId).run();

  return c.json({ id: taskId, status: 'running' });
});

// Mark task as completed/failed
ccTasks.post('/api/cc-tasks/:id/complete', async (c) => {
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

  await c.env.DB.prepare(`
    UPDATE cc_tasks
    SET status = ?, result = ?, error = ?, exit_code = ?, pr_url = ?, branch = ?, preflight_json = COALESCE(?, preflight_json), failure_kind = ?, retryable = ?, autopsy_json = ?, completed_at = datetime('now')
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
    taskId,
  ).run();

  // Cascade cancel: when a task fails, cancel all pending tasks that depend on it
  if (status === 'failed') {
    const cancelled = await c.env.DB.prepare(`
      UPDATE cc_tasks SET status = 'cancelled', error = ?
      WHERE depends_on = ? AND status = 'pending'
    `).bind(`Dependency ${taskId} failed`, taskId).run();

    // Recurse: cancel tasks that depend on the just-cancelled tasks
    if (cancelled.meta.changes && cancelled.meta.changes > 0) {
      const nowCancelled = await c.env.DB.prepare(`
        SELECT id FROM cc_tasks WHERE depends_on = ? AND status = 'cancelled' AND error = ?
      `).bind(taskId, `Dependency ${taskId} failed`).all();

      for (const dep of nowCancelled.results) {
        await c.env.DB.prepare(`
          UPDATE cc_tasks SET status = 'cancelled', error = ?
          WHERE depends_on = ? AND status = 'pending'
        `).bind(`Dependency ${(dep as any).id} failed (upstream: ${taskId})`, (dep as any).id).run();
      }
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
ccTasks.post('/api/cc-tasks/:id/cancel', async (c) => {
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
ccTasks.post('/api/cc-tasks/:id/approve', async (c) => {
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
ccTasks.post('/api/cc-tasks/:id/reject', async (c) => {
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
