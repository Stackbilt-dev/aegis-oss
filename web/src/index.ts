/**
 * Default standalone Worker entry point.
 *
 * This file deploys aegis-oss as a self-contained Worker. Consumers who
 * use @stackbilt/aegis-core as a dependency should use createAegisApp()
 * from ./core.ts instead — this file is for standalone deployments only.
 */

import { Hono } from 'hono';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { bearerAuth } from './auth.js';
import { runScheduledTasks } from './kernel/scheduled/index.js';
import type { Env } from './types.js';
import { handleMcpRequest } from './mcp-server.js';
import { buildEdgeEnv } from './edge-env.js';

// Core route modules
import { health } from './routes/health.js';
import { sessions } from './routes/sessions.js';
import { operatorLogs } from './routes/operator-logs.js';
import { feedback } from './routes/feedback.js';
import { conversations } from './routes/conversations.js';
import { observability } from './routes/observability.js';
import { pages } from './routes/pages.js';
import { ccTasks } from './routes/cc-tasks.js';
import { messages } from './routes/messages.js';
import { content } from './routes/content.js';
import { codebeast } from './routes/codebeast.js';
import { bluesky } from './routes/bluesky.js';
import { dynamicToolsRoutes } from './routes/dynamic-tools.js';

const app = new Hono<{ Bindings: Env }>();

// ─── Auth ────────────────────────────────────────────────────
app.use('*', bearerAuth);

// ─── Core Route modules ─────────────────────────────────────
app.route('/', health);
app.route('/', sessions);
app.route('/', operatorLogs);
app.route('/', feedback);
app.route('/', conversations);
app.route('/', observability);
app.route('/', pages);
app.route('/', ccTasks);
app.route('/', messages);
app.route('/', content);
app.route('/', codebeast);
app.route('/', bluesky);
app.route('/', dynamicToolsRoutes);

// ─── OAuth 2.1 Provider (wraps /mcp with token auth) ────────

function createDefaultOAuthHandler(appFetch: typeof app.fetch) {
  return {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
      return appFetch(request, env, ctx);
    },
  };
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      handleMcpRequest(request, buildEdgeEnv(env, ctx)),
  },
  defaultHandler: createDefaultOAuthHandler(app.fetch.bind(app)),
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['mcp'],
  accessTokenTTL: 86400,
  refreshTokenTTL: 2592000,
  resolveExternalToken: async ({ token, env: rawEnv }) => {
    const env = rawEnv as Env;
    if (token === env.AEGIS_TOKEN) {
      return { props: { userId: 'operator', source: 'static_bearer' } };
    }
    return null;
  },
});

export default {
  fetch: oauthProvider.fetch.bind(oauthProvider),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledTasks(buildEdgeEnv(env)));
  },
};
