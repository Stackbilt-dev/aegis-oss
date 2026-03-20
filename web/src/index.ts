import { Hono } from 'hono';
import { bearerAuth } from './auth.js';
import { runScheduledTasks } from './kernel/scheduled/index.js';
import type { Env } from './types.js';
import { handleMcpRequest } from './mcp-server.js';
import { buildEdgeEnv } from './edge-env.js';

// Route modules
import { health } from './routes/health.js';
import { sessions } from './routes/sessions.js';
import { feedback } from './routes/feedback.js';
import { conversations } from './routes/conversations.js';
import { ccTasks } from './routes/cc-tasks.js';
import { messages } from './routes/messages.js';

const app = new Hono<{ Bindings: Env }>();

// ─── Auth ────────────────────────────────────────────────────
app.use('*', bearerAuth);

// ─── Route modules ───────────────────────────────────────────
app.route('/', health);
app.route('/', sessions);
app.route('/', feedback);
app.route('/', conversations);
app.route('/', ccTasks);
app.route('/', messages);

// ─── MCP endpoint (direct bearer auth, no OAuth) ────────────
app.all('/mcp', async (c) => {
  const edgeEnv = buildEdgeEnv(c.env, c.executionCtx);
  return handleMcpRequest(c.req.raw, edgeEnv);
});

export default {
  fetch: app.fetch.bind(app),
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledTasks(buildEdgeEnv(env)));
  },
};
