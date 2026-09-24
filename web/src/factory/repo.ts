// Repository targeting for the sandbox task executor.
//
// A task's `repo` is either a bare name, meaning a repository in the executor's
// home organization that it pushes to directly, or `owner/name` for a
// repository outside it. Outside repositories run in fork mode: clone the
// upstream, push the branch to a fork in the home organization, and open the
// PR on the upstream — the same path any outside contributor takes, so no
// access to the upstream is needed.

const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const FORK_READY_ATTEMPTS = 12;
const FORK_READY_DELAY_MS = 5_000;

export interface TaskRepoTarget {
  owner: string;
  name: string;
  /** True when the upstream lives outside the home organization and publication goes through a fork. */
  external: boolean;
}

export class RepoTargetError extends Error {
  constructor(
    readonly kind: 'invalid_repository' | 'fork_failed' | 'github_api_failed',
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'RepoTargetError';
  }
}

export function parseTaskRepo(repo: string, homeOrg: string): TaskRepoTarget {
  const parts = repo.trim().replace(/\.git$/, '').split('/');
  if (parts.length > 2 || parts.some((part) => !SLUG_RE.test(part))) {
    throw new RepoTargetError('invalid_repository', false, `repository must be "name" or "owner/name": ${repo}`);
  }
  const [owner, name] = parts.length === 2 ? parts : [homeOrg, parts[0]];
  const external = owner.toLowerCase() !== homeOrg.toLowerCase();
  return { owner: external ? owner : homeOrg, name, external };
}

/** Key for per-repository bootstrap recipes: the bare name in the home org, `owner/name` outside it. */
export function recipeKey(target: TaskRepoTarget): string {
  return target.external ? `${target.owner}/${target.name}` : target.name;
}

/** Fork name inside the home organization. Owner-prefixed so it cannot collide with an org repo. */
export function forkName(target: TaskRepoTarget): string {
  return `${target.owner}--${target.name}`;
}

/** `head` value for PR creation and lookup on the upstream. */
export function pullRequestHead(target: TaskRepoTarget, branch: string, homeOrg: string): string {
  return target.external ? `${homeOrg}:${branch}` : branch;
}

/**
 * The line that ties a published PR to the issue its task came from.
 *
 * An issue in the repository the PR targets gets a closing keyword, so GitHub
 * links and closes it, and PR-side checks such as the agent-acceptance Action
 * find the contract the maintainer wrote in that issue. An issue elsewhere gets
 * a non-closing reference. Returns null when the task has no usable link.
 */
export function issueReference(
  target: TaskRepoTarget,
  issueRepo: string | null | undefined,
  issueNumber: number | null | undefined,
): string | null {
  if (!issueRepo || !Number.isInteger(issueNumber) || (issueNumber as number) < 1) return null;
  const parts = issueRepo.trim().split('/');
  if (parts.length !== 2 || parts.some((part) => !SLUG_RE.test(part))) return null;
  const sameRepo = `${target.owner}/${target.name}`.toLowerCase() === issueRepo.trim().toLowerCase();
  return sameRepo ? `Fixes #${issueNumber}` : `Refs ${parts[0]}/${parts[1]}#${issueNumber}`;
}

export interface TaskAdmission {
  repo: string;
  executor: string;
  authority: string;
  hasAcceptanceSpec: boolean;
}

/** Decides whether a task may run. Returns the refusal reason, or null to admit it. */
export type ExternalRepoPolicy = (task: TaskAdmission, target: TaskRepoTarget, homeOrg: string) => string | null;

/**
 * Default policy for outside repositories. They run someone else's install
 * scripts and tests with your GitHub token nearby, so they are sandbox-only,
 * operator-authorized, and machine-checked: the acceptance block is the only
 * evidence the upstream's reviewer gets. Replace it through the executor
 * config to be stricter (an allowlist of owners) or looser.
 */
