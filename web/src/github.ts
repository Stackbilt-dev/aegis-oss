// GitHub REST API v3 — fetch-based, no external dependencies
// Follows the same pattern as groq.ts (pure fetch, no imports)

const GITHUB_API = 'https://api.github.com';
const RETRY_STATUSES = new Set([500, 502, 503]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

// Local directory name → GitHub repo name (when they differ)
// BizOps may list projects with names that don't match GitHub repos —
// add aliases here to prevent 404 loops in goal execution.
const REPO_ALIASES: Record<string, string> = {
  'my-project': 'aegis',
  'bizops-copilot': 'example-app',
  // Add your repo aliases here,
  // 'docs': 'docs',
};

// Known org name variants that should resolve to the canonical GitHub org.
// LLMs in goal loops often guess shortened org names instead of the full canonical org.
const ORG_ALIASES: Record<string, string> = {
  'exampleorg': 'ExampleOrg',
  'Exampleorg': 'ExampleOrg',
  'exampleorg-dev': 'ExampleOrg',
};

/** Normalize a repo slug: resolve aliases and ensure org/repo format. */
export function resolveRepoName(repo: string, defaultOrg = 'ExampleOrg'): string {
  const parts = repo.split('/');
  const rawOrg = parts.length > 1 ? parts[0] : defaultOrg;
  const org = ORG_ALIASES[rawOrg] ?? rawOrg;
  const raw = parts.length > 1 ? parts[1] : parts[0];
  const name = raw.replace(/\.git$/, '');
  const resolved = REPO_ALIASES[name] ?? name;
  return `${org}/${resolved}`;
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: string,
  ) {
    super(`GitHub API ${status} (${method} ${path}): ${body}`);
  }
}

function ghHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aegis-worker/1.0',
  };
}

async function ghFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: { ...ghHeaders(token), ...(init?.headers ?? {}) },
    });

    if (res.ok) return res;

    const errText = await res.text();

    // Rate limit: primary (403 + x-ratelimit-remaining: 0)
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const resetEpoch = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);
        const waitSec = Math.max(0, resetEpoch - Math.floor(Date.now() / 1000));
        throw new GitHubApiError(403, method, path, `Rate limited — resets in ${waitSec}s`);
      }
    }

    // Rate limit: secondary (429 + retry-after)
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
      if (attempt < MAX_RETRIES && retryAfter <= 10) {
        console.warn(`[github] 429 on ${method} ${path}, retry-after ${retryAfter}s (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new GitHubApiError(429, method, path, `Secondary rate limit — retry after ${retryAfter}s`);
    }

    // Transient server errors — retry with exponential backoff
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[github] ${res.status} on ${method} ${path}, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    throw new GitHubApiError(res.status, method, path, errText);
  }

  // Should not reach here, but satisfy TypeScript
  throw new GitHubApiError(500, method, path, 'Exhausted retries');
}

// ─── Read operations ──────────────────────────────────────────────────────────

// Returns flat list of all file paths in the repo (blob entries only)
export async function getRepoTree(token: string, repo: string, branch = 'main'): Promise<string[]> {
  const res = await ghFetch(token, `/repos/${repo}/git/trees/${branch}?recursive=1`);
  const data = (await res.json()) as { tree: { type: string; path: string }[]; truncated: boolean };
  if (data.truncated) {
    console.warn('[github] repo tree truncated — large repo');
  }
  return data.tree.filter((e) => e.type === 'blob').map((e) => e.path);
}

// Returns decoded UTF-8 content of a single file
export async function getFileContent(
  token: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  // Encode each segment individually — do NOT encode slashes or GitHub treats the whole path as one filename
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await ghFetch(token, `/repos/${repo}/contents/${encodedPath}${query}`);
  const data = (await res.json()) as { content: string; encoding: string };
  if (data.encoding !== 'base64') throw new Error(`Unexpected encoding: ${data.encoding}`);
  // atob is available in Workers runtime
  return atob(data.content.replace(/\n/g, ''));
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export async function getRecentCommits(
  token: string,
  repo: string,
  limit = 10,
): Promise<Commit[]> {
  const res = await ghFetch(token, `/repos/${repo}/commits?per_page=${Math.min(limit, 100)}`);
  const data = (await res.json()) as {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
  }[];
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message.split('\n')[0], // first line only
    author: c.commit.author.name,
    date: c.commit.author.date,
  }));
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  body: string;
  created_at: string;
  assignee: string | null;
}

export async function listIssues(
  token: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
  labels?: string[],
): Promise<Issue[]> {
  let url = `/repos/${repo}/issues?state=${state}&per_page=30`;
  if (labels?.length) url += `&labels=${labels.join(',')}`;
  const res = await ghFetch(token, url);
  const data = (await res.json()) as {
    number: number;
    title: string;
    state: string;
    html_url: string;
    body: string | null;
    labels: { name: string }[];
    created_at: string;
    pull_request?: unknown;
    assignee?: { login: string } | null;
  }[];
  // Filter out PRs (they appear in the issues endpoint)
  return data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      labels: i.labels.map((l) => l.name),
      body: i.body ?? '',
      created_at: i.created_at,
      assignee: i.assignee?.login ?? null,
    }));
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  url: string;
  head: string;
  base: string;
  created_at: string;
}

export async function listPullRequests(
  token: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<PullRequest[]> {
  const res = await ghFetch(token, `/repos/${repo}/pulls?state=${state}&per_page=30`);
  const data = (await res.json()) as {
    number: number;
    title: string;
    state: string;
    merged_at: string | null;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    created_at: string;
  }[];
  return data.map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    merged: p.merged_at !== null,
    url: p.html_url,
    head: p.head.ref,
    base: p.base.ref,
    created_at: p.created_at,
  }));
}

export interface OrgRepo {
  name: string;
  description: string | null;
  visibility: string;
  language: string | null;
  default_branch: string;
  updated_at: string;
  url: string;
}

export async function listOrgRepos(
  token: string,
  org: string,
  type: 'all' | 'public' | 'private' = 'all',
): Promise<OrgRepo[]> {
  const res = await ghFetch(token, `/orgs/${org}/repos?type=${type}&sort=updated&per_page=30`);
  const data = (await res.json()) as {
    name: string;
    description: string | null;
    visibility: string;
    language: string | null;
    default_branch: string;
    updated_at: string;
    html_url: string;
  }[];
  return data.map((r) => ({
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    language: r.language,
    default_branch: r.default_branch,
    updated_at: r.updated_at,
    url: r.html_url,
  }));
}

// ─── Write operations ─────────────────────────────────────────────────────────

export async function createIssue(
  token: string,
  repo: string,
  title: string,
  body: string,
  labels?: string[],
): Promise<{ number: number; url: string }> {
  const res = await ghFetch(token, `/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels: labels ?? [] }),
  });
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}

