// The real executor with its Workers-only modules stubbed: which tasks get the
// repository's conventions, and that they can't reach the acceptance contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  sandbox: undefined as unknown,
  harnessOptions: [] as { repositoryGuidance?: { text: string }; task: { prompt: string } }[],
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: () => stubs.sandbox }));
vi.mock('@cloudflare/shell', () => ({
  Workspace: class {
    async writeFile() { return undefined; }
    async readFile() { return ''; }
  },
}));
vi.mock('agents', () => ({
  Agent: class {
    current: unknown;
    ctx = { storage: { sql: {} } };
    constructor(public env: unknown) {}
    get state() { return this.current ?? (this as unknown as { initialState: unknown }).initialState; }
    setState(next: unknown) { this.current = next; }
    runFiber(_name: string, fn: () => Promise<void>) { return fn(); }
  },
}));
vi.mock('../../src/factory/harness.js', async (original) => ({
  ...(await original<typeof import('../../src/factory/harness.js')>()),
  runSandboxHarness: async (options: (typeof stubs.harnessOptions)[number]) => {
    stubs.harnessOptions.push(options);
    throw new Error('stop after recording the options');
  },
}));

import { createTaskExecutorDO } from '../../src/factory/executor-do.js';

async function runTask(repo: string) {
  // What the file holds changes once the install has run, as an install script could do.
  let conventions = 'as cloned';
  stubs.sandbox = {
    destroy: async () => undefined,
    exec: async (command: string) => {
      if (command.includes('install-script')) conventions = 'rewritten by install script';
      const stdout = command.startsWith('git ls-files') ? '100644 abc 0\tAGENTS.md\n'
        : command.startsWith('wc -c') ? '9\n'
          : command.includes('rev-parse HEAD') ? 'a'.repeat(40) : '';
      return { success: true, exitCode: 0, stdout, stderr: '' };
    },
    readFile: async () => ({ content: conventions }),
  };
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'T',
    prompt: 'Do the task.',
    repo,
    category: 'tests',
    authority: 'operator',
    github_issue_repo: null,
    github_issue_number: null,
  };
  const statement = { bind: () => statement, first: async () => row, run: async () => ({}) };
  const TaskExecutorDO = createTaskExecutorDO({
    homeOrg: 'org',
    gitIdentity: { name: 'n', email: 'e@example.com' },
    externalRepoPolicy: () => null,
    bootstrap: () => [{ name: 'install', command: 'install-script', cwd: '/workspace/repo' }],
  } as never);
  const instance = new (TaskExecutorDO as unknown as new (env: unknown) => {
    fetch(request: Request): Promise<Response>;
    state: { phase: string };
  })({ DB: { prepare: () => statement }, AI: {}, GITHUB_TOKEN: 't' });
  await instance.fetch(new Request('https://internal/run', { method: 'POST' }));
  await vi.waitFor(() => expect(instance.state.phase).toBe('failed'));
}

describe('repository conventions in the executor', () => {
  beforeEach(() => {
    stubs.harnessOptions.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (String(input).endsWith('/forks')
      ? Response.json({ name: 'app', owner: { login: 'org' } }, { status: 202 })
      : Response.json({ default_branch: 'main', name: 'app', fork: !String(input).endsWith('/repos/org/app'), parent: { full_name: 'upstream/app' } }))));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('are used for home-org repositories', async () => {
    await runTask('app');
    expect(stubs.harnessOptions[0].repositoryGuidance?.text).toContain('as cloned');
  });

  it('are read before the install runs, so an install script can not rewrite them', async () => {
    await runTask('app');
    expect(stubs.harnessOptions[0].repositoryGuidance?.text).not.toContain('rewritten');
  });

  it('are not used for a home-org repository that is itself a fork', async () => {
    await runTask('vendored');
    expect(stubs.harnessOptions[0].repositoryGuidance).toBeUndefined();
  });

  it('are not used in fork mode, where anyone upstream writes them', async () => {
    await runTask('upstream/app');
    expect(stubs.harnessOptions[0].repositoryGuidance).toBeUndefined();
  });
});
