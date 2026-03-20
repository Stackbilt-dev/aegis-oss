// Auth middleware tests — public routes, token extraction, cookie/query auth

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bearerAuth } from '../src/auth.js';
import type { Context, Next } from 'hono';
import type { Env } from '../src/types.js';

function makeContext(overrides: {
  path: string;
  method?: string;
  authHeader?: string;
  cookie?: string;
  queryToken?: string;
}): Context<{ Bindings: Env }> {
  const { path, method = 'GET', authHeader, cookie, queryToken } = overrides;
  return {
    req: {
      path,
      method,
      header: (name: string) => {
        if (name === 'Authorization') return authHeader;
        if (name === 'Cookie') return cookie ?? '';
        return undefined;
      },
      query: (name: string) => {
        if (name === 'token') return queryToken;
        return undefined;
      },
    },
    env: { AEGIS_TOKEN: 'valid_token_123' } as Env,
    json: vi.fn().mockImplementation((body: unknown, status: number) => new Response(JSON.stringify(body), { status })),
    html: vi.fn().mockImplementation((body: string, status: number) => new Response(body, { status })),
  } as unknown as Context<{ Bindings: Env }>;
}

describe('bearerAuth', () => {
  let next: Next;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined);
  });

  describe('public routes', () => {
    const publicPaths = ['/health', '/pulse', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];

    for (const path of publicPaths) {
      it(`passes through ${path} without auth`, async () => {
        const c = makeContext({ path });
        await bearerAuth(c, next);
        expect(next).toHaveBeenCalled();
      });
    }

    it('passes through GET / without auth', async () => {
      const c = makeContext({ path: '/', method: 'GET' });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('passes through /tech/* without auth', async () => {
      const c = makeContext({ path: '/tech/some-post' });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('passes through /webhooks/* without auth', async () => {
      const c = makeContext({ path: '/webhooks/github' });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('token validation', () => {
    it('accepts valid Bearer token in Authorization header', async () => {
      const c = makeContext({ path: '/api/chat', authHeader: 'Bearer valid_token_123' });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('accepts valid token from cookie', async () => {
      const c = makeContext({ path: '/api/chat', cookie: 'aegis_token=valid_token_123' });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('accepts valid token from query param', async () => {
      const c = makeContext({ path: '/api/chat', queryToken: 'valid_token_123' });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });

    it('rejects missing token with 401', async () => {
      const c = makeContext({ path: '/api/chat' });
      await bearerAuth(c, next);
      expect(next).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
    });

    it('rejects invalid token with 401', async () => {
      const c = makeContext({ path: '/api/chat', authHeader: 'Bearer wrong_token' });
      await bearerAuth(c, next);
      expect(next).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith({ error: 'Unauthorized' }, 401);
    });

    it('rejects malformed Authorization header', async () => {
      const c = makeContext({ path: '/api/chat', authHeader: 'Basic abc123' });
      await bearerAuth(c, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('shows login page for GET /chat without token', async () => {
      const c = makeContext({ path: '/chat', method: 'GET' });
      await bearerAuth(c, next);
      expect(next).not.toHaveBeenCalled();
      expect(c.html).toHaveBeenCalledWith(expect.stringContaining('AEGIS'), 401);
    });

    it('prioritizes Authorization header over cookie', async () => {
      const c = makeContext({
        path: '/api/chat',
        authHeader: 'Bearer valid_token_123',
        cookie: 'aegis_token=wrong_token',
      });
      await bearerAuth(c, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
