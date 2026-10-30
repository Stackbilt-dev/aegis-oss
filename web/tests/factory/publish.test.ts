import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STAGED_NUMSTAT_COMMAND } from '../../src/factory/acceptance.js';
import { githubBasicAuthorizationValue } from '../../src/factory/git.js';
import type { ExecResult } from '@cloudflare/sandbox';
import {
  PublicationError,
  computeChangeKey,
  isPushRejected,
  publishBranch,
  type PublicationArtifacts,
} from '../../src/factory/publish.js';

const BRANCH = 'auto/do-sandbox/1234abcd';
const SHA = '0123456789abcdef0123456789abcdef01234567';

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    command: 'test',
    duration: 5,
    timestamp: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

function harness(results: ExecResult[]) {
  const artifacts = new Map<string, string>();
  const exec = vi.fn(async () => {
    const next = results.shift();
    if (!next) throw new Error('unexpected command');
    return next;
  });
  const writeArtifact = vi.fn(async (path: string, content: string) => {
    artifacts.set(path, content);
  });
  const createPullRequest = vi.fn(async () => 'https://github.com/Stackbilt-dev/aegis/pull/1');
  return { artifacts, exec, writeArtifact, createPullRequest };
}

function successfulGitResults(): ExecResult[] {
  return [
    result(),
    result({ stdout: 'web/tests/example.test.ts\n' }),
    result({ stdout: 'diff --git a/example b/example\n' }),
    result({ stdout: 'A  web/tests/example.test.ts\n' }),
    result({ stdout: '[branch abc123] test commit\n' }),
    result({ stdout: `${SHA}\n` }),
    result({ stdout: `branch '${BRANCH}' set up to track origin\n` }),
  ];
}

