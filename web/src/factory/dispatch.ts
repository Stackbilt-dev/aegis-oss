// Heartbeat dispatcher for the sandbox task executor.
//
// The executor claims its own work (executor = 'do_sandbox', authority
// auto_safe | operator) when POSTed /run. This plugin does that on the hourly
// heartbeat, and checks for an eligible task first so an empty queue never
// wakes the Durable Object. A Durable Object evicted mid-task re-attaches
// through onFiberRecovered, not here.
//
// Needs the Worker to bind the executor as TASK_EXECUTOR (mapped to
// env.taskExecutor). A missing binding throws, so task_runs records the error
// instead of silently skipping the queue.

import type { ScheduledTaskPlugin } from '../core.js';
import type { EdgeEnv } from '../kernel/dispatch.js';

interface RunResponse {
  ok?: boolean;
  dispatched?: boolean;
  taskId?: string | null;
  message?: string;
}

export async function runTaskExecutorDispatch(env: EdgeEnv): Promise<void> {
  const eligible = await env.db.prepare(`
    SELECT id FROM cc_tasks
    WHERE status = 'pending'
      AND executor = 'do_sandbox'
      AND authority IN ('auto_safe', 'operator')
    LIMIT 1
  `).first<{ id: string }>();
  if (!eligible) return;

  const namespace = env.taskExecutor;
  if (!namespace) {
    throw new Error('TASK_EXECUTOR binding missing — a do_sandbox task is pending but no executor is bound');
  }
  const stub = namespace.get(namespace.idFromName('singleton'));
  const resp = await stub.fetch(new Request('https://internal/run', { method: 'POST' }));
  const body = await resp.json().catch(() => ({})) as RunResponse;

  if (resp.status === 409) {
    console.log(`[task-executor-dispatch] executor busy — ${body.taskId?.slice(0, 8) ?? 'unknown'} still running`);
    return;
  }
  if (!resp.ok) {
    throw new Error(`task executor /run returned ${resp.status}: ${body.message ?? 'no message'}`);
  }
  if (body.dispatched) {
    console.log(`[task-executor-dispatch] dispatched ${body.taskId?.slice(0, 8)}`);
  }
}

/** Register with `createAegisApp({ scheduledTasks: [taskExecutorDispatchPlugin] })`. */
export const taskExecutorDispatchPlugin: ScheduledTaskPlugin = {
  name: 'task-executor-dispatch',
  phase: 'heartbeat',
  run: runTaskExecutorDispatch,
};
