// The real executor from clone through push, with only its Workers-only modules
// and the model stubbed. Everything the container would be told is captured here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_PLACEHOLDER_TOKEN, type GitHubEgressScope } from '../../src/factory/egress.js';

const sandboxMock = vi.hoisted(() => ({ current: undefined as unknown }));
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: () => sandboxMock.current,
  // Keeps the setter semantics that matter: handlers register per class name.
  Sandbox: class {
    static registry = new Map<string, Record<string, unknown>>();
    static set outboundHandlers(value: Record<string, unknown>) { this.registry.set(`${this.name}:handlers`, value); }
    static get outboundHandlers() { return this.registry.get(`${this.name}:handlers`) as Record<string, unknown>; }
    static set outboundByHost(value: Record<string, unknown>) { this.registry.set(`${this.name}:hosts`, value); }
    static get outboundByHost() { return this.registry.get(`${this.name}:hosts`) as Record<string, unknown>; }
  },
}));
vi.mock('@cloudflare/shell', () => ({
  Workspace: class {
    async writeFile(path: string, content: string) { files.set(path, content); }
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
  runSandboxHarness: async () => ({ summary: 'done', textToolCall: false, iterations: 1, events: [] }),
}));

import { STAGED_NUMSTAT_COMMAND } from '../../src/factory/acceptance.js';
import { createBrokeredSandbox } from '../../src/factory/brokered-sandbox.js';
import { cloneSiblingCommand } from '../../src/factory/bootstrap.js';
import { createTaskExecutorDO, type TaskExecutorConfig } from '../../src/factory/executor-do.js';

const REAL_TOKEN = 'real-token-value';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function task(repo: string, prompt = 'Do the task.') {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Task',
    prompt,
    repo,
    category: 'tests',
    authority: 'operator',
    github_issue_repo: null,
    github_issue_number: null,
  };
}

function fakeSandbox(enforced = true, staleScope = false, moveHeadOn?: string) {
  let head = SHA;
  const commands: string[] = [];
  const scopes: GitHubEgressScope[] = [];
  const timeline: string[] = [];
  const sandbox = {
    commands,
    scopes,
    timeline,
    destroy: async () => undefined,
    setOutboundByHost: vi.fn(async (_host: string, _handler: string, scope: GitHubEgressScope) => {
      scopes.push(scope);
      timeline.push(`scope:w=${scope.writeRepos.length},r=${scope.readRepos.length}`);
    }),
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      if (moveHeadOn && command.includes(moveHeadOn)) head = OTHER_SHA;
      if (command.includes(' push ')) timeline.push('push');
      else if (command.includes(' clone ')) timeline.push('clone');
      else if (command.includes('install')) timeline.push('install');
      let stdout = 'M\tfile.ts\n';
      if (command.includes('sandbox-egress-scope')) {
        const inForce = (staleScope ? scopes[0] : scopes.at(-1)) as GitHubEgressScope;
        stdout = JSON.stringify({ ...inForce, pushUpdate: inForce.pushUpdate ?? null });
      } else if (command.includes('example.com')) stdout = '520';
      else if (command.includes('curl')) stdout = enforced ? 'Blocked by the sandbox egress policy: no' : 'not found';
      else if (command.includes('rev-parse HEAD')) stdout = head;
      else if (command === `cd /workspace/repo && ${STAGED_NUMSTAT_COMMAND}`) stdout = btoa('1\t0\tfile.ts\0');
      return { success: true, exitCode: 0, stdout, stderr: '' };
    }),
    readFile: async () => ({ content: '' }),
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
  return sandbox;
}

const dbWrites: unknown[][] = [];

