import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMProviders } from '@stackbilt/llm-providers';

// The Workers-only modules the executor imports. Everything else is the real code.
const sandboxMock = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: () => sandboxMock.current }));
vi.mock('@cloudflare/shell', () => ({
  Workspace: class {
    files = new Map<string, string>();
    async writeFile(path: string, content: string) { this.files.set(path, content); }
    async readFile(path: string) { return this.files.get(path) ?? ''; }
  },
}));
vi.mock('agents', () => ({
  Agent: class {
    current: unknown;
    ctx = { storage: { sql: {} } };
    constructor(public env: unknown) {}
    // Like the real Agent, falls back to the subclass's initialState field.
    get state() { return this.current ?? (this as unknown as { initialState: unknown }).initialState; }
    setState(next: unknown) { this.current = next; }
    runFiber(_name: string, fn: () => Promise<void>) { return fn(); }
  },
}));

import { bootstrapSandbox, releaseSandbox } from '../../src/factory/bootstrap.js';
import { FAILURE_DIFF_TIMEOUT_MS, createTaskExecutorDO } from '../../src/factory/executor-do.js';

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Task',
  prompt: 'Do the task.',
  repo: 'app',
  category: 'tests',
  authority: 'operator',
  github_issue_repo: null,
  github_issue_number: null,
};

function fakeDb(task: typeof TASK = TASK) {
  const statement = {
    bind: () => statement,
    first: async () => task,
    run: async () => ({}),
  };
  return { prepare: () => statement };
}

const OK = { success: true, exitCode: 0, stderr: '' };
const FAILED = { success: false, exitCode: 1, stdout: '', stderr: 'failed' };

function fakeSandbox(
  destroy: () => Promise<void>,
  stdout = 'diff --git a/x b/x',
  commands: (command: string) => Promise<typeof FAILED> | undefined = () => undefined,
) {
  return {
    destroy: vi.fn(destroy),
    exec: vi.fn(async (command: string) => (await commands(command)) ?? { ...OK, stdout }),
    readFile: async () => ({ content: '' }),
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
}

function executor(task: typeof TASK = TASK) {
  const TaskExecutorDO = createTaskExecutorDO({ homeOrg: 'org', gitIdentity: { name: 'n', email: 'e@example.com' } });
  const instance = new (TaskExecutorDO as unknown as new (env: unknown) => {
    fetch(request: Request): Promise<Response>;
    workspace: { files: Map<string, string> };
  })({ DB: fakeDb(task), AI: {}, GITHUB_TOKEN: 'real-token' });
  const run = () => instance.fetch(new Request('https://internal/run', { method: 'POST' }));
  const live = async () => (await (await instance.fetch(new Request('https://internal/status'))).json() as { live: boolean }).live;
  return { instance, run, live };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vi.waitFor(() => expect((sandboxMock.current as { destroy: { mock: { calls: unknown[] } } }).destroy.mock.calls.length).toBeGreaterThan(0));
}

describe('the executor releases its container when a task ends', () => {
  let llm: { mockRestore(): void };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ default_branch: 'main' })));
    llm = vi.spyOn(LLMProviders.prototype, 'generateResponseWithTools').mockRejectedValue(new Error('model failed'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    llm.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('destroys the container after a failed task', async () => {
    const sandbox = fakeSandbox(async () => undefined);
    sandboxMock.current = sandbox;
    await executor().run();
    await settle();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('is free for the next task before the release finishes, so a hung teardown blocks nothing', async () => {
    const sandbox = fakeSandbox(() => new Promise(() => undefined));
    sandboxMock.current = sandbox;
    const { run, live } = executor();
    await run();
    await settle();
    expect(await live()).toBe(false);
  });

  it('keeps the edits of a task that failed before publishing', async () => {
    const sandbox = fakeSandbox(async () => undefined);
    sandboxMock.current = sandbox;
    const { instance, run } = executor();
    await run();
    await settle();
    expect(instance.workspace.files.get(`tasks/${TASK.id}/diff.patch`)).toContain('diff --git');
    const order = sandbox.exec.mock.invocationCallOrder.at(-1) ?? 0;
    expect(order).toBeLessThan(sandbox.destroy.mock.invocationCallOrder[0]);
  });

  const diffCommands = (sandbox: ReturnType<typeof fakeSandbox>) =>
    sandbox.exec.mock.calls.filter(([command]) => command.includes(' add -A'));

  it('runs no command to read a diff when the clone failed, and still releases', async () => {
    const sandbox = fakeSandbox(async () => undefined, '', async (command) => (command.includes(' clone ') ? FAILED : undefined));
    sandboxMock.current = sandbox;
    await executor().run();
    await settle();
    expect(sandbox.exec.mock.calls.some(([command]) => command.includes(' clone '))).toBe(true);
    expect(diffCommands(sandbox)).toEqual([]);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('releases after a failed bootstrap', async () => {
    const sandbox = fakeSandbox(async () => undefined, '', async (command) => (command.includes('pnpm-lock.yaml') ? FAILED : undefined));
    sandboxMock.current = sandbox;
    await executor().run();
    await settle();
    expect(diffCommands(sandbox)).toHaveLength(1);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it('never touches a container for a task refused at admission', async () => {
    const sandbox = fakeSandbox(async () => undefined);
    sandboxMock.current = sandbox;
    const { run, live } = executor({ ...TASK, authority: 'auto_safe' });
    await run();
    await vi.waitFor(async () => expect(await live()).toBe(false));
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it('is free while a diff hangs, then gives up on it and still releases', async () => {
    const sandbox = fakeSandbox(async () => undefined, '', (command) => (
      command.includes(' add -A') ? new Promise(() => undefined) : undefined
    ));
    sandboxMock.current = sandbox;
    const { run, live } = executor();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await run();
      await vi.waitFor(() => expect(diffCommands(sandbox)).toHaveLength(1), { interval: 1 });
      expect(await live()).toBe(false);
      expect(sandbox.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FAILURE_DIFF_TIMEOUT_MS);
      expect(sandbox.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes no diff artifact when the task changed nothing', async () => {
    const sandbox = fakeSandbox(async () => undefined, '');
    sandboxMock.current = sandbox;
    const { instance, run } = executor();
    await run();
    await settle();
    expect(instance.workspace.files.has(`tasks/${TASK.id}/diff.patch`)).toBe(false);
  });
});

describe('releaseSandbox', () => {
  it('does not let a failed release change the task outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(releaseSandbox({ destroy: async () => { throw new Error('gone'); } })).resolves.toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('gone');
    warn.mockRestore();
  });

  it('gives up on a destroy that never settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(releaseSandbox({ destroy: () => new Promise(() => undefined) }, 5)).resolves.toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('no response after 5 ms');
    warn.mockRestore();
  });
});

describe('bootstrap evidence', () => {
  it('keeps the end of a long failed install, where the error is', async () => {
    const exec = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: `start ${'x'.repeat(20_000)} ERR_PNPM_THE_ACTUAL_ERROR`,
      stderr: '',
    }));
    const result = await bootstrapSandbox({
      sandbox: { exec, readFile: async () => ({ content: '' }), writeFile: async () => undefined, mkdir: async () => undefined },
      repo: 'app',
      token: 't',
    });
    const output = result.steps[0].output;
    expect(output).toContain('start');
    expect(output).toContain('ERR_PNPM_THE_ACTUAL_ERROR');
    expect(output.length).toBeLessThan(4_100);
  });
});
