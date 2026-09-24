import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '@cloudflare/sandbox';
import { bootstrapCommands } from '../../src/factory/bootstrap.js';
import { publishBranch } from '../../src/factory/publish.js';
import {
  RepoTargetError,
  defaultBranch,
  defaultExternalRepoPolicy,
  ensureFork,
  externalRepoAdmissionError,
  forkName,
  parseTaskRepo,
  pullRequestHead,
  recipeKey,
  type ExternalRepoPolicy,
  type GitHubClient,
} from '../../src/factory/repo.js';

const HOME = 'example-org';

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function client(responses: Response[]): GitHubClient & { calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  return {
    calls,
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${path}`);
      return next;
    }),
    sleep: vi.fn(async () => {}),
  };
}

const FORK_OF = (parent: string) => ({ fork: true, parent: { full_name: parent } });
const task = (repo: string, overrides: Partial<{ executor: string; authority: string; hasAcceptanceSpec: boolean }> = {}) => ({
  repo,
  executor: 'do_sandbox',
  authority: 'operator',
  hasAcceptanceSpec: true,
  ...overrides,
});

describe('parseTaskRepo', () => {
  it('treats bare names and home-org-qualified names as internal', () => {
    expect(parseTaskRepo('app', HOME)).toEqual({ owner: HOME, name: 'app', external: false });
    expect(parseTaskRepo('Example-Org/lib', HOME)).toEqual({ owner: HOME, name: 'lib', external: false });
  });

  it('treats owner/name outside the home org as external', () => {
    const target = parseTaskRepo('someone/tiny-lib.git', HOME);
    expect(target).toEqual({ owner: 'someone', name: 'tiny-lib', external: true });
    expect(recipeKey(target)).toBe('someone/tiny-lib');
    expect(recipeKey(parseTaskRepo('example-org/app', HOME))).toBe('app');
    expect(forkName(target)).toBe('someone--tiny-lib');
    expect(pullRequestHead(target, 'auto/do-sandbox/abc', HOME)).toBe('example-org:auto/do-sandbox/abc');
    expect(pullRequestHead(parseTaskRepo('app', HOME), 'auto/do-sandbox/abc', HOME)).toBe('auto/do-sandbox/abc');
  });

  it('rejects unsafe or over-qualified names', () => {
    expect(() => parseTaskRepo('a/b/c', HOME)).toThrow(RepoTargetError);
    expect(() => parseTaskRepo('owner/na me', HOME)).toThrow(RepoTargetError);
    expect(() => parseTaskRepo("owner/x';rm", HOME)).toThrow(RepoTargetError);
  });
});

describe('external repository admission', () => {
  it('leaves home-org repos alone', () => {
    expect(externalRepoAdmissionError(task('app', { executor: 'claude_code', authority: 'auto_safe', hasAcceptanceSpec: false }), HOME)).toBeNull();
  });

  it('by default admits outside repos only on do_sandbox, operator authority, with acceptance', () => {
    expect(externalRepoAdmissionError(task('someone/lib'), HOME)).toBeNull();
    expect(externalRepoAdmissionError(task('someone/lib', { executor: 'claude_code' }), HOME)).toMatch(/do_sandbox/);
    expect(externalRepoAdmissionError(task('someone/lib', { authority: 'auto_safe' }), HOME)).toMatch(/operator/);
    expect(externalRepoAdmissionError(task('someone/lib', { hasAcceptanceSpec: false }), HOME)).toMatch(/acceptance/);
    expect(externalRepoAdmissionError(task('a/b/c'), HOME)).toMatch(/owner\/name/);
  });

  it('accepts a custom policy, e.g. an owner allowlist on top of the default', () => {
    const allowlist: ExternalRepoPolicy = (admission, target, homeOrg) => (
      target.external && !['trusted-co'].includes(target.owner)
        ? `${target.owner} is not on the allowlist`
        : defaultExternalRepoPolicy(admission, target, homeOrg)
    );
    expect(externalRepoAdmissionError(task('someone/lib'), HOME, allowlist)).toMatch(/allowlist/);
    expect(externalRepoAdmissionError(task('trusted-co/lib'), HOME, allowlist)).toBeNull();
  });
});

describe('ensureFork', () => {
  const target = parseTaskRepo('someone/lib', HOME);

  it('reuses an existing fork of the same upstream', async () => {
    const gh = client([json(200, FORK_OF('someone/lib'))]);
    await expect(ensureFork(gh, target, HOME)).resolves.toBe('someone--lib');
    expect(gh.calls.map(([path]) => path)).toEqual(['/repos/example-org/someone--lib']);
  });

  it('refuses a same-named org repo that is not a fork of the upstream', async () => {
    const gh = client([json(200, FORK_OF('other/lib'))]);
    await expect(ensureFork(gh, target, HOME)).rejects.toThrow(/not a fork of someone\/lib/);
  });

  it('creates the fork into the home org and polls until it exists', async () => {
    const gh = client([
      json(404),
      json(202, { name: 'someone--lib' }),
      json(404),
      json(200, FORK_OF('someone/lib')),
    ]);
    await expect(ensureFork(gh, target, HOME)).resolves.toBe('someone--lib');
    const [path, init] = gh.calls[1];
    expect(path).toBe('/repos/someone/lib/forks');
    expect(JSON.parse(String(init?.body))).toEqual({ organization: HOME, name: 'someone--lib', default_branch_only: true });
    expect(gh.sleep).toHaveBeenCalledTimes(1);
  });

  it('follows the name GitHub reports for a pre-existing fork', async () => {
    const gh = client([json(404), json(202, { name: 'lib' }), json(200, FORK_OF('someone/lib'))]);
    await expect(ensureFork(gh, target, HOME)).resolves.toBe('lib');
    expect(gh.calls[2][0]).toBe('/repos/example-org/lib');
  });

  it('classifies a refused fork as non-retryable', async () => {
    const gh = client([json(404), json(403, { message: 'Resource not accessible' })]);
    const error = await ensureFork(gh, target, HOME).catch((e) => e);
    expect(error).toBeInstanceOf(RepoTargetError);
    expect(error.kind).toBe('fork_failed');
    expect(error.retryable).toBe(false);
  });
});

describe('defaultBranch', () => {
  it('reads the upstream default branch', async () => {
    await expect(defaultBranch(client([json(200, { default_branch: 'master' })]), parseTaskRepo('someone/lib', HOME))).resolves.toBe('master');
  });
});

describe('fork-mode publication', () => {
  it('uses the default install for outside repos', () => {
    expect(bootstrapCommands('someone/lib', 'secret-token').map((step) => step.name)).toEqual(['runtime', 'install-dependencies']);
  });

  it('pushes to the fork remote when one is given', async () => {
    const ok = (stdout = ''): ExecResult => ({
      success: true, exitCode: 0, stdout, stderr: '', command: 'x', duration: 1, timestamp: '2026-09-23T00:00:00.000Z',
    });
    const results = [
      ok(), ok('src/a.ts\n'), ok('diff --git a/src/a.ts b/src/a.ts\n'), ok(), ok('M  src/a.ts\n'), ok(),
      ok('0123456789abcdef0123456789abcdef01234567\n'), ok(),
    ];
    const exec = vi.fn(async () => results.shift()!);
    await publishBranch({
      repoPath: '/workspace/repo',
      branch: 'auto/do-sandbox/1234abcd',
      commitMessage: 'test',
      exec,
      writeArtifact: async () => {},
      createPullRequest: async () => 'https://github.com/someone/lib/pull/1',
      branchForChange: (key) => `auto/do-sandbox/${key}`,
      pushRemote: 'fork',
    });
    const push = exec.mock.calls.map((call) => String(call[0])).find((command) => command.includes('git push'));
    expect(push).toContain("push --set-upstream 'fork' ");
  });
});
