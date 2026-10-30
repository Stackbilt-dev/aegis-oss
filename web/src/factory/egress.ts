// Credential broker for the sandbox's GitHub traffic.
//
// With a brokered sandbox the container only ever holds a placeholder token.
// These rules run in the Worker, outside the container: they decide what each
// outbound request may do and attach the real token on the way out.
//
// The scope changes as a task moves, so code from the repository and the model
// never holds private reads and write access together, which is what would let
// it publish one repository's contents to another:
//
//   clone and bootstrap   reads the task's repository and its declared siblings
//   model and tests       public reads only
//   the executor's push   writes the one repository it publishes to

/** What a brokered sandbox uses in place of a GitHub token. Worthless outside it. */
export const SANDBOX_PLACEHOLDER_TOKEN = 'sandbox-placeholder-token';

/** The handler name the executor selects, with the task's current scope as its params. */
export const GITHUB_SCOPED_HANDLER = 'githubScoped';

/**
 * Everything a brokered sandbox can reach. Hosts other than github.com are
 * read-only (see brokerReadOnlyRequest): a container that could write to a
 * package registry could publish repository contents to a package of its own.
 */
export const SANDBOX_EGRESS_HOSTS = [
  'github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
];

/** What github.com allows right now. The default is the empty scope: public reads only. */
export interface GitHubEgressScope {
  /** `owner/name` repositories that may be pushed to. */
  writeRepos: string[];
  /** `owner/name` repositories the token may read, beyond what's public. */
  readRepos: string[];
}

export const EMPTY_GITHUB_SCOPE: GitHubEgressScope = { writeRepos: [], readRepos: [] };

export type GitHubEgressDecision =
  | { action: 'deny'; reason: string }
  | { action: 'forward'; authenticate: boolean };

// Smart-HTTP git, the only github.com traffic that ever carries the token.
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Marks a refusal as this policy's, which is how the self-test tells it from any other error. */
const BLOCK_MARKER = 'Blocked by the sandbox egress policy';

function isReadOnlyMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function listed(repos: string[], repo: string): boolean {
  return repos.some((allowed) => allowed.toLowerCase() === repo);
}

export function decideGitHubEgress(method: string, url: URL, scope: GitHubEgressScope): GitHubEgressDecision {
  if (url.protocol !== 'https:') return { action: 'deny', reason: `${url.protocol} is not allowed` };

  const match = GIT_PATH.exec(url.pathname);
  if (!match) {
    return isReadOnlyMethod(method)
      ? { action: 'forward', authenticate: false }
      : { action: 'deny', reason: `${method} ${url.pathname} is not git traffic` };
  }

  // GitHub treats owner and repository names case-insensitively, so these must too.
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  const endpoint = match[3];

  const expectedMethod = endpoint === 'info/refs' ? isReadOnlyMethod(method) : method === 'POST';
  if (!expectedMethod) return { action: 'deny', reason: `${method} ${url.pathname} is not git traffic` };

  // The endpoint names the service, so a query string can't relabel a push as a read.
  const service = endpoint === 'info/refs' ? url.searchParams.get('service') : endpoint;
  const writable = listed(scope.writeRepos, repo);
  if (service === 'git-receive-pack') {
    return writable
      ? { action: 'forward', authenticate: true }
      : { action: 'deny', reason: `pushing to ${repo} is not allowed now` };
  }
  if (service !== 'git-upload-pack') {
    return { action: 'deny', reason: `unsupported git service on ${repo}` };
  }
  return { action: 'forward', authenticate: writable || listed(scope.readRepos, repo) };
}

function blocked(reason: string): Response {
  return new Response(`${BLOCK_MARKER}: ${reason}\n`, { status: 403 });
}

/** Applies the rules to one request. A placeholder never reaches GitHub; a denied request never leaves. */
export async function brokerGitHubRequest(
  request: Request,
  token: string,
  scope: GitHubEgressScope,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const decision = decideGitHubEgress(request.method, new URL(request.url), scope);
  if (decision.action === 'deny') return blocked(decision.reason);

  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  if (decision.authenticate) {
    if (!token.trim()) return blocked('no GitHub token is configured');
    headers.set('Authorization', `Basic ${btoa(`x-access-token:${token}`)}`);
  }
  // Redirects go back to the container, which asks again and is checked again.
  return fetcher(new Request(request, { headers, redirect: 'manual' }));
}

/** For hosts the sandbox only reads from, without credentials. */
export async function brokerReadOnlyRequest(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!isReadOnlyMethod(request.method)) return blocked(`${request.method} is read-only here`);
  if (new URL(request.url).protocol !== 'https:') return blocked('only https is allowed');

  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  return fetcher(new Request(request, { headers, redirect: 'manual' }));
}

export class EgressNotEnforcedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressNotEnforcedError';
  }
}

interface ExecSurface {
  exec(command: string, options?: { timeout?: number }): Promise<{ success: boolean; stdout: string; stderr: string }>;
}

const SELF_TEST_TIMEOUT_SECONDS = 20;

function curl(arguments_: string): string {
  return `curl -sS --max-time ${SELF_TEST_TIMEOUT_SECONDS} ${arguments_} 2>&1`;
}

/**
 * Proves from inside the container that the policy is live, before any
 * repository code runs. If the handlers weren't reached, allowed hosts would be
 * wide open while the executor's own requests still looked fine, so a push that
 * should be refused has to come back refused by this policy, not merely fail.
 */
export async function assertEgressEnforced(sandbox: ExecSurface): Promise<void> {
  const timeout = (SELF_TEST_TIMEOUT_SECONDS + 5) * 1_000;
  const refused = [
    'https://github.com/sandbox-egress-self-test/none.git/git-receive-pack',
    'https://registry.npmjs.org/-/sandbox-egress-self-test',
  ];
  for (const url of refused) {
    const result = await sandbox.exec(curl(`-X POST -d x ${url}`), { timeout });
    if (!result.stdout.includes(BLOCK_MARKER)) {
      throw new EgressNotEnforcedError(`POST ${url} was not refused by the policy: ${result.stdout.slice(0, 300)}`);
    }
  }
  const closed = await sandbox.exec(curl('-o /dev/null -w "%{http_code}" https://example.com/'), { timeout });
  if (closed.stdout.trim().endsWith('200')) {
    throw new EgressNotEnforcedError('https://example.com/ is reachable, so the network is not closed');
  }
}
