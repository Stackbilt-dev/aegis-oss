# Contributing to AEGIS

Thanks for your interest in contributing to AEGIS.

## Getting Started

```bash
cd web
npm install
npm test        # Run the test suite
npm run typecheck  # TypeScript checks
```

## Development

- **Language**: TypeScript, strict mode, ES modules
- **Style**: 2-space indent, single quotes, semicolons
- **Naming**: PascalCase for types/interfaces, camelCase for functions/variables
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`

## Project Structure

```
web/
  src/                 # TypeScript source
    core.ts            # Extension interfaces + createAegisApp() factory
    exports.ts         # Barrel export (@stackbilt/aegis-core entry point)
    kernel/            # Cognitive kernel (dispatch, routing, memory, scheduled tasks)
    operator/          # Operator config, persona, prompt builder
    routes/            # Hono API routes
    mcp/               # MCP server implementation
    lib/               # Shared libraries (observability, audit-chain)
  tests/               # Vitest test suite
  schema.sql           # D1 database schema
scripts/               # Deploy, taskrunner, hooks
.ai/                   # ADF governance context
docs/                  # User-facing documentation
```

## Using as a Dependency

AEGIS can be consumed as `@stackbilt/aegis-core` — a package that provides the kernel, memory system, dispatch loop, and base routes. Your deployment extends it with custom routes, scheduled tasks, and integrations.

### Install

```bash
# npm (when published)
npm install @stackbilt/aegis-core

# git dependency
npm install git+https://github.com/Stackbilt-dev/aegis-oss.git#main

# local (for co-development)
npm install file:../aegis-oss/web
```

### Extend with createAegisApp()

```ts
import { createAegisApp } from '@stackbilt/aegis-core';
import type { ScheduledTaskPlugin, RoutePlugin } from '@stackbilt/aegis-core';
import { Hono } from 'hono';

// Your operator config
import { operatorConfig } from './operator/config.js';
import { buildEdgeEnv } from './edge-env.js';

// Your custom routes
const myRoutes = new Hono();
myRoutes.get('/api/custom', (c) => c.json({ hello: 'world' }));

// Your custom scheduled task
const myTask: ScheduledTaskPlugin = {
  name: 'my-heartbeat',
  phase: 'heartbeat',
  run: async (env) => {
    console.log('Custom task running');
  },
};

// Compose
const aegis = createAegisApp({
  operator: operatorConfig,
  routes: [{ prefix: '/', router: myRoutes }],
  scheduledTasks: [myTask],
});

export default {
  fetch: aegis.app.fetch,
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(aegis.runScheduled(buildEdgeEnv(env)));
  },
};
```

### What createAegisApp() Provides

Core routes mounted automatically:
- `GET /health` — system health dashboard
- `GET/POST /api/sessions` — session management
- `GET/POST /api/messages` — message handling + dispatch
- `GET/POST /api/conversations` — conversation threads
- `POST /api/feedback` — user feedback
- `GET /api/observability` — system metrics
- `GET/POST /api/cc-tasks` — Claude Code task queue
- `GET /api/pages/:id` — static pages
- `GET/POST /api/dynamic-tools` — runtime tool management

Core scheduled tasks (heartbeat + cron phases):
- Memory consolidation, pruning, and reflection
- Agenda escalation
- CI/CD monitoring
- Feed watching
- Cost reporting
- And more — see `kernel/scheduled/index.ts`

### Extension Points

| Interface | Purpose | Example |
|-----------|---------|---------|
| `ScheduledTaskPlugin` | Custom scheduled tasks | ARGUS analytics, social engagement |
| `ExecutorPlugin` | Custom LLM executors | Cerebras, custom fine-tuned models |
| `RoutePlugin` | Additional API routes | Telegram webhooks, video briefs |
| `McpToolPlugin` | Additional MCP tools | Domain-specific tools |

### Subpath Imports

For granular imports, use subpath exports:

```ts
// Barrel (most common)
import { dispatch, recordMemory, KernelIntent } from '@stackbilt/aegis-core';

// Specific subsystems
import { route } from '@stackbilt/aegis-core/kernel/router';
import { recordEpisode } from '@stackbilt/aegis-core/kernel/memory';
import { executeClaude } from '@stackbilt/aegis-core/kernel/executors';
import { operatorConfig } from '@stackbilt/aegis-core/operator';
import { bearerAuth } from '@stackbilt/aegis-core/auth';
import { buildEdgeEnv } from '@stackbilt/aegis-core/edge-env';
import { VERSION } from '@stackbilt/aegis-core/version';
```

### Env and EdgeEnv

The core package exports `Env` (Cloudflare Worker bindings) and `EdgeEnv` (runtime environment). Your deployment likely has additional bindings:

```ts
import type { Env as CoreEnv } from '@stackbilt/aegis-core';

// Extend with your service bindings
interface Env extends CoreEnv {
  MY_SERVICE: Fetcher;
  MY_SECRET: string;
}
```

## What NOT to commit

- `web/wrangler.toml` — contains account-specific IDs (use `wrangler.toml.example`)
- `web/src/operator/config.ts` / `persona.ts` — user customizations (use `.example` files)
- `.dev.vars`, `.env` — secrets
- Account IDs, API tokens, or internal URLs

## Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Write tests for new functionality
3. Ensure `npm test` and `npm run typecheck` pass
4. Use a descriptive PR title following conventional commit format
5. Keep PRs focused — one feature or fix per PR

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (OS, Node version, Wrangler version)

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
