<p align="center">
  <img src="docs/hero-banner.png" alt="AEGIS — Cognitive Kernel" width="100%">
</p>

# AEGIS

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](web/tests/)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Discord](https://img.shields.io/discord/1485683351393407006?color=7289da&label=Discord&logo=discord&logoColor=white&style=flat-square)](https://discord.gg/aJmE8wmQDS)

**A persistent AI agent framework for Cloudflare Workers.**
**Published as `@stackbilt/aegis-core` — use standalone or extend as a dependency.**

Cognitive kernel with multi-tier memory, autonomous goal pursuit, a dreaming cycle, runtime tool creation, and 26 scheduled tasks. Deploy your own persistent AI co-founder on the edge.

## What is AEGIS?

AEGIS is a framework for building **personal AI agents** that remember everything, pursue goals autonomously, create their own tools, and improve themselves while you sleep. Unlike chat-based AI tools that forget between sessions, AEGIS maintains persistent identity, memory, and state across every interaction.

**Two ways to use AEGIS:**
- **Standalone** — Clone, configure, deploy. Full agent in minutes.
- **As a dependency** — `npm install @stackbilt/aegis-core` and extend with your own routes, scheduled tasks, executors, and MCP tools via `createAegisApp()`.

The production instance runs 26 scheduled tasks, has executed 236+ autonomous coding sessions, and costs $0/month to host (Cloudflare Workers free tier + Workers AI for inference).

Built on Cloudflare Workers for edge-native deployment. Zero cold starts. Global distribution. Pay-per-request economics.

### Core Capabilities

- **Cognitive Kernel** — Multi-model dispatch (Claude, Groq, Workers AI) with procedural memory routing. The right model for the right task, automatically.
- **Multi-Tier Memory** — Episodic (what happened), semantic (what matters), procedural (what works), narrative (the story arc). Memory consolidates, decays, and strengthens over time.
- **Autonomous Goals** — Set goals with standing orders and let AEGIS pursue them on a schedule. Progress tracked, blockers surfaced, results reported.
- **Dreaming Cycle** — Nightly self-reflection over conversation history. Discovers patterns, proposes improvements, proposes new tools, consolidates knowledge. PRISM synthesis finds cross-domain connections.
- **Runtime Dynamic Tools** — Create reusable prompt-template tools at runtime during conversations or autonomously via self-improvement. Tools are stored in D1, executed via LLM, with lifecycle management (TTL, GC, auto-promotion at 20 uses).
- **Entropy Detection** — Monitors for ghost tasks (>7d stale), dormant goals (>14d), and stale agenda items. Calculates system entropy score and surfaces findings in the daily digest.
- **Social Engagement** — Autonomous Bluesky interaction: likes replies, follows back real accounts, generates on-brand replies via Workers AI. Spam filtering and rate limiting built in.
- **Content Pipeline** — Scheduled content generation and social media drip posting via AT Protocol. Queue posts, schedule delivery, track engagement.
- **Declarative Governance** — ADF (Agent Definition Format) files control behavior, constraints, and architectural rules. Version-controlled agent configuration.
- **Operator Identity** — Fully configurable persona, traits, and integration preferences. Your agent, your personality.
- **MCP Native** — Full Model Context Protocol server (20+ tools) and client. Connect any MCP-compatible tool.

## Quick Start

```bash
git clone https://github.com/Stackbilt-dev/aegis-oss.git
cd aegis-oss/web
npm install

# Configure
cp wrangler.toml.example wrangler.toml          # Fill in account_id, database_id
cp src/operator/config.example.ts src/operator/config.ts  # Customize identity

# Set up D1 database
npx wrangler d1 create my-agent
npx wrangler d1 execute my-agent --file=schema.sql

# Set secrets
npx wrangler secret put AEGIS_TOKEN            # Random bearer token for auth
npx wrangler secret put ANTHROPIC_API_KEY      # Claude API key
npx wrangler secret put GROQ_API_KEY           # Groq key (free tier available)

# Deploy
npx wrangler deploy
```

Visit `https://your-worker.workers.dev` and authenticate with your AEGIS_TOKEN.

## Use as a Dependency

Install `@stackbilt/aegis-core` and compose your own agent:

```bash
npm install @stackbilt/aegis-core
```

```ts
import { createAegisApp } from '@stackbilt/aegis-core';

const aegis = createAegisApp({
  operator: myConfig,
  routes: [{ prefix: '/', router: myRoutes }],
  scheduledTasks: [myCustomTask],
});

export default {
  fetch: aegis.app.fetch,
  scheduled: (e, env, ctx) => ctx.waitUntil(aegis.runScheduled(buildEdgeEnv(env))),
};
```

Core provides: kernel, memory, dispatch, base routes, MCP server, scheduled task framework.
You provide: operator config, custom routes, integrations, secrets.

Extension interfaces: `ScheduledTaskPlugin`, `ExecutorPlugin`, `RoutePlugin`, `McpToolPlugin`.

See [CONTRIBUTING.md](CONTRIBUTING.md#using-as-a-dependency) for full documentation.

## Architecture

```
    ┌────────────────────────────────────────────────────────────┐
    │                   COGNITIVE KERNEL                          │
    │                                                            │
    │  Classify → Route (procedural memory) → Execute            │
    │  (intent)   (learned patterns)          (Claude/Groq/WAI)  │
    │                                                            │
    │  ┌──────────────────────────────────────────────────────┐  │
    │  │              MEMORY TIERS                             │  │
    │  │  Episodic → Semantic → Procedural → Narrative        │  │
    │  │  (events)   (facts)    (skills)     (story arcs)     │  │
    │  └──────────────────────────────────────────────────────┘  │
    │                                                            │
    │  ┌─────────────────┐  ┌──────────────────────────────┐    │
    │  │ DYNAMIC TOOLS   │  │  SCHEDULED TASKS (26 hourly) │    │
    │  │ Runtime-created  │  │  Dreaming | Goals | Entropy  │    │
    │  │ prompt templates │  │  Social | Content | Memory   │    │
    │  └─────────────────┘  └──────────────────────────────┘    │
    └────────────────────────────────────────────────────────────┘
```

## Runtime Dynamic Tools

AEGIS can create its own tools during conversations or autonomously:

```
POST /api/dynamic-tools
{
  "name": "summarize_pr",
  "description": "Summarize a GitHub PR into 3 bullet points",
  "prompt_template": "Summarize this PR diff into 3 concise bullets:\n\n{{diff}}",
  "executor": "workers_ai"
}
```

- Tools are parameterized prompt templates stored in D1
- Executed via Workers AI ($0), Groq, or GPT-OSS — no `eval()`, no code execution
- Self-improvement detects recurring patterns and proposes tools automatically
- Dreaming cycle proposes tools from conversation analysis
- Hourly GC expires unused tools, auto-promotes at 20 invocations
- 50-tool ceiling prevents context bloat
- Available as MCP tools and in the Claude chat loop (`dt_*` prefix)

## Memory System

| Tier | Purpose | Lifecycle |
|------|---------|-----------|
| **Episodic** | Raw interaction logs (intent, outcome, cost) | Created per dispatch, pruned after 30 days |
| **Semantic** | Durable facts with topic taxonomy | Promoted from episodic during consolidation |
| **Procedural** | Learned patterns (which executor works for which intent) | Updated on every dispatch outcome |
| **Narrative** | Story arcs and cognitive state | Generated during dreaming cycle |

Memory consolidation runs hourly. The dreaming cycle runs daily — extracts facts, proposes tasks and tools, discovers cross-domain patterns via PRISM synthesis.

## Scheduled Tasks

AEGIS runs 26 tasks on an hourly cron, split into heartbeat (always-run) and time-gated phases:

| Task | Cadence | Purpose |
|------|---------|---------|
| Escalation | Hourly | Bump stale agenda priorities |
| CI Watcher | Hourly | Monitor GitHub Actions runs |
| ARGUS Notify | Hourly | Classify webhook events, route alerts |
| Cognitive Metrics | Daily | Classifier accuracy, dispatch cost tracking |
| PR Automerge | Hourly | Auto-merge approved docs/tests PRs |
| Consolidation | Hourly | Memory dedup, decay, promotion, dynamic tool GC |
| Heartbeat | 6h | System health + email digest |
| Product Health | Hourly | Worker availability checks |
| Entropy | 6h | Ghost tasks, stale agenda, dormant goals |
| Social Engage | 6h | Bluesky: like replies, follow back, reply |
| Content Drip | Hourly | Publish scheduled social posts |
| Issue Watcher | 2h | Scan GitHub issues, auto-queue tasks |
| Feed Watcher | 6h | Poll RSS/Atom feeds |
| Self-Improvement | 6h | Multi-repo codebase scan, tool proposals |
| Goals | Non-SI hours | Autonomous goal execution with standing orders |
| Curiosity | Daily | Memory gaps → research dispatch |
| Dreaming | Daily | Thread review → facts/tasks/tools + PRISM synthesis |
| Daily Digest | 09 UTC | Co-Founder Brief email |

## API Surface

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | System health dashboard |
| GET | `/api/entropy` | Entropy score + ghost items |
| GET/POST | `/api/dynamic-tools` | CRUD for runtime tools |
| POST | `/api/dynamic-tools/:id/invoke` | Execute a dynamic tool |
| POST | `/api/bluesky/post` | Post to Bluesky |
| GET | `/api/bluesky/feed` | Get author feed |
| POST | `/api/bluesky/like` | Like a post |
| POST | `/api/bluesky/repost` | Repost |
| GET | `/api/bluesky/notifications` | Check notifications |
| GET | `/api/content-queue` | View scheduled posts |
| GET | `/llms.txt` | LLM-friendly site description |

### MCP Tools (20+)

`aegis_chat`, `aegis_memory`, `aegis_record_memory`, `aegis_agenda`, `aegis_add_agenda`, `aegis_resolve_agenda`, `aegis_add_goal`, `aegis_update_goal`, `aegis_list_goals`, `aegis_create_cc_task`, `aegis_list_cc_tasks`, `aegis_approve_cc_task`, `aegis_create_dynamic_tool`, `aegis_invoke_dynamic_tool`, `aegis_list_dynamic_tools`, `aegis_publish_tech_post`, `aegis_inbox_send`, `aegis_inbox_read`, `aegis_generate_decision_doc`, and more.

## Optional Integrations

| Integration | Secret | Purpose |
|-------------|--------|---------|
| GitHub | `GITHUB_TOKEN` | Repository scanning, issue management, self-improvement |
| Brave Search | `BRAVE_API_KEY` | Web research capability |
| Bluesky | `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD` | Social posting and engagement |
| Resend | `RESEND_API_KEY` | Email notifications and daily digest |
| Memory Worker | Service Binding | Persistent semantic memory with vector search |
| TarotScript | Service Binding | Deterministic symbolic reasoning |

## Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolates, global edge)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **AI Models**: Claude (Anthropic), Groq (Llama 3.3), Workers AI (free inference)
- **Framework**: Hono (lightweight, edge-native HTTP)
- **Language**: TypeScript (strict mode)
- **Protocol**: MCP (Model Context Protocol)
- **Cost**: $0/month hosting (Workers free tier)

## Live Example

The production AEGIS instance is live at **[aegis.stackbilt.dev/health](https://aegis.stackbilt.dev/health)** — hit the health endpoint to see real-time kernel status, procedure counts, and memory metrics.

## Ecosystem

AEGIS pairs with other Stackbilt open-source tools:

- **[cc-taskrunner](https://github.com/Stackbilt-dev/cc-taskrunner)** — Autonomous task queue for Claude Code. Safety hooks, branch isolation, PR creation.
- **[Charter](https://github.com/Stackbilt-dev/charter)** — AI agent governance CLI. Modular .ai/ files replace monolithic CLAUDE.md configs.
- **[MindSpring](https://github.com/Stackbilt-dev/mindspring)** — Semantic search over ChatGPT/Claude conversation exports.
- **[Social Sentinel](https://github.com/Stackbilt-dev/social-sentinel)** — Privacy-first social media sentiment monitoring.

## Documentation

- [Getting Started](docs/getting-started.md) — Deploy your own instance in 5 minutes
- [Architecture](docs/architecture.md) — System design, dispatch flow, memory tiers
- [Configuration](docs/configuration.md) — Full operator config reference
- [Memory System](docs/memory-system.md) — Memory tiers, consolidation, and dreaming cycle
- [Connecting MCP Clients](docs/connecting-mcp-clients.md) — OpenClaw, Claude Desktop, Claude Code, Cursor, and any MCP client

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Credits

Built by [Stackbilt](https://stackbilt.dev). AEGIS is the cognitive kernel powering the Stackbilt platform.