describe('publishBranch', () => {
  it('preserves stdout and classifies a push failure with empty stderr', async () => {
    const secret = 'github-secret';
    const results = successfulGitResults();
    results[6] = result({
      success: false,
      exitCode: 128,
      stdout: `remote rejected token ${secret}`,
      stderr: '',
    });
    const h = harness(results);

    const promise = publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: add coverage',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      artifactPrefix: 'tasks/task-1/',
      secrets: [secret],
    });

    await expect(promise).rejects.toMatchObject<Partial<PublicationError>>({
      kind: 'git_push_failed',
      retryable: true,
      exitCode: 128,
    });
    await expect(promise).rejects.toThrow('stdout: remote rejected token [REDACTED]');
    expect(h.createPullRequest).not.toHaveBeenCalled();

    const publish = JSON.parse(
      h.artifacts.get('tasks/task-1/publish.json') ?? '{}',
    ) as PublicationArtifacts;
    expect(publish.branch).toBe(BRANCH);
    expect(publish.commitSha).toBe(SHA);
    expect(publish.stages.at(-1)).toMatchObject({
      stage: 'git_push',
      success: false,
      exitCode: 128,
      stdout: 'remote rejected token [REDACTED]',
    });
    expect(JSON.stringify(publish)).not.toContain(secret);
  });

  it('marks a diverged-branch push rejection as not retryable', async () => {
    const results = successfulGitResults();
    results[6] = result({
      success: false,
      exitCode: 1,
      stderr: ` ! [rejected]        ${BRANCH} -> ${BRANCH} (non-fast-forward)\n`
        + 'error: failed to push some refs\n'
        + 'hint: Updates were rejected because the tip of your current branch is behind\n',
    });
    const h = harness(results);

    await expect(publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: add coverage',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    })).rejects.toMatchObject<Partial<PublicationError>>({
      kind: 'git_push_failed',
      retryable: false,
    });
    expect(h.createPullRequest).not.toHaveBeenCalled();
  });

  it('classifies commit failure and never invokes push or PR creation', async () => {
    const h = harness([
      result(),
      result({ stdout: 'changed.ts\n' }),
      result({ stdout: 'diff content' }),
      result({ stdout: 'A changed.ts\n' }),
      result({ success: false, exitCode: 1, stderr: 'nothing to commit' }),
    ]);

    await expect(publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: commit',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    })).rejects.toMatchObject({ kind: 'git_commit_failed', retryable: false });

    expect(h.exec).toHaveBeenCalledTimes(5);
    expect(h.exec.mock.calls.some(([command]) => command.includes(' push --set-upstream'))).toBe(false);
    expect(h.createPullRequest).not.toHaveBeenCalled();
  });

  it('rejects an empty staged diff before commit or push', async () => {
    const h = harness([result(), result({ stdout: '\n' })]);

    await expect(publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: empty',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    })).rejects.toMatchObject({ kind: 'no_changes', retryable: false });

    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(h.createPullRequest).not.toHaveBeenCalled();
  });

  it('records diff, status, branch, SHA, and PR on success', async () => {
    const h = harness(successfulGitResults());

    const published = await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: `test: handle Kurt's case`,
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      artifactPrefix: 'tasks/task-2/',
    });

    expect(published).toEqual({
      branch: BRANCH,
      commitSha: SHA,
      prUrl: 'https://github.com/Stackbilt-dev/aegis/pull/1',
      changeKey: expect.stringMatching(/^[0-9a-f]{12}$/),
      attached: false,
    });
    expect(h.artifacts.get('tasks/task-2/diff.patch')).toContain('diff --git');
    expect(h.artifacts.get('tasks/task-2/git-status.txt')).toContain('example.test.ts');
    const publish = JSON.parse(
      h.artifacts.get('tasks/task-2/publish.json') ?? '{}',
    ) as PublicationArtifacts;
    expect(publish.stages.map(({ stage }) => stage)).toEqual([
      'git_add',
      'staged_files',
      'staged_diff',
      'git_status',
      'git_commit',
      'commit_sha',
      'git_push',
      'create_pr',
    ]);
    expect(h.exec.mock.calls[4]?.[0]).toContain(`'test: handle Kurt'\"'\"'s case'`);
  });

  it('runs every git command with hooks and fsmonitor disabled', async () => {
    const h = harness(successfulGitResults());
    await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: hooks',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    });
    const commands = h.exec.mock.calls.map(([command]) => String(command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('git -c core.hooksPath=/dev/null -c core.fsmonitor=false ');
    }
  });

  it('runs beforePush immediately before the push, and not when attaching to an open PR', async () => {
    const h = harness(successfulGitResults());
    const order: string[] = [];
    let pushed: unknown;
    await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: order',
      exec: async (command) => {
        order.push(command.includes(' push --set-upstream ') ? 'push' : 'other');
        return h.exec(command);
      },
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      beforePush: async (update) => {
        order.push('beforePush');
        pushed = update;
      },
    });
    expect(order.indexOf('beforePush')).toBe(order.indexOf('push') - 1);
    expect(pushed).toEqual({ branch: expect.any(String), commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });

    const attached = harness(successfulGitResults());
    const beforePush = vi.fn(async () => undefined);
    await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: order',
      exec: attached.exec,
      writeArtifact: attached.writeArtifact,
      createPullRequest: attached.createPullRequest,
      findOpenPullRequest: async () => 'https://github.com/o/r/pull/1',
      beforePush,
    });
    expect(beforePush).not.toHaveBeenCalled();
  });

  it('injects push credentials for one command without persisting them in artifacts', async () => {
    const h = harness(successfulGitResults());
    const token = 'github-secret';

    await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: authenticated push',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      artifactPrefix: 'tasks/task-auth/',
      secrets: [token],
      pushAuthHeader: `Authorization: ${githubBasicAuthorizationValue(token)}`,
    });

    expect(h.exec.mock.calls[6]?.[0]).toContain('http.extraHeader');
    expect(h.exec.mock.calls[6]?.[0]).toContain('Authorization: Basic');
    expect(h.exec.mock.calls[6]?.[0]).toContain(btoa(`x-access-token:${token}`));
    expect(h.exec.mock.calls[6]?.[0]).not.toContain(token);
    expect(JSON.stringify([...h.artifacts])).not.toContain(token);
  });

  it('classifies PR failure as retryable after a successful push', async () => {
    const h = harness(successfulGitResults());
    h.createPullRequest.mockRejectedValueOnce(new Error('GitHub returned 503'));

    await expect(publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'test: PR failure',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    })).rejects.toMatchObject({ kind: 'pr_create_failed', retryable: true });

    expect(h.exec.mock.calls.at(-1)?.[0]).toContain(' push --set-upstream');
    expect(h.createPullRequest).toHaveBeenCalledOnce();
  });

  it('rejects unsafe branch names before executing commands', async () => {
    const h = harness([]);

    await expect(publishBranch({
      repoPath: '/workspace/repo',
      branch: 'auto/task; curl attacker',
      commitMessage: 'test',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    })).rejects.toMatchObject({ kind: 'git_push_failed', retryable: false });

    expect(h.exec).not.toHaveBeenCalled();
  });
  // Publication identity is the change, not the attempt. Before this, the branch
  // was keyed on task id, so re-running the same work opened a new PR each time
  // (observed: 7 byte-identical canary PRs, aegis#733-#743).
  it('derives one branch per distinct change so repeated attempts converge', async () => {
    const staged = 'diff --git a/example b/example\nindex 81b28a2..e07388d 100644\n+added\n';
    const key = await computeChangeKey(staged);
    const results = [
      result(),
      result({ stdout: 'web/tests/example.test.ts\n' }),
      result({ stdout: staged }),
      result(),                                  // git branch -M
      result({ stdout: 'A  web/tests/example.test.ts\n' }),
      result({ stdout: '[branch abc123] test commit\n' }),
      result({ stdout: `${SHA}\n` }),
      result({ stdout: 'set up to track origin\n' }),
    ];
    const h = harness(results);

    const published = await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'chore: test',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      branchForChange: (changeKey) => `auto/do-sandbox/${changeKey}`,
    });

    expect(published.changeKey).toBe(key);
    expect(published.branch).toBe(`auto/do-sandbox/${key}`);
    expect(published.attached).toBe(false);
    // Renamed before the push, and the push targets the derived branch.
    expect(h.exec.mock.calls.map((c) => c[0]).join('\n')).toContain(`branch -M 'auto/do-sandbox/${key}'`);
    expect(h.exec.mock.calls.map((c) => c[0]).join('\n')).toContain(`push --set-upstream origin 'auto/do-sandbox/${key}'`);
    // The PR is opened against the derived branch, not the task-id branch.
    expect(h.createPullRequest).toHaveBeenCalledWith(`auto/do-sandbox/${key}`);
  });

  it('attaches to the existing PR instead of publishing a second copy', async () => {
    const staged = 'diff --git a/example b/example\n+added\n';
    const results = [
      result(),
      result({ stdout: 'web/tests/example.test.ts\n' }),
      result({ stdout: staged }),
      result(),                                  // git branch -M
      result({ stdout: 'A  web/tests/example.test.ts\n' }),
      result({ stdout: '[branch abc123] test commit\n' }),
      result({ stdout: `${SHA}\n` }),
    ];
    const h = harness(results);

    const published = await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'chore: test',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      branchForChange: (changeKey) => `auto/do-sandbox/${changeKey}`,
      findOpenPullRequest: async () => 'https://github.com/Stackbilt-dev/aegis/pull/733',
    });

    expect(published.attached).toBe(true);
    expect(published.prUrl).toBe('https://github.com/Stackbilt-dev/aegis/pull/733');
    // Neither a push nor a PR creation happened.
    expect(h.exec.mock.calls.map((c) => c[0]).join('\n')).not.toContain('push');
    expect(h.createPullRequest).not.toHaveBeenCalled();
  });

  it('publishes normally when the derived branch has no open PR', async () => {
    const staged = 'diff --git a/example b/example\n+added\n';
    const results = [
      result(),
      result({ stdout: 'web/tests/example.test.ts\n' }),
      result({ stdout: staged }),
      result(),
      result({ stdout: 'A  web/tests/example.test.ts\n' }),
      result({ stdout: '[branch abc123] test commit\n' }),
      result({ stdout: `${SHA}\n` }),
      result({ stdout: 'set up to track origin\n' }),
    ];
    const h = harness(results);

    const published = await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'chore: test',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
      branchForChange: (changeKey) => `auto/do-sandbox/${changeKey}`,
      findOpenPullRequest: async () => null,
    });

    expect(published.attached).toBe(false);
    expect(h.createPullRequest).toHaveBeenCalledOnce();
  });

  it('keeps the given branch when no change-addressing is configured', async () => {
    const h = harness(successfulGitResults());
    const published = await publishBranch({
      repoPath: '/workspace/repo',
      branch: BRANCH,
      commitMessage: 'chore: test',
      exec: h.exec,
      writeArtifact: h.writeArtifact,
      createPullRequest: h.createPullRequest,
    });
    expect(published.branch).toBe(BRANCH);
    expect(h.exec.mock.calls.map((c) => c[0]).join('\n')).not.toContain('branch -M');
  });
});

