import { describe, expect, it, vi } from 'vitest';
import {
  RepositoryCloneError,
  buildRepositoryCloneCommand,
  cloneRepository,
} from '../../src/factory/git.js';

describe('TaskExecutorDO repository clone', () => {
  it('forces HTTP/1.1 and keeps the credential in a per-command header', () => {
    const command = buildRepositoryCloneCommand('aegis', 'secret-token', '/workspace/repo', 'Stackbilt-dev');

    expect(command).toContain('-c http.version=HTTP/1.1');
    expect(command).toContain(
      `http.extraHeader='Authorization: Basic ${btoa('x-access-token:secret-token')}'`,
    );
    expect(command).not.toContain('secret-token');
    expect(command).toContain("'https://github.com/Stackbilt-dev/aegis.git'");
    expect(command).toContain("'/workspace/repo'");
  });

  it('rejects missing credentials and unsafe repository names before execution', () => {
    expect(() => buildRepositoryCloneCommand('aegis', '', '/workspace/repo', 'Stackbilt-dev'))
      .toThrowError(expect.objectContaining({ kind: 'github_token_missing', retryable: false }));
    expect(() => buildRepositoryCloneCommand('aegis; curl example.com', 'token', '/workspace/repo', 'Stackbilt-dev'))
      .toThrowError(expect.objectContaining({ kind: 'invalid_repository', retryable: false }));
  });

  it('classifies Git transport failures as retryable', async () => {
    const sandbox = {
      exec: vi.fn(async () => ({
        success: false,
        exitCode: 128,
        stdout: '',
        stderr: 'HTTP/2 stream was not closed cleanly',
      })),
    };

    await expect(cloneRepository({
      sandbox,
      repo: 'aegis',
      token: 'token',
      repoPath: '/workspace/repo',
    })).rejects.toMatchObject<Partial<RepositoryCloneError>>({
      kind: 'git_clone_failed',
      retryable: true,
      exitCode: 128,
    });
  });
});