export const defaultExternalRepoPolicy: ExternalRepoPolicy = (task, target, homeOrg) => {
  if (!target.external) return null;
  if (task.executor !== 'do_sandbox') return `repositories outside ${homeOrg} run only on the do_sandbox executor`;
  if (task.authority !== 'operator') return `repositories outside ${homeOrg} need operator authority`;
  if (!task.hasAcceptanceSpec) return `repositories outside ${homeOrg} need an \`\`\`acceptance block`;
  return null;
};

/** Applies `policy` to a task, treating an unparseable `owner/name` as a refusal. */
export function externalRepoAdmissionError(
  task: TaskAdmission,
  homeOrg: string,
  policy: ExternalRepoPolicy = defaultExternalRepoPolicy,
): string | null {
  let target: TaskRepoTarget;
  try {
    target = parseTaskRepo(task.repo, homeOrg);
  } catch (error) {
    // Bare names with odd characters predate this rule; only owner/name is new.
    return task.repo.includes('/') ? (error as Error).message : null;
  }
  return policy(task, target, homeOrg);
}

export interface GitHubClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
}

export function gitHubClient(token: string, userAgent: string, fetchImpl: typeof fetch = fetch): GitHubClient {
  return {
    fetch: (path, init = {}) => fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function defaultBranch(client: GitHubClient, target: TaskRepoTarget): Promise<string> {
  const resp = await client.fetch(`/repos/${target.owner}/${target.name}`);
  if (!resp.ok) {
    throw new RepoTargetError('github_api_failed', resp.status >= 500, `repository lookup for ${target.owner}/${target.name} failed (${resp.status})`);
  }
  const data = (await resp.json()) as { default_branch?: string };
  return data.default_branch || 'main';
}

/**
 * Returns the home-org fork of an outside repository, creating it when absent.
 * GitHub creates forks asynchronously, so a new fork is polled until it exists.
 * A home-org repo under the fork name that is not a fork of this upstream is
 * refused rather than pushed to.
 */
export async function ensureFork(client: GitHubClient, target: TaskRepoTarget, homeOrg: string): Promise<string> {
  const upstream = `${target.owner}/${target.name}`.toLowerCase();
  const check = async (name: string): Promise<boolean> => {
    const resp = await client.fetch(`/repos/${homeOrg}/${name}`);
    if (resp.status === 404) return false;
    if (!resp.ok) {
      throw new RepoTargetError('github_api_failed', resp.status >= 500, `fork lookup for ${homeOrg}/${name} failed (${resp.status})`);
    }
    const data = (await resp.json()) as { fork?: boolean; parent?: { full_name?: string } };
    if (!data.fork || data.parent?.full_name?.toLowerCase() !== upstream) {
      throw new RepoTargetError('fork_failed', false, `${homeOrg}/${name} exists but is not a fork of ${upstream}`);
    }
    return true;
  };

  const preferred = forkName(target);
  if (await check(preferred)) return preferred;

  const create = await client.fetch(`/repos/${target.owner}/${target.name}/forks`, {
    method: 'POST',
    body: JSON.stringify({ organization: homeOrg, name: preferred, default_branch_only: true }),
  });
  if (!create.ok) {
    const body = (await create.text()).slice(0, 300);
    throw new RepoTargetError('fork_failed', create.status >= 500, `fork of ${upstream} failed (${create.status}): ${body}`);
  }
  // When the home org already forked this upstream under another name, GitHub
  // returns that fork instead of creating one, so poll the name it reports.
  const created = (await create.json()) as { name?: string };
  const name = created.name && SLUG_RE.test(created.name) ? created.name : preferred;
  for (let attempt = 0; attempt < FORK_READY_ATTEMPTS; attempt++) {
    if (await check(name)) return name;
    await client.sleep(FORK_READY_DELAY_MS);
  }
  throw new RepoTargetError('fork_failed', true, `fork ${homeOrg}/${name} was not ready after ${FORK_READY_ATTEMPTS} checks`);
}
