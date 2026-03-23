// GitHub API client tests — resolveRepoName, ghFetch retry logic, API wrappers
// Mocks global fetch to test pure logic without external calls

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import pure functions that don't need mocks
import {
  resolveRepoName,
  GitHubApiError,
  getRepoTree,
  getFileContent,
  getRecentCommits,
  listIssues,
  listPullRequests,
  listOrgRepos,
  createIssue,
  createBranch,
  createPullRequest,
  listWorkflowRuns,
  getCombinedStatus,
  mergePullRequest,
  searchIssues,
  closeIssue,
  commentOnIssue,
  addLabelsToIssue,
} from '../src/github.js';

// ─── resolveRepoName ──────────────────────────────────────────

describe('resolveRepoName', () => {
  it('resolves my-project alias to aegis', () => {
    expect(resolveRepoName('my-project')).toBe('ExampleOrg/aegis');
  });

  it('resolves bizops-copilot alias to example-app', () => {
    expect(resolveRepoName('bizops-copilot')).toBe('ExampleOrg/example-app');
  });

  it('preserves repo names without alias', () => {
    expect(resolveRepoName('charter')).toBe('ExampleOrg/charter');
  });

  it('uses default org when no org specified', () => {
    expect(resolveRepoName('img-forge')).toBe('ExampleOrg/img-forge');
  });

  it('preserves explicit org/repo format', () => {
    expect(resolveRepoName('octocat/hello-world')).toBe('octocat/hello-world');
  });

  it('resolves alias with explicit org', () => {
    expect(resolveRepoName('MyOrg/my-project')).toBe('MyOrg/aegis');
  });

  it('accepts custom default org', () => {
    expect(resolveRepoName('charter', 'CustomOrg')).toBe('CustomOrg/charter');
  });

  it('normalizes "exampleorg" org to ExampleOrg', () => {
    expect(resolveRepoName('exampleorg/docs')).toBe('ExampleOrg/docs');
  });

  it('normalizes "Exampleorg" org to ExampleOrg', () => {
    expect(resolveRepoName('Exampleorg/docs')).toBe('ExampleOrg/docs');
  });

  it('normalizes "exampleorg-dev" org to ExampleOrg', () => {
    expect(resolveRepoName('exampleorg-dev/charter')).toBe('ExampleOrg/charter');
  });

  it('preserves non-ExampleOrg org names', () => {
    expect(resolveRepoName('octocat/hello-world')).toBe('octocat/hello-world');
  });
});

// ─── GitHubApiError ───────────────────────────────────────────

describe('GitHubApiError', () => {
  it('formats error message correctly', () => {
    const err = new GitHubApiError(404, 'GET', '/repos/foo/bar', 'Not Found');
    expect(err.message).toBe('GitHub API 404 (GET /repos/foo/bar): Not Found');
    expect(err.status).toBe(404);
    expect(err.method).toBe('GET');
    expect(err.path).toBe('/repos/foo/bar');
    expect(err.body).toBe('Not Found');
  });

  it('is an instance of Error', () => {
    const err = new GitHubApiError(500, 'POST', '/test', 'fail');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GitHubApiError);
  });
});

// ─── API functions (mocked fetch) ─────────────────────────────

