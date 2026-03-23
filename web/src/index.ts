import { Hono } from 'hono';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { bearerAuth } from './auth.js';
import { runScheduledTasks } from './kernel/scheduled/index.js';
import type { Env } from './types.js';
import { handleMcpRequest } from './mcp-server.js';
import { createOAuthDefaultHandler } from './oauth-handler.js';
import { buildEdgeEnv } from './edge-env.js';
import { handleVoiceWebhook } from './voice-webhook.js';
import { handleWebhook } from './webhook.js';

// Route modules
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
import { welcome } from './routes/welcome.js';
import { alerts } from './routes/alerts.js';
import { overworld } from './routes/overworld.js';
import { contentQueue } from './routes/content-queue.js';

const app = new Hono<{ Bindings: Env }>();

// ─── Auth ────────────────────────────────────────────────────
app.use('*', bearerAuth);

// ─── Route modules ───────────────────────────────────────────
app.route('/', health);
app.route('/', sessions);
app.route('/', operatorLogs);
app.route('/', feedback);
app.route('/', conversations);
app.route('/', observability);
app.route('/', overworld);
app.route('/', pages);
app.route('/', ccTasks);
app.route('/', messages);
app.route('/', content);
app.route('/', welcome);
app.route('/', alerts);
app.route('/', contentQueue);

// ─── ARGUS: Unified Webhook Ingestion ────────────────────────
app.post('/api/webhook', handleWebhook);

// ─── Voice Funnel Webhook (#99) ──────────────────────────────
// Legacy route — ElevenLabs is configured to hit this URL.
// TODO: Migrate ElevenLabs webhook config to /api/webhook, then remove this route.
app.post('/webhooks/voice/complete', handleVoiceWebhook);

// ─── OAuth 2.1 Provider (wraps /mcp with token auth) ────────
const oauthProvider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      handleMcpRequest(request, buildEdgeEnv(env, ctx)),
  },
  defaultHandler: createOAuthDefaultHandler(app.fetch.bind(app)),
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