export async function createBranch(
  token: string,
  repo: string,
  branchName: string,
  fromSha: string,
): Promise<void> {
  try {
    await ghFetch(token, `/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
    });
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 422) {
      throw new Error(`Branch "${branchName}" already exists in ${repo}`);
    }
    throw err;
  }
}

// Returns the blob SHA of a file — required by the Contents API PUT for optimistic concurrency
export async function getFileSha(
  token: string,
  repo: string,
  path: string,
  branch?: string,
): Promise<string> {
  const query = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await ghFetch(token, `/repos/${repo}/contents/${encodedPath}${query}`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

// Updates a single file on an existing branch (single-file PR scope)
export async function updateFile(
  token: string,
  repo: string,
  path: string,
  content: string, // UTF-8 string — encoded internally
  message: string,
  sha: string, // current blob SHA from getFileSha()
  branch: string,
): Promise<void> {
  // btoa is available in Workers runtime
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  await ghFetch(token, `/repos/${repo}/contents/${encodedPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: btoa(content), sha, branch }),
  });
}

export async function createPullRequest(
  token: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base = 'main',
): Promise<{ number: number; url: string }> {
  const res = await ghFetch(token, `/repos/${repo}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base, maintainer_can_modify: true }),
  });
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}

// ─── Issue lifecycle ──────────────────────────────────────────────────────────

export interface SearchIssueResult {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

/** Search issues in a repo using the GitHub Search API. repo is 'owner/name'. */
export async function searchIssues(
  token: string,
  repo: string,
  query: string,
): Promise<SearchIssueResult[]> {
  const q = encodeURIComponent(`repo:${repo} is:issue ${query}`);
  const res = await ghFetch(token, `/search/issues?q=${q}&per_page=10`);
  const data = (await res.json()) as {
    items: Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
    }>;
  };
  return data.items.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    html_url: i.html_url,
  }));
}

/** Close an issue with an optional comment. */
export async function closeIssue(
  token: string,
  repo: string,
  issueNumber: number,
  comment?: string,
): Promise<void> {
  // Post comment first if provided
  if (comment) {
    await commentOnIssue(token, repo, issueNumber, comment);
  }
  await ghFetch(token, `/repos/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
}

/** Add a comment to an issue. */
export async function commentOnIssue(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await ghFetch(token, `/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

/** Add labels to an existing issue. */
export async function addLabelsToIssue(
  token: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await ghFetch(token, `/repos/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labels }),
  });
}

