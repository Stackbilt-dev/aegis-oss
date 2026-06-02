import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('agents', () => ({
  routeAgentRequest: vi.fn(),
}));

const { routeAgentRequest } = await import('agents');
const { routeAegisAgentRequest } = await import('../src/agent-routing.js');

describe('routeAegisAgentRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores non-agent paths', async () => {
    const res = await routeAegisAgentRequest(new Request('http://local/api/message'), {} as any);

    expect(res).toBeUndefined();
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it('forwards /agents requests to the Agents SDK router', async () => {
    const forwarded = new Response('voice', { status: 209 });
    vi.mocked(routeAgentRequest).mockResolvedValueOnce(forwarded);

    const req = new Request('http://local/agents/aegis-voice-adapter/operator?token=test-token');
    const env = { AEGIS_TOKEN: 'test-token', AegisVoiceAdapter: {} };
    const res = await routeAegisAgentRequest(req, env as any);

    expect(res).toBe(forwarded);
    expect(routeAgentRequest).toHaveBeenCalledWith(req, env);
  });

  it('accepts bearer auth for /agents requests', async () => {
    const forwarded = new Response('voice', { status: 209 });
    vi.mocked(routeAgentRequest).mockResolvedValueOnce(forwarded);

    const req = new Request('http://local/agents/aegis-voice-adapter/operator', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const env = { AEGIS_TOKEN: 'test-token', AegisVoiceAdapter: {} };
    const res = await routeAegisAgentRequest(req, env as any);

    expect(res).toBe(forwarded);
  });

  it('rejects /agents requests without a valid token', async () => {
    const res = await routeAegisAgentRequest(
      new Request('http://local/agents/aegis-voice-adapter/operator?token=wrong'),
      { AEGIS_TOKEN: 'test-token' } as any,
    );

    expect(res?.status).toBe(401);
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it('returns 404 when the Agents SDK router does not match', async () => {
    vi.mocked(routeAgentRequest).mockResolvedValueOnce(undefined);

    const res = await routeAegisAgentRequest(
      new Request('http://local/agents/missing/default?token=test-token'),
      { AEGIS_TOKEN: 'test-token' } as any,
    );

    expect(res?.status).toBe(404);
    await expect(res?.text()).resolves.toContain('Agent route not found');
  });

  it('fails closed when the Agents SDK router throws', async () => {
    vi.mocked(routeAgentRequest).mockRejectedValueOnce(new Error('no binding'));

    const res = await routeAegisAgentRequest(
      new Request('http://local/agents/aegis-voice-adapter/operator?token=test-token'),
      { AEGIS_TOKEN: 'test-token' } as any,
    );

    expect(res?.status).toBe(503);
    await expect(res?.text()).resolves.toContain('no binding');
  });
});
