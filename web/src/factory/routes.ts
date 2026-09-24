// Operator routes for the sandbox task executor, behind the AEGIS bearer token:
//   POST /api/task-executor/run                      — dispatch now instead of waiting for the heartbeat
//   GET  /api/task-executor/status                   — the executor's persisted state
//   GET  /api/task-executor/artifacts/:taskId/:name  — plan.json, bootstrap.json, harness.json,
//                                                      acceptance.json, publish.json, diff.patch, git-status.txt

import { Hono } from 'hono';
import { bearerAuth } from '../auth.js';
import type { RoutePlugin } from '../core.js';
import type { Env } from '../types.js';

const router = new Hono<{ Bindings: Env }>();

function executorStub(env: Env): DurableObjectStub {
  const namespace = env.TASK_EXECUTOR;
  if (!namespace) throw new Error('TASK_EXECUTOR binding missing');
  return namespace.get(namespace.idFromName('singleton'));
}

async function relay(resp: Response): Promise<Response> {
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

router.post('/api/task-executor/run', bearerAuth, async (c) => {
  try {
    return relay(await executorStub(c.env).fetch(new Request('https://internal/run', { method: 'POST' })));
  } catch (err) {
    console.error('task executor run failed:', err instanceof Error ? err.message : String(err));
    return c.json({ error: 'Internal error' }, 500);
  }
});

router.get('/api/task-executor/status', bearerAuth, async (c) => {
  try {
    return relay(await executorStub(c.env).fetch(new Request('https://internal/status')));
  } catch (err) {
    console.error('task executor status failed:', err instanceof Error ? err.message : String(err));
    return c.json({ error: 'Internal error' }, 500);
  }
});

router.get('/api/task-executor/artifacts/:taskId/:name', bearerAuth, async (c) => {
  try {
    const url = new URL('https://internal/artifact');
    url.searchParams.set('taskId', c.req.param('taskId') ?? '');
    url.searchParams.set('name', c.req.param('name') ?? '');
    return relay(await executorStub(c.env).fetch(new Request(url)));
  } catch (err) {
    console.error('task executor artifact read failed:', err instanceof Error ? err.message : String(err));
    return c.json({ error: 'Internal error' }, 500);
  }
});

/** Register with `createAegisApp({ routes: [taskExecutorRoutes] })`. */
export const taskExecutorRoutes: RoutePlugin = { prefix: '/', router };