describe('GitHub API functions', () => {
  const token = 'ghp_test_token';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(data: unknown, status = 200) {
    const res = {
      ok: status >= 200 && status < 300,
      status,
      json: vi.fn().mockResolvedValue(data),
      text: vi.fn().mockResolvedValue(JSON.stringify(data)),
      headers: new Headers(),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    return res;
  }

  function mockFetchError(status: number, body: string, headers?: Record<string, string>) {
    const h = new Headers(headers);
    const res = {
      ok: false,
      status,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue(body),
      headers: h,
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    return res;
  }

  describe('getRepoTree', () => {
    it('returns flat file list filtering blobs only', async () => {
      mockFetch({
        tree: [
          { type: 'blob', path: 'src/index.ts' },
          { type: 'tree', path: 'src' },
          { type: 'blob', path: 'README.md' },
        ],
        truncated: false,
      });

      const files = await getRepoTree(token, 'ExampleOrg/aegis');
      expect(files).toEqual(['src/index.ts', 'README.md']);
    });
  });

  describe('getFileContent', () => {
    it('decodes base64 content', async () => {
      mockFetch({
        content: btoa('hello world'),
        encoding: 'base64',
      });

      const content = await getFileContent(token, 'ExampleOrg/aegis', 'README.md');
      expect(content).toBe('hello world');
    });

    it('throws on unexpected encoding', async () => {
      mockFetch({ content: 'foo', encoding: 'utf-8' });

      await expect(getFileContent(token, 'ExampleOrg/aegis', 'README.md'))
        .rejects.toThrow('Unexpected encoding: utf-8');
    });
  });

  describe('getRecentCommits', () => {
    it('maps commit data and extracts first line of message', async () => {
      mockFetch([
        {
          sha: 'abc123',
          commit: {
            message: 'feat: add thing\n\nMore details here',
            author: { name: 'Alex', date: '2026-03-10T00:00:00Z' },
          },
        },
      ]);

      const commits = await getRecentCommits(token, 'ExampleOrg/aegis', 1);
      expect(commits).toEqual([
        { sha: 'abc123', message: 'feat: add thing', author: 'Alex', date: '2026-03-10T00:00:00Z' },
      ]);
    });
  });

  describe('listIssues', () => {
    it('filters out pull requests', async () => {
      mockFetch([
        { number: 1, title: 'Issue', state: 'open', html_url: 'url1', body: 'body', labels: [{ name: 'bug' }], created_at: '2026-01-01', pull_request: undefined },
        { number: 2, title: 'PR', state: 'open', html_url: 'url2', body: '', labels: [], created_at: '2026-01-02', pull_request: { url: 'pr_url' } },
      ]);

      const issues = await listIssues(token, 'ExampleOrg/aegis');
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
      expect(issues[0].labels).toEqual(['bug']);
    });

    it('handles null body', async () => {
      mockFetch([
        { number: 1, title: 'Issue', state: 'open', html_url: 'url', body: null, labels: [], created_at: '2026-01-01' },
      ]);

      const issues = await listIssues(token, 'ExampleOrg/aegis');
      expect(issues[0].body).toBe('');
    });
  });

  describe('listPullRequests', () => {
    it('maps merged status from merged_at', async () => {
      mockFetch([
        { number: 10, title: 'PR1', state: 'closed', merged_at: '2026-01-01T00:00:00Z', html_url: 'url1', head: { ref: 'feat/a' }, base: { ref: 'main' }, created_at: '2026-01-01' },
        { number: 11, title: 'PR2', state: 'closed', merged_at: null, html_url: 'url2', head: { ref: 'feat/b' }, base: { ref: 'main' }, created_at: '2026-01-02' },
      ]);

      const prs = await listPullRequests(token, 'ExampleOrg/aegis', 'closed');
      expect(prs[0].merged).toBe(true);
      expect(prs[1].merged).toBe(false);
    });
  });

  describe('listOrgRepos', () => {
    it('maps org repo data', async () => {
      mockFetch([
        { name: 'aegis', description: 'AI agent', visibility: 'private', language: 'TypeScript', default_branch: 'main', updated_at: '2026-03-10', html_url: 'url' },
      ]);

      const repos = await listOrgRepos(token, 'ExampleOrg');
      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe('aegis');
      expect(repos[0].url).toBe('url');
    });
  });

  describe('createIssue', () => {
    it('returns issue number and url', async () => {
      mockFetch({ number: 42, html_url: 'https://github.com/org/repo/issues/42' });

      const result = await createIssue(token, 'ExampleOrg/aegis', 'Test', 'Body', ['bug']);
      expect(result).toEqual({ number: 42, url: 'https://github.com/org/repo/issues/42' });
    });
  });

  describe('createBranch', () => {
    it('throws readable error on 422 (branch exists)', async () => {
      mockFetchError(422, 'Reference already exists');

      await expect(createBranch(token, 'ExampleOrg/aegis', 'feat/x', 'abc'))
        .rejects.toThrow('Branch "feat/x" already exists');
    });
  });

  describe('createPullRequest', () => {
    it('returns PR number and url', async () => {
      mockFetch({ number: 99, html_url: 'https://github.com/org/repo/pull/99' });

      const result = await createPullRequest(token, 'ExampleOrg/aegis', 'Title', 'Body', 'feat/x');
      expect(result).toEqual({ number: 99, url: 'https://github.com/org/repo/pull/99' });
    });
  });

  describe('searchIssues', () => {
    it('maps search results', async () => {
      mockFetch({
        items: [
          { number: 5, title: 'Found', state: 'open', html_url: 'url5' },
        ],
      });

      const results = await searchIssues(token, 'ExampleOrg/aegis', 'bug');
      expect(results).toHaveLength(1);
      expect(results[0].number).toBe(5);
    });
  });

  describe('closeIssue', () => {
    it('posts comment then patches state', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockResolvedValue(''),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', fetchMock);

      await closeIssue(token, 'ExampleOrg/aegis', 1, 'Closing');
      // First call: comment, second call: patch state
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain('/comments');
      expect(fetchMock.mock.calls[1][0]).toContain('/issues/1');
    });

    it('skips comment if not provided', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
        text: vi.fn().mockResolvedValue(''),
        headers: new Headers(),
      });
      vi.stubGlobal('fetch', fetchMock);

      await closeIssue(token, 'ExampleOrg/aegis', 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('listWorkflowRuns', () => {
    it('maps workflow run data', async () => {
      mockFetch({
        workflow_runs: [
          { id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_branch: 'main', event: 'push', html_url: 'url1', created_at: '2026-01-01' },
        ],
      });

      const runs = await listWorkflowRuns(token, 'ExampleOrg/aegis');
      expect(runs).toHaveLength(1);
      expect(runs[0].conclusion).toBe('success');
      expect(runs[0].branch).toBe('main');
    });
  });

  describe('getCombinedStatus', () => {
    it('maps status data', async () => {
      mockFetch({
        state: 'success',
        total_count: 2,
        statuses: [
          { context: 'ci/test', state: 'success', description: 'All tests passed' },
        ],
      });

      const status = await getCombinedStatus(token, 'ExampleOrg/aegis', 'main');
      expect(status.state).toBe('success');
      expect(status.total).toBe(2);
      expect(status.statuses).toHaveLength(1);
    });
  });

  describe('mergePullRequest', () => {
    it('returns merge result', async () => {
      mockFetch({ sha: 'merge_sha', merged: true, message: 'Pull Request successfully merged' });

      const result = await mergePullRequest(token, 'ExampleOrg/aegis', 1);
      expect(result.merged).toBe(true);
      expect(result.sha).toBe('merge_sha');
    });
  });

  describe('ghFetch retry logic', () => {
    it('throws GitHubApiError on 404', async () => {
      mockFetchError(404, 'Not Found');

      await expect(getRepoTree(token, 'ExampleOrg/nonexistent'))
        .rejects.toThrow(GitHubApiError);
    });

    it('throws on rate limit (403 with x-ratelimit-remaining: 0)', async () => {
      mockFetchError(403, 'rate limited', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      });

      await expect(getRepoTree(token, 'ExampleOrg/aegis'))
        .rejects.toThrow(/Rate limited/);
    });

    it('retries on 500 with exponential backoff', async () => {
      const failRes = {
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Server Error'),
        headers: new Headers(),
      } as unknown as Response;

      const successRes = {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ tree: [], truncated: false }),
        headers: new Headers(),
      } as unknown as Response;

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(failRes)
        .mockResolvedValueOnce(successRes);
      vi.stubGlobal('fetch', fetchMock);

      const result = await getRepoTree(token, 'ExampleOrg/aegis');
      expect(result).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