describe('computeChangeKey', () => {
  it('is stable for the same edit and ignores git blob metadata', async () => {
    // The seven duplicate canary PRs carried byte-identical diffs; only the
    // presented blob ids could have varied, so they must not affect identity.
    const a = 'diff --git a/f b/f\nindex 81b28a2..e07388d 100644\n--- a/f\n+++ b/f\n+line\n';
    const b = 'diff --git a/f b/f\nindex aaaaaaa..bbbbbbb 100644\n--- a/f\n+++ b/f\n+line\n';
    expect(await computeChangeKey(a)).toBe(await computeChangeKey(b));
  });

  it('separates different edits', async () => {
    const a = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n+one\n';
    const b = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n+two\n';
    expect(await computeChangeKey(a)).not.toBe(await computeChangeKey(b));
  });

  it('produces a branch-safe fixed-length key', async () => {
    const key = await computeChangeKey('diff --git a/f b/f\n+x\n');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('isPushRejected', () => {
  it('detects a fetch-first rejection', () => {
    expect(isPushRejected(result({
      success: false,
      exitCode: 1,
      stderr: ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n',
    }))).toBe(true);
  });

  it('does not treat a transport error as a rejection', () => {
    expect(isPushRejected(result({
      success: false,
      exitCode: 128,
      stderr: 'fatal: unable to access: The requested URL returned error: 503\n',
    }))).toBe(false);
  });
});

// The container runs these under sh, and cmd.exe quotes differently.
describe.skipIf(spawnSync('sh', ['-c', 'true']).status !== 0)('publishBranch against real git', () => {
  it('does not run an fsmonitor left in .git/config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-'));
    const sh = (command: string, cwd: string) => {
      try {
        return { success: true, exitCode: 0, stdout: execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe', shell: 'sh' }), stderr: '' };
      } catch (error) {
        return { success: false, exitCode: 1, stdout: '', stderr: String((error as { stderr?: unknown }).stderr ?? error) };
      }
    };
    try {
      const repo = join(root, 'repo');
      const ran = join(root, 'fsmonitor-ran');
      const setup = [
        `git init -q --bare ${join(root, 'remote.git')}`,
        `git init -q ${repo}`,
      ].map((command) => command.replace(/\\/g, '/'));
      for (const command of setup) expect(sh(command, root).success).toBe(true);
      for (const command of [
        'git config user.email a@example.com',
        'git config user.name a',
        `git remote add origin '${join(root, 'remote.git').replace(/\\/g, '/')}'`,
        `git checkout -q -b ${BRANCH}`,
      ]) expect(sh(command, repo).success).toBe(true);
      writeFileSync(join(repo, 'monitor.sh'), `#!/bin/sh\ntouch '${ran.replace(/\\/g, '/')}'\n`, { mode: 0o755 });
      writeFileSync(join(repo, 'file.txt'), 'content');
      expect(sh(`git config core.fsmonitor '${join(repo, 'monitor.sh').replace(/\\/g, '/')}'`, repo).success).toBe(true);

      // Proof that this git would run it.
      sh('git status --short', repo);
      expect(existsSync(ran)).toBe(true);
      rmSync(ran);

      const published = await publishBranch({
        repoPath: repo.replace(/\\/g, '/'),
        branch: BRANCH,
        commitMessage: 'test: fsmonitor',
        exec: async (command) => sh(command, root) as ExecResult,
        writeArtifact: async () => undefined,
        createPullRequest: async () => 'https://github.com/Stackbilt-dev/aegis/pull/1',
      });
      expect(published.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(ran)).toBe(false);
      expect(sh(`${STAGED_NUMSTAT_COMMAND}`, repo).success).toBe(true);
      expect(existsSync(ran)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
