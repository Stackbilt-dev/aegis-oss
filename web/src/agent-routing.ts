import { routeAgentRequest } from 'agents';
import type { Env } from './types.js';

export async function routeAegisAgentRequest(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith('/agents/')) {
    return undefined;
  }

  const token = extractBearer(request.headers.get('Authorization'))
    ?? getCookie(request.headers.get('Cookie') ?? '', 'aegis_token')
    ?? new URL(request.url).searchParams.get('token');

  if (!token || token !== env.AEGIS_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const response = await routeAgentRequest(request, env);
    return response ?? new Response('Agent route not found', { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Agent route failed: ${message}`, { status: 503 });
  }
}

function extractBearer(header: string | null): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function getCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ?? null;
}