function execute(repo: string, config: Partial<TaskExecutorConfig>, prompt?: string) {
  dbWrites.length = 0;
  const row = task(repo, prompt);
  const statement = {
    bind: (...args: unknown[]) => {
      dbWrites.push(args);
      return statement;
    },
    first: async () => row,
    run: async () => ({}),
  };
  const TaskExecutorDO = createTaskExecutorDO({
    homeOrg: 'org',
    gitIdentity: { name: 'n', email: 'e@example.com' },
    externalRepoPolicy: () => null,
    ...config,
  } as TaskExecutorConfig);
  const instance = new (TaskExecutorDO as unknown as new (env: unknown) => {
    fetch(request: Request): Promise<Response>;
    state: { phase: string };
  })({ DB: { prepare: () => statement }, AI: {}, GITHUB_TOKEN: REAL_TOKEN });
  return instance;
}

async function run(instance: ReturnType<typeof execute>, expected: 'done' | 'failed' = 'done') {
  await instance.fetch(new Request('https://internal/run', { method: 'POST' }));
  await vi.waitFor(() => expect(['done', 'failed']).toContain(instance.state.phase));
  expect(instance.state.phase, JSON.stringify(dbWrites)).toBe(expected);
}

describe('a brokered task', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/forks')) return Response.json({ name: 'app-fork', owner: { login: 'org' } }, { status: 202 });
      if (url.includes('/pulls') && !url.includes('?')) return Response.json({ html_url: 'https://github.com/o/r/pull/1' }, { status: 201 });
      if (url.includes('/pulls')) return Response.json([]);
      return Response.json({ default_branch: 'main', name: 'app-fork', fork: true, parent: { full_name: 'upstream/app' } });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['before the checks, as an install script could', 'install'],
    ['during the checks, as a test could', STAGED_NUMSTAT_COMMAND],
  ])('refuses to publish when HEAD moved %s', async (_when, moveHeadOn) => {
    const sandbox = fakeSandbox(true, false, moveHeadOn);
    sandboxMock.current = sandbox;
    await run(execute('app', { bootstrap: () => [{ name: 'install', command: 'install', cwd: '/workspace/repo' }] }), 'failed');
    expect(JSON.stringify(dbWrites)).toContain(`HEAD moved from ${SHA} to ${OTHER_SHA}`);
    // Retrying re-runs what moved it, and the evidence has to include what it committed.
    expect(dbWrites.some((write) => write[1] === 'acceptance_failed' && write[2] === 0)).toBe(true);
    expect(sandbox.commands.some((command) => command.includes(` diff --cached --no-ext-diff --no-textconv ${SHA}`))).toBe(true);
    expect(JSON.parse(files.get('tasks/11111111-1111-4111-8111-111111111111/acceptance.json') ?? '{}')).toMatchObject({
      status: 'failed',
      checks: expect.arrayContaining([expect.objectContaining({ check: 'head_unmoved', ok: false })]),
    });
    expect(sandbox.timeline).not.toContain('push');
    expect(sandbox.commands.some((command) => command.includes(' commit -m '))).toBe(false);
  });

  it('keeps the verdict when HEAD can not be read after the checks', async () => {
    files.clear();
    const sandbox = fakeSandbox();
    const exec = sandbox.exec.getMockImplementation() as typeof sandbox.exec;
    let lookups = 0;
    sandbox.exec.mockImplementation(async (command: string) => (command.includes('rev-parse HEAD') && (lookups += 1) === 2
      ? { success: false, exitCode: 128, stdout: '', stderr: 'bad HEAD' }
      : exec(command)));
    sandboxMock.current = sandbox;
    await run(execute('app', {}), 'failed');
    expect(files.has('tasks/11111111-1111-4111-8111-111111111111/acceptance.json')).toBe(true);
  });

  it('leaves the publication diff alone when a task fails after committing', async () => {
    const sandbox = fakeSandbox();
    const exec = sandbox.exec.getMockImplementation() as typeof sandbox.exec;
    sandbox.exec.mockImplementation(async (command: string) => (command.includes(' push ')
      ? { success: false, exitCode: 1, stdout: '', stderr: 'failed' }
      : exec(command)));
    sandboxMock.current = sandbox;
    await run(execute('app', {}), 'failed');
    const evidence = sandbox.commands.filter((command) => command.includes(' add -A && ') && command.includes('--no-textconv'));
    expect(evidence.at(-1)).toMatch(/--no-textconv$/);
  });

  it('reads the diff of a task that failed acceptance with fsmonitor and diff drivers off', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', {}, 'Do the task.\n\n```acceptance\n{"changed_files_only":["other.ts"]}\n```'), 'failed');
    expect(JSON.stringify(dbWrites)).toContain('acceptance checks failed');
    expect(sandbox.commands).toContain('cd /workspace/repo && git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false diff --cached --no-ext-diff --no-textconv');
  });

  it('never tells the container the real token', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }));
    const all = sandbox.commands.join('\n');
    expect(all).toContain(' push ');
    expect(all).toContain(btoa(`x-access-token:${SANDBOX_PLACEHOLDER_TOKEN}`));
    expect(all).not.toContain(REAL_TOKEN);
    expect(all).not.toContain(btoa(`x-access-token:${REAL_TOKEN}`));
  });

  it('holds private reads only before the model runs, and write access only for the push', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }));
    expect(sandbox.scopes).toEqual([
      { writeRepos: [], readRepos: ['org/app'] },
      { writeRepos: [], readRepos: [] },
      {
        writeRepos: ['org/app'],
        readRepos: [],
        pushUpdate: { ref: expect.stringMatching(/^refs\/heads\/auto\/do-sandbox\//), sha: SHA },
      },
      { writeRepos: [], readRepos: [] },
    ]);
    expect(sandbox.timeline.indexOf('clone')).toBeLessThan(sandbox.timeline.indexOf('scope:w=0,r=0'));
    expect(sandbox.timeline.indexOf('scope:w=1,r=0')).toBe(sandbox.timeline.indexOf('push') - 1);
  });

  it('never holds a private read together with write access', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', {
      egressBroker: true,
      bootstrap: (_repo, token) => [cloneSiblingCommand('org', 'contracts', token)],
    }));
    expect(sandbox.scopes[0].readRepos).toEqual(['org/app', 'org/contracts']);
    for (const scope of sandbox.scopes) {
      expect(scope.writeRepos.length === 0 || scope.readRepos.length === 0).toBe(true);
    }
  });

  it('gives a fork-mode task no read of the home org, and pushes only to the fork', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('upstream/app', { egressBroker: true }));
    expect(sandbox.scopes[0]).toEqual({ writeRepos: [], readRepos: ['upstream/app'] });
    expect(sandbox.scopes[2].writeRepos).toHaveLength(1);
    expect(sandbox.scopes[2].writeRepos[0]).toMatch(/^org\//);
  });

  it('holds the push to the branch it pushes and the commit it made', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }));
    const update = sandbox.scopes[2].pushUpdate as { ref: string; sha: string };
    expect(update.sha).toBe(SHA);
    const push = sandbox.commands.find((command) => command.includes(' push ')) as string;
    expect(push).toContain(update.ref.replace('refs/heads/', ''));
  });

  it('checks each scope it sets from inside the container', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }));
    // Reads, none for the model, and the push. The last narrowing is followed by the release.
    expect(sandbox.commands.filter((command) => command.includes('sandbox-egress-scope'))).toHaveLength(3);
  });

  it('stops before the model when a narrower scope did not take', async () => {
    const sandbox = fakeSandbox(true, true);
    sandboxMock.current = sandbox;
    const instance = execute('app', { egressBroker: true });
    await run(instance, 'failed');
    expect(sandbox.timeline).toContain('clone');
    expect(sandbox.timeline).not.toContain('push');
    expect(JSON.stringify(dbWrites)).toContain('egress_setup_failed');
  });

  it('closes egress and releases when the task fails with private reads open', async () => {
    const sandbox = fakeSandbox();
    const destroy = vi.spyOn(sandbox, 'destroy');
    const exec = sandbox.exec.getMockImplementation() as (command: string) => Promise<unknown>;
    sandbox.exec.mockImplementation(async (command: string) => {
      if (command.includes('pnpm-lock.yaml')) return { success: false, exitCode: 1, stdout: '', stderr: 'failed' };
      return exec(command) as never;
    });
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }), 'failed');
    expect(sandbox.scopes.at(-1)).toEqual({ writeRepos: [], readRepos: [] });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    expect(sandbox.setOutboundByHost.mock.invocationCallOrder.at(-1)).toBeLessThan(destroy.mock.invocationCallOrder[0]);
  });

  it('closes write access as soon as publication ends, before recording the result', async () => {
    const sandbox = fakeSandbox();
    const set = sandbox.setOutboundByHost.getMockImplementation() as (host: string, handler: string, scope: GitHubEgressScope) => Promise<void>;
    let writesAtClose = -1;
    sandbox.setOutboundByHost.mockImplementation(async (host: string, handler: string, scope: GitHubEgressScope) => {
      if (sandbox.scopes.at(-1)?.pushUpdate) writesAtClose = dbWrites.length;
      return set(host, handler, scope);
    });
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }));
    expect(writesAtClose).toBeGreaterThan(-1);
    expect(dbWrites.length).toBeGreaterThan(writesAtClose);
  });

  it('tries closing egress again, without changing a task that already published', async () => {
    const sandbox = fakeSandbox();
    const set = sandbox.setOutboundByHost.getMockImplementation() as (host: string, handler: string, scope: GitHubEgressScope) => Promise<void>;
    let closes = 0;
    sandbox.setOutboundByHost.mockImplementation(async (host: string, handler: string, scope: GitHubEgressScope) => {
      if (sandbox.scopes.at(-1)?.pushUpdate && scope.writeRepos.length === 0) {
        closes += 1;
        throw new Error('control plane down');
      }
      return set(host, handler, scope);
    });
    sandboxMock.current = sandbox;
    await run(execute('app', { egressBroker: true }));
    expect(closes).toBeGreaterThan(1);
  });

  it('runs nothing from the repository when the policy is not enforced', async () => {
    const sandbox = fakeSandbox(false);
    sandboxMock.current = sandbox;
    const instance = execute('app', { egressBroker: true });
    await run(instance, 'failed');
    expect(instance.state.phase).toBe('failed');
    expect(sandbox.timeline).not.toContain('clone');
    expect(sandbox.timeline).not.toContain('install');
  });

  it('fails rather than run with the token inside when the container class cannot broker', async () => {
    const sandbox = fakeSandbox();
    sandbox.setOutboundByHost.mockRejectedValue(new Error('method not found'));
    sandboxMock.current = sandbox;
    const instance = execute('app', { egressBroker: true });
    await run(instance, 'failed');
    expect(instance.state.phase).toBe('failed');
    expect(sandbox.commands).toEqual([]);
  });

  it('leaves the token flow unchanged with the broker off', async () => {
    const sandbox = fakeSandbox();
    sandboxMock.current = sandbox;
    await run(execute('app', {}));
    expect(sandbox.setOutboundByHost).not.toHaveBeenCalled();
    expect(sandbox.commands.join('\n')).toContain(btoa(`x-access-token:${REAL_TOKEN}`));
    expect(sandbox.commands.join('\n')).not.toContain('curl');
  });
});

describe('createBrokeredSandbox', () => {
  it('registers a handler for every allowed host through the inherited setters', () => {
    const Sandbox = createBrokeredSandbox({ extraReadOnlyHosts: ['files.example.com'] });
    const hosts = (Sandbox as unknown as { outboundByHost: Record<string, unknown> }).outboundByHost;
    const instanceHosts = (new (Sandbox as unknown as new () => { allowedHosts: string[] })()).allowedHosts;
    expect(Object.keys(hosts).sort()).toEqual([...instanceHosts].sort());
    expect(instanceHosts).toContain('files.example.com');
    expect(instanceHosts).not.toContain('api.github.com');
  });

  it('closes the network and intercepts HTTPS', () => {
    const Sandbox = createBrokeredSandbox();
    const instance = new (Sandbox as unknown as new () => { enableInternet: boolean; interceptHttps: boolean })();
    expect(instance.enableInternet).toBe(false);
    expect(instance.interceptHttps).toBe(true);
  });
});
