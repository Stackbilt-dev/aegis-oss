import type { Context, Next } from 'hono';
import type { Env } from './types.js';

export async function bearerAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  // Public routes — no auth required
  if (c.req.path === '/health' || c.req.path === '/pulse' || (c.req.path === '/' && c.req.method === 'GET') || c.req.path.startsWith('/tech') || c.req.path === '/api/feedback') {
    return next();
  }

  // Webhook routes — auth handled by per-route HMAC verification
  if (c.req.path.startsWith('/webhooks/') || c.req.path === '/api/webhook') {
    return next();
  }

  // OAuth discovery endpoints — must be public so MCP clients can probe them
  // without a token. We return 404 for the auth server and resource metadata
  // so clients learn there is no OAuth server here and fall back to configured
  // bearer token headers.
  if (
    c.req.path === '/.well-known/oauth-protected-resource' ||
    c.req.path === '/.well-known/oauth-authorization-server' ||
    c.req.path === '/.well-known/openid-configuration'
  ) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const cookieToken = getCookie(c.req.header('Cookie') ?? '', 'aegis_token');
  const queryToken = c.req.query('token');

  const token = extractBearer(authHeader) ?? cookieToken ?? queryToken;

  if (!token || token !== c.env.AEGIS_TOKEN) {
    // Chat UI — show login page
    if (c.req.path === '/chat' && c.req.method === 'GET') {
      return c.html(loginPage(), 401);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
}

function extractBearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function getCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ?? null;
}

function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AEGIS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .login {
      background: #141420;
      border: 1px solid #2a2a3a;
      border-radius: 12px;
      padding: 2rem;
      width: 90%;
      max-width: 360px;
    }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; color: #8b8bff; }
    input {
      width: 100%;
      padding: 0.75rem;
      background: #0a0a0f;
      border: 1px solid #2a2a3a;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      margin-bottom: 1rem;
    }
    input:focus { outline: none; border-color: #8b8bff; }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #8b8bff;
      color: #0a0a0f;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #7a7aee; }
  </style>
</head>
<body>
  <div class="login">
    <h1>AEGIS</h1>
    <form id="f">
      <input type="password" id="t" placeholder="Access token" autocomplete="off" autofocus>
      <button type="submit">Enter</button>
    </form>
  </div>
  <script>
    document.getElementById('f').onsubmit = (e) => {
      e.preventDefault();
      const token = document.getElementById('t').value;
      document.cookie = 'aegis_token=' + encodeURIComponent(token) + ';path=/;max-age=31536000;SameSite=Strict;Secure';
      window.location.href = '/chat';
    };
  </script>
</body>
</html>`;
}
