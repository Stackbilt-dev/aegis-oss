// Credential broker for the sandbox's GitHub traffic.
//
// With a brokered sandbox the container only ever holds a placeholder token.
// These rules run in the Worker, outside the container: they decide what each
// outbound request may do and attach the real token on the way out. Reads are
// open, and only the task's own repositories can be written.

/** What a brokered sandbox uses in place of a GitHub token. Worthless outside it. */
export const SANDBOX_PLACEHOLDER_TOKEN = 'sandbox-placeholder-token';

/** The handler name the executor selects, with the task's scope as its params. */
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

/** What one task may do on github.com. The default is the empty scope: public reads only. */
export interface GitHubEgressScope {
  /** `owner/name` repositories this task may push to. */
  writeRepos: string[];
  /** Owners whose private repositories the token may read, for clones and sibling repos. */
  readOwners: string[];
}

export const EMPTY_GITHUB_SCOPE: GitHubEgressScope = { writeRepos: [], readOwners: [] };

export type GitHubEgressDecision =
  | { action: 'deny'; reason: string }
  | { action: 'forward'; authenticate: boolean };

// Smart-HTTP git, the only github.com traffic that ever carries the token.
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function isReadOnlyMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

export function decideGitHubEgress(method: string, url: URL, scope: GitHubEgressScope): GitHubEgressDecision {
  const match = GIT_PATH.exec(url.pathname);
  if (!match) {
    return isReadOnlyMethod(method)
      ? { action: 'forward', authenticate: false }
      : { action: 'deny', reason: `${method} ${url.pathname} is not git traffic` };
  }

  // GitHub treats owner and repository names case-insensitively, so these must too.
  const owner = match[1].toLowerCase();
  const repo = `${owner}/${match[2].toLowerCase()}`;
  const endpoint = match[3];

  const expectedMethod = endpoint === 'info/refs' ? isReadOnlyMethod(method) : method === 'POST';
  if (!expectedMethod) return { action: 'deny', reason: `${method} ${url.pathname} is not git traffic` };

  // The endpoint names the service, so a query string can't relabel a push as a read.
  const service = endpoint === 'info/refs' ? url.searchParams.get('service') : endpoint;
  const writable = scope.writeRepos.some((allowed) => allowed.toLowerCase() === repo);
  if (service === 'git-receive-pack') {
    return writable
      ? { action: 'forward', authenticate: true }
      : { action: 'deny', reason: `this task cannot push to ${repo}` };
  }
  if (service !== 'git-upload-pack') {
    return { action: 'deny', reason: `unsupported git service on ${repo}` };
  }
  return {
    action: 'forward',
    authenticate: writable || scope.readOwners.some((allowed) => allowed.toLowerCase() === owner),
  };
}

function blocked(reason: string): Response {
  return new Response(`Blocked by the sandbox egress policy: ${reason}\n`, { status: 403 });
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

  const headers = new Headers(request.headers);
  headers.delete('Authorization');
  return fetcher(new Request(request, { headers, redirect: 'manual' }));
}