// ─── Git Data API (multi-file commits) (#36) ─────────────────

export async function createBlob(
  token: string,
  repo: string,
  content: string,
  encoding: 'utf-8' | 'base64' = 'utf-8',
): Promise<string> {
  const res = await ghFetch(token, `/repos/${repo}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, encoding }),
  });
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

export async function getBaseTreeSha(
  token: string,
  repo: string,
  commitSha: string,
): Promise<string> {
  const res = await ghFetch(token, `/repos/${repo}/git/commits/${commitSha}`);
  const data = (await res.json()) as { tree: { sha: string } };
  return data.tree.sha;
}

export async function createTree(
  token: string,
  repo: string,
  baseTreeSha: string,
  files: Array<{ path: string; blobSha: string }>,
): Promise<string> {
  const tree = files.map(f => ({
    path: f.path,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: f.blobSha,
  }));
  const res = await ghFetch(token, `/repos/${repo}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

export async function createGitCommit(
  token: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string,
): Promise<string> {
  const res = await ghFetch(token, `/repos/${repo}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

export async function updateRef(
  token: string,
  repo: string,
  ref: string,
  commitSha: string,
): Promise<void> {
  await ghFetch(token, `/repos/${repo}/git/refs/${ref}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
}

// ─── CI Status (Actions + Status API) ────────────────────────

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  event: string;
  url: string;
  created_at: string;
}

export async function listWorkflowRuns(
  token: string,
  repo: string,
  branch?: string,
  limit = 5,
): Promise<WorkflowRun[]> {
  const params = new URLSearchParams({ per_page: String(Math.min(limit, 20)) });
  if (branch) params.set('branch', branch);
  const res = await ghFetch(token, `/repos/${repo}/actions/runs?${params}`);
  const data = (await res.json()) as {
    workflow_runs: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      event: string;
      html_url: string;
      created_at: string;
    }[];
  };
  return data.workflow_runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch,
    event: r.event,
    url: r.html_url,
    created_at: r.created_at,
  }));
}

export interface CombinedStatus {
  state: string;
  total: number;
  statuses: { context: string; state: string; description: string }[];
}

export async function getCombinedStatus(
  token: string,
  repo: string,
  ref: string,
): Promise<CombinedStatus> {
  const res = await ghFetch(token, `/repos/${repo}/commits/${encodeURIComponent(ref)}/status`);
  const data = (await res.json()) as {
    state: string;
    total_count: number;
    statuses: { context: string; state: string; description: string }[];
  };
  return {
    state: data.state,
    total: data.total_count,
    statuses: data.statuses.map((s) => ({
      context: s.context,
      state: s.state,
      description: s.description,
    })),
  };
}

// ─── PR Stats ────────────────────────────────────────────────

export interface PullRequestStats {
  number: number;
  state: string;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changed_files: number;
  head: string;
  base: string;
}

export async function getPullRequestStats(
  token: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestStats> {
  const res = await ghFetch(token, `/repos/${repo}/pulls/${pullNumber}`);
  const data = (await res.json()) as {
    number: number;
    state: string;
    mergeable: boolean | null;
    additions: number;
    deletions: number;
    changed_files: number;
    head: { ref: string };
    base: { ref: string };
  };
  return {
    number: data.number,
    state: data.state,
    mergeable: data.mergeable,
    additions: data.additions,
    deletions: data.deletions,
    changed_files: data.changed_files,
    head: data.head.ref,
    base: data.base.ref,
  };
}

// ─── PR Changed Files ────────────────────────────────────────

export async function getPullRequestFiles(
  token: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const res = await ghFetch(token, `/repos/${repo}/pulls/${pullNumber}/files?per_page=100`);
  const data = (await res.json()) as { filename: string }[];
  return data.map(f => f.filename);
}

// ─── PR Merge ────────────────────────────────────────────────

export async function mergePullRequest(
  token: string,
  repo: string,
  pullNumber: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
  commitMessage?: string,
): Promise<{ sha: string; merged: boolean; message: string }> {
  const body: Record<string, unknown> = { merge_method: method };
  if (commitMessage) body.commit_message = commitMessage;
  const res = await ghFetch(token, `/repos/${repo}/pulls/${pullNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { sha: string; merged: boolean; message: string };
}
