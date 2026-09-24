export interface GitCloneSandbox {
  exec(command: string): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export class RepositoryCloneError extends Error {
  constructor(
    readonly kind: 'github_token_missing' | 'invalid_repository' | 'git_clone_failed',
    readonly retryable: boolean,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryCloneError';
  }
}

export function githubBasicAuthorizationValue(token: string): string {
  if (!token.trim()) {
    throw new RepositoryCloneError(
      'github_token_missing',
      false,
      1,
      'GitHub token is not configured for sandbox repository access',
    );
  }
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

export function buildRepositoryCloneCommand(
  repo: string,
  token: string,
  repoPath: string,
  org: string,
): string {
  const authorization = githubBasicAuthorizationValue(token);
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || !/^[A-Za-z0-9._-]+$/.test(org)) {
    throw new RepositoryCloneError(
      'invalid_repository',
      false,
      1,
      'repository owner and name must be safe GitHub slugs',
    );
  }

  const url = `https://github.com/${org}/${repo}.git`;
  return [
    'git',
    '-c http.version=HTTP/1.1',
    `-c http.extraHeader=${shellQuote(`Authorization: ${authorization}`)}`,
    'clone --depth 1',
    shellQuote(url),
    shellQuote(repoPath),
  ].join(' ');
}

export async function cloneRepository(options: {
  sandbox: GitCloneSandbox;
  repo: string;
  token: string;
  repoPath: string;
  org: string;
}): Promise<void> {
  const result = await options.sandbox.exec(buildRepositoryCloneCommand(
    options.repo,
    options.token,
    options.repoPath,
    options.org,
  ));
  if (!result.success) {
    throw new RepositoryCloneError(
      'git_clone_failed',
      true,
      result.exitCode || 1,
      `git clone failed: ${(result.stderr || result.stdout).slice(0, 500)}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
