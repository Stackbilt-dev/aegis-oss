import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_GITHUB_SCOPE,
  EgressNotEnforcedError,
  SANDBOX_EGRESS_HOSTS,
  SANDBOX_PLACEHOLDER_TOKEN,
  assertEgressEnforced,
  assertEgressScope,
  brokerGitHubRequest,
  brokerReadOnlyRequest,
  decideGitHubEgress,
  type GitHubEgressScope,
} from '../../src/factory/egress.js';

const scope: GitHubEgressScope = { writeRepos: ['Stackbilt-dev/aegis'], readRepos: ['Stackbilt-dev/contracts'] };
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

const OLD_SHA = '0'.repeat(40);
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const REF = 'refs/heads/auto/do-sandbox/abc';
const PUSH = '/Stackbilt-dev/aegis.git/git-receive-pack';
const pushScope: GitHubEgressScope = { writeRepos: ['Stackbilt-dev/aegis'], readRepos: [], pushUpdate: { ref: REF, sha: COMMIT } };

function pkt(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
}

/** What git sends: shallow boundaries, commands with capabilities on the first, a flush, then the pack. */
function pushBody(commands: string[], pack = 'PACKdata', shallow: string[] = []): string {
  return [
    ...shallow.map((sha) => pkt(`shallow ${sha}`)),
    ...commands.map((command, index) => pkt(index === 0 ? `${command}\0 report-status agent=git/2\n` : `${command}\n`)),
    '0000',
    pack,
  ].join('');
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

  it('authenticates reads only for listed repositories', () => {
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/secret.git/git-upload-pack'), scope)).toEqual(anonymous);
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/contracts.git/git-upload-pack'), scope)).toEqual(authenticated);
    expect(decideGitHubEgress('GET', github('/Stackbilt-dev/contracts.git/info/refs?service=git-upload-pack'), scope)).toEqual(authenticated);
    expect(decideGitHubEgress('POST', github('/someone/public.git/git-upload-pack'), scope)).toEqual(anonymous);
  });

  it('does not let write access read the repository with the token', () => {
    expect(decideGitHubEgress('POST', github('/Stackbilt-dev/aegis.git/git-upload-pack'), scope)).toEqual(anonymous);
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

describe('plain http', () => {
  it('never carries the token', () => {
    const url = new URL('http://github.com/Stackbilt-dev/aegis.git/info/refs?service=git-upload-pack');
    expect(decideGitHubEgress('GET', url, scope).action).toBe('deny');
  });

  it('is refused on read-only hosts', async () => {
    const { fetcher } = capture();
    const response = await brokerReadOnlyRequest(new Request('http://registry.npmjs.org/vitest'), fetcher);
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('assertEgressEnforced', () => {
  const live = (command: string) => ({
    success: true,
    stderr: '',
    stdout: command.includes('example.com') ? '520' : 'Blocked by the sandbox egress policy: no',
  });

  it('passes when the policy answers and the network is closed', async () => {
    await expect(assertEgressEnforced({ exec: async (command) => live(command) })).resolves.toBeUndefined();
  });

  it('fails when a refused request gets some other answer, as it would with handlers not reached', async () => {
    const exec = async (command: string) => (command.includes('github.com')
      ? { success: true, stderr: '', stdout: 'Repository not found.' }
      : live(command));
    await expect(assertEgressEnforced({ exec })).rejects.toBeInstanceOf(EgressNotEnforcedError);
  });

  it('fails when curl cannot connect, rather than treating that as refused', async () => {
    const exec = async (command: string) => (command.includes('registry')
      ? { success: false, stderr: '', stdout: 'curl: (60) SSL certificate problem' }
      : live(command));
    await expect(assertEgressEnforced({ exec })).rejects.toBeInstanceOf(EgressNotEnforcedError);
  });

  it('fails when other hosts are reachable', async () => {
    const exec = async (command: string) => (command.includes('example.com')
      ? { success: true, stderr: '', stdout: '200' }
      : live(command));
    await expect(assertEgressEnforced({ exec })).rejects.toBeInstanceOf(EgressNotEnforcedError);
  });
});

describe('assertEgressScope', () => {
  const answering = (stdout: string) => ({ exec: async () => ({ success: true, stdout, stderr: '' }) });

  it('passes when the handler reports the scope just set', async () => {
    const answer = await (await brokerGitHubRequest(new Request('https://github.com/-/sandbox-egress-scope'), 't', pushScope)).text();
    await expect(assertEgressScope(answering(answer), pushScope)).resolves.toBeUndefined();
  });

  it('fails when the handler still reports an older scope', async () => {
    const answer = await (await brokerGitHubRequest(new Request('https://github.com/-/sandbox-egress-scope'), 't', pushScope)).text();
    await expect(assertEgressScope(answering(answer), EMPTY_GITHUB_SCOPE)).rejects.toBeInstanceOf(EgressNotEnforcedError);
  });

  it('fails when something else answers', async () => {
    await expect(assertEgressScope(answering('<html>Not Found</html>'), EMPTY_GITHUB_SCOPE)).rejects.toBeInstanceOf(EgressNotEnforcedError);
  });

  it('never sends the probe to GitHub', async () => {
    const { fetcher } = capture();
    await brokerGitHubRequest(new Request('https://github.com/-/sandbox-egress-scope'), 't', EMPTY_GITHUB_SCOPE, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('what a push may change', () => {
  const push = (body: BodyInit | null, requestScope: GitHubEgressScope = pushScope, headers: Record<string, string> = {}) => {
    const { fetcher, seen } = capture();
    const request = new Request(`https://github.com${PUSH}`, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
    return { fetcher, seen, response: brokerGitHubRequest(request, 'real-token', requestScope, fetcher) };
  };
  const refused = async (attempt: ReturnType<typeof push>, reason: string) => {
    const response = await attempt.response;
    expect(response.status).toBe(403);
    expect(await response.text()).toContain(reason);
    expect(attempt.fetcher).not.toHaveBeenCalled();
  };

  it('forwards the expected update with its pack intact and the real token', async () => {
    const body = pushBody([`${OLD_SHA} ${COMMIT} ${REF}`]);
    const attempt = push(body);
    expect((await attempt.response).status).toBe(200);
    expect(await attempt.seen[0].text()).toBe(body);
    expect(attempt.seen[0].headers.get('Authorization')).toBe(`Basic ${btoa('x-access-token:real-token')}`);
    expect(attempt.seen[0].redirect).toBe('manual');
  });

  it('accepts the shallow lines a depth-1 clone sends first', async () => {
    const attempt = push(pushBody([`${OLD_SHA} ${COMMIT} ${REF}`], 'PACK', [OTHER_COMMIT]));
    expect((await attempt.response).status).toBe(200);
  });

  it('reads commands split across chunks, and streams the rest', async () => {
    const body = new TextEncoder().encode(pushBody([`${OLD_SHA} ${COMMIT} ${REF}`], 'P'.repeat(10_000)));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let start = 0; start < body.length; start += 7) controller.enqueue(body.subarray(start, start + 7));
        controller.close();
      },
    });
    const attempt = push(stream);
    expect((await attempt.response).status).toBe(200);
    expect(new Uint8Array(await attempt.seen[0].arrayBuffer())).toEqual(body);
  });

  it('forwards the flush-only probe of a large push, even with no update expected', async () => {
    const attempt = push('0000', { writeRepos: ['Stackbilt-dev/aegis'], readRepos: [] });
    expect((await attempt.response).status).toBe(200);
  });

  it('refuses a push when no update is expected', async () => {
    await refused(push(pushBody([`${OLD_SHA} ${COMMIT} ${REF}`]), { writeRepos: ['Stackbilt-dev/aegis'], readRepos: [] }), 'no push is expected');
  });

  it('refuses another branch, and a ref that only starts with the right name', async () => {
    await refused(push(pushBody([`${OLD_SHA} ${COMMIT} refs/heads/main`])), 'refs/heads/main');
    await refused(push(pushBody([`${OLD_SHA} ${COMMIT} ${REF}-2`])), 'is not allowed');
  });

  it('refuses another commit on the right branch', async () => {
    await refused(push(pushBody([`${OLD_SHA} ${OTHER_COMMIT} ${REF}`])), 'is not allowed');
  });

  it('refuses deleting the branch', async () => {
    await refused(push(pushBody([`${COMMIT} ${OLD_SHA} ${REF}`])), 'is not allowed');
  });

  it('refuses a second ref hidden behind the expected one', async () => {
    await refused(push(pushBody([`${OLD_SHA} ${COMMIT} ${REF}`, `${OLD_SHA} ${COMMIT} refs/heads/main`])), 'only one ref');
  });

  it('refuses a signed push, whose commands it does not parse', async () => {
    await refused(push(`${pkt('push-cert\0 report-status\n')}0000PACK`), 'unsupported');
  });

  it('refuses a body it cannot read', async () => {
    await refused(push('not pkt-lines at all'), 'can\'t be read');
    await refused(push(pkt(`${OLD_SHA} ${COMMIT} ${REF}\n`)), 'can\'t be read');
    await refused(push(null), 'needs a body');
    await refused(push(`${(0xffff).toString(16)}${'x'.repeat(300_000)}`), 'can\'t be read');
  });

  it('stops reading commands that never end', async () => {
    const lines = new TextEncoder().encode(pkt(`shallow ${OTHER_COMMIT}\n`).repeat(200));
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += lines.length;
        // Bound the test itself, whatever the code under test does.
        if (pulled > 1_000_000) controller.close();
        else controller.enqueue(lines);
      },
    });
    await refused(push(endless), 'can\'t be read');
    expect(pulled).toBeLessThan(300 * 1024);
  });

  it('refuses a compressed body, which could hide its commands', async () => {
    await refused(push(pushBody([`${OLD_SHA} ${COMMIT} ${REF}`]), pushScope, { 'Content-Encoding': 'gzip' }), 'compressed');
  });
});

describe('brokerGitHubRequest', () => {
  it('swaps the placeholder for the real token on an allowed push and keeps the body', async () => {
    const { fetcher, seen } = capture();
    const response = await brokerGitHubRequest(
      placeholderRequest('/Stackbilt-dev/aegis.git/git-receive-pack', { method: 'POST', body: pushBody([`${OLD_SHA} ${COMMIT} ${REF}`], 'pack') }),
      'real-token',
      pushScope,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(seen[0].headers.get('Authorization')).toBe(`Basic ${btoa('x-access-token:real-token')}`);
    expect(await seen[0].text()).toContain('pack');
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
      placeholderRequest('/Stackbilt-dev/contracts.git/git-upload-pack', { method: 'POST' }),
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
