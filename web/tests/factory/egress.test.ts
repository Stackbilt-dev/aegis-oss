import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_GITHUB_SCOPE,
  SANDBOX_EGRESS_HOSTS,
  SANDBOX_PLACEHOLDER_TOKEN,
  brokerGitHubRequest,
  brokerReadOnlyRequest,
  decideGitHubEgress,
  type GitHubEgressScope,
} from '../../src/factory/egress.js';

const scope: GitHubEgressScope = { writeRepos: ['Stackbilt-dev/aegis'], readOwners: ['Stackbilt-dev'] };
const github = (path: string) => new URL(`https://github.com${path}`);
const authenticated = { action: 'forward', authenticate: true };
const anonymous = { action: 'forward', authenticate: false };

function capture() {
  const seen: Request[] = [];
  const fetcher = vi.fn(async (request: Request) => {
    seen.push(request);
    return new Response('ok');
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

function placeholderRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://github.com${path}`, {
    ...init,
    headers: { Authorization: `Basic ${btoa(`x-access-token:${SANDBOX_PLACEHOLDER_TOKEN}`)}` },
  });
}

describe('decideGitHubEgress', () => {
  it('lets a task push only to its own repository', () => {
    expect(decideGitHubEgress('GET', github('/Stackbilt-dev/aegis.git/info/refs?service=git-receive-pack'), scope)).toEqual(authenticated);
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/aegis.git/git-receive-pack'), scope)).toEqual(authenticated);
    expect(decideGitHubEgress('POST', github('/attacker/loot.git/git-receive-pack'), scope).action).toBe('deny');
    expect(decideGitHubEgress('GET', github('/attacker/loot.git/info/refs?service=git-receive-pack'), scope).action).toBe('deny');
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/other.git/git-receive-pack'), scope).action).toBe('deny');
  });

  it('matches repositories case-insensitively, with or without .git', () => {
    expect(decideGitHubEgress('POST', github('/stackbilt-dev/AEGIS/git-receive-pack'), scope)).toEqual(authenticated);
  });

  it('authenticates reads only for allowed owners', () => {
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/contracts.git/git-upload-pack'), scope)).toEqual(authenticated);
    expect(decideGitHubEgress('GET', github('/Stackbilt-dev/contracts.git/info/refs?service=git-upload-pack'), scope)).toEqual(authenticated);
    expect(decideGitHubEgress('POST', github('/someone/public.git/git-upload-pack'), scope)).toEqual(anonymous);
  });

  it('allows anonymous reads and refuses every push with the empty scope', () => {
    expect(decideGitHubEgress('GET', github('/someone/public/archive/main.zip'), EMPTY_GITHUB_SCOPE)).toEqual(anonymous);
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/aegis.git/git-upload-pack'), EMPTY_GITHUB_SCOPE)).toEqual(anonymous);
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/aegis.git/git-receive-pack'), EMPTY_GITHUB_SCOPE).action).toBe('deny');
  });

  it('refuses non-git writes, wrong methods and unknown git services', () => {
    expect(decideGitHubEgress('POST', github('/login/oauth/access_token'), scope).action).toBe('deny');
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/aegis/info/lfs/objects/batch'), scope).action).toBe('deny');
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/aegis.git/info/refs?service=git-upload-pack'), scope).action).toBe('deny');
    expect(decideGitHubEgress('GET', github('/Stackbilt-dev/aegis.git/git-receive-pack'), scope).action).toBe('deny');
    expect(decideGitHubEgress('GET', github('/Stackbilt-dev/aegis.git/info/refs'), scope).action).toBe('deny');
  });

  it('does not let a query string relabel a push as a read', () => {
    expect(decideGitHubEgress('POST', github('/attacker/loot.git/git-receive-pack?service=git-upload-pack'), scope).action).toBe('deny');
  });
});

describe('brokerGitHubRequest', () => {
  it('swaps the placeholder for the real token on an allowed push and keeps the body', async () => {
    const { fetcher, seen } = capture();
    const response = await brokerGitHubRequest(
      placeholderRequest('/Stackbilt-dev/aegis.git/git-receive-pack', { method: 'POST', body: 'pack' }),
      'real-token',
      scope,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(seen[0].headers.get('Authorization')).toBe(`Basic ${btoa('x-access-token:real-token')}`);
    expect(await seen[0].text()).toBe('pack');
  });

  it('blocks a denied push with no outbound request and no token in the reply', async () => {
    const { fetcher } = capture();
    const response = await brokerGitHubRequest(
      placeholderRequest('/attacker/loot.git/git-receive-pack', { method: 'POST', body: 'pack' }),
      'real-token',
      scope,
      fetcher,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('real-token');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('strips the placeholder from anonymous traffic', async () => {
    const { fetcher, seen } = capture();
    await brokerGitHubRequest(placeholderRequest('/someone/public/archive/main.zip'), 'real-token', scope, fetcher);
    expect(seen[0].headers.get('Authorization')).toBeNull();
  });

  it('refuses an authenticated request when no token is configured', async () => {
    const { fetcher } = capture();
    const response = await brokerGitHubRequest(
      placeholderRequest('/Stackbilt-dev/aegis.git/git-upload-pack', { method: 'POST' }),
      ' ',
      scope,
      fetcher,
    );
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('leaves redirects to the container, so each hop is checked', async () => {
    const { fetcher, seen } = capture();
    await brokerGitHubRequest(placeholderRequest('/someone/public/archive/main.zip'), 'real-token', scope, fetcher);
    expect(seen[0].redirect).toBe('manual');
  });
});

describe('brokerReadOnlyRequest', () => {
  it('forwards reads with no credentials', async () => {
    const { fetcher, seen } = capture();
    await brokerReadOnlyRequest(
      new Request('https://registry.npmjs.org/vitest', { headers: { Authorization: 'Bearer x' } }),
      fetcher,
    );
    expect(seen[0].headers.get('Authorization')).toBeNull();
  });

  it('refuses a write, which is how a package publish would leave', async () => {
    const { fetcher } = capture();
    const response = await brokerReadOnlyRequest(
      new Request('https://registry.npmjs.org/stolen', { method: 'PUT', body: '{}' }),
      fetcher,
    );
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('SANDBOX_EGRESS_HOSTS', () => {
  it('leaves out the GitHub API, which only the Worker calls', () => {
    expect(SANDBOX_EGRESS_HOSTS).not.toContain('api.github.com');
  });
});
