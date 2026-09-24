import { describe, it, expect, vi } from 'vitest';
import { runTaskExecutorDispatch, taskExecutorDispatchPlugin } from '../../src/factory/dispatch.js';
import type { EdgeEnv } from '../../src/kernel/dispatch.js';

// Scheduled plugins receive EdgeEnv (env.db, env.taskExecutor), not the raw
// Worker Env — the mock must match what aegis-core actually passes.
function makeEnv(eligible: { id: string } | null, runResponse: Response, withExecutor = true) {
  const stubFetch = vi.fn(async (_req: Request) => runResponse);
  const first = vi.fn(async () => eligible);
  const taskExecutor = {
    idFromName: vi.fn(() => 'singleton-id'),
    get: vi.fn(() => ({ fetch: stubFetch })),
  };
  const env = {
    db: { prepare: vi.fn(() => ({ first })) },
    ...(withExecutor ? { taskExecutor } : {}),
  } as unknown as EdgeEnv;
  return { env, stubFetch, taskExecutor, prepare: env.db.prepare as ReturnType<typeof vi.fn> };
}

describe('runTaskExecutorDispatch', () => {
  it('does not wake the DO when no eligible do_sandbox task is pending', async () => {
    const { env, stubFetch } = makeEnv(null, Response.json({}));

    await runTaskExecutorDispatch(env);

    expect(stubFetch).not.toHaveBeenCalled();
  });

  it('only considers pending do_sandbox tasks with runnable authority', async () => {
    const { env, prepare } = makeEnv(null, Response.json({}));

    await runTaskExecutorDispatch(env);

    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("executor = 'do_sandbox'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("authority IN ('auto_safe', 'operator')");
  });

  it('POSTs /run on the singleton executor when a task is eligible', async () => {
    const { env, stubFetch, taskExecutor } = makeEnv(
      { id: 'task-1' },
      Response.json({ ok: true, dispatched: true, taskId: 'task-1' }, { status: 202 }),
    );

    await runTaskExecutorDispatch(env);

    expect(taskExecutor.idFromName).toHaveBeenCalledWith('singleton');
    expect(stubFetch).toHaveBeenCalledOnce();
    const req = stubFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/run');
  });

  it('fails loudly when the executor binding is missing instead of skipping', async () => {
    const { env } = makeEnv({ id: 'task-4' }, Response.json({}), false);

    await expect(runTaskExecutorDispatch(env)).rejects.toThrow('TASK_EXECUTOR binding missing');
  });

  it('treats a busy executor (409) as a normal heartbeat, not a failure', async () => {
    const { env } = makeEnv(
      { id: 'task-2' },
      Response.json({ ok: false, message: 'already running', taskId: 'task-1' }, { status: 409 }),
    );

    await expect(runTaskExecutorDispatch(env)).resolves.toBeUndefined();
  });

  it('throws on an unexpected DO error so the scheduler records the failure', async () => {
    const { env } = makeEnv(
      { id: 'task-3' },
      Response.json({ message: 'boom' }, { status: 500 }),
    );

    await expect(runTaskExecutorDispatch(env)).rejects.toThrow('task executor /run returned 500: boom');
  });
});

describe('taskExecutorDispatchPlugin', () => {
  it('runs on the heartbeat', () => {
    expect(taskExecutorDispatchPlugin).toMatchObject({ name: 'task-executor-dispatch', phase: 'heartbeat', run: runTaskExecutorDispatch });
  });
});
