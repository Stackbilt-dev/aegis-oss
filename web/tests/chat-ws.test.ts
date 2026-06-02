import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { chatWs } from '../src/routes/chat-ws.js';
import type { Env } from '../src/types.js';

function makeApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', chatWs);
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env as Env),
  };
}

describe('chatWs route', () => {
  it('rejects non-websocket requests', async () => {
    const app = makeApp({});
    const res = await app.request('/chat/ws');

    expect(res.status).toBe(426);
    await expect(res.text()).resolves.toContain('Expected WebSocket upgrade');
  });

  it('fails closed when CHAT_SESSION is missing', async () => {
    const app = makeApp({});
    const res = await app.request('/chat/ws', {
      headers: { Upgrade: 'websocket' },
    });

    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toContain('CHAT_SESSION');
  });

  it('forwards websocket upgrades to the operator ChatSession object', async () => {
    const forwarded = new Response('forwarded', { status: 209 });
    const stub = { fetch: vi.fn().mockResolvedValue(forwarded) };
    const namespace = {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => stub),
    };
    const app = makeApp({ CHAT_SESSION: namespace as unknown as DurableObjectNamespace });

    const res = await app.request('/chat/ws?token=test-token', {
      headers: { Upgrade: 'websocket' },
    });

    expect(res.status).toBe(209);
    expect(namespace.idFromName).toHaveBeenCalledWith('operator');
    expect(namespace.get).toHaveBeenCalledWith({ name: 'operator' });
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});
