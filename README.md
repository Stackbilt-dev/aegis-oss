<p align="center">
  <img src="docs/hero-banner.png" alt="AEGIS — Cognitive Kernel" width="100%">
</p>

# AEGIS

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](web/tests/)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Discord](https://img.shields.io/discord/1485683351393407006?color=7289da&label=Discord&logo=discord&logoColor=white&style=flat-square)](https://discord.gg/aJmE8wmQDS)

**A persistent AI agent on Cloudflare Workers, and agent work you can check without trusting the agent.**
Published as `@stackbilt/aegis-core`: deploy it standalone, or extend it as a dependency.

Coding agents report success they didn't achieve. One of ours said it had added two tests and that the suite passed with 15. The suite had 15 tests before it started. ([The full story](https://blog.stackbilder.com/post/verified-agent-pull-requests-acceptance-gate).) AEGIS is built so that nothing the agent *says* about its work counts as evidence.

## Verified work

**The sandbox task executor** runs a coding task in a disposable [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container. It opens a pull request only if the task's **acceptance contract** passes, and it checks the contract against facts it gathers itself:

- **Scope:** the staged diff. Only the files the contract allows, within its line limits.
- **Content:** required and forbidden strings in the changed files.
- **Tests:** a fresh vitest run the executor starts after the agent stops, with the pass count read from vitest's JSON report at a path the agent never saw.

```acceptance
{
  "changed_files_only": ["src/slugify.ts", "tests/slugify.test.ts"],
  "max_added_lines": 15,
  "tests": [{ "command": "npx vitest run tests/slugify.test.ts", "passed": 4 }]
}
```

A failing change opens nothing. A passing one opens a PR with the check report attached. **Fork mode** does this for repositories you don't own: it forks the repository and opens the PR on the upstream, as any outside contributor would.

**The maintainer doesn't have to trust us either.** The same contract format runs as a GitHub Action, [agent-acceptance](https://github.com/Stackbilt-dev/agent-acceptance), which checks any agent's PR against the contract in the issue it closes.

Live example: [fork-canary#7](https://github.com/stackbilt-admin/fork-canary/pull/7).
- The repository owner wrote the contract in issue #6.
- The executor ran the task and passed the contract 6/6 before publishing.
- The PR, opened from a fork in another organization, says `Fixes #6`.
- The Action re-ran the tests from the issue's contract and passed it 6/6 on its own.

The two checks agree, and neither relies on the other.

What it doesn't do: judge whether the tests are *good* tests. It proves scope, content and test counts, so a reviewer starts from verified facts instead of the agent's summary. Setup and limits: [docs/sandbox-executor.md](docs/sandbox-executor.md).

## The agent runtime

Underneath is a persistent agent that keeps identity, memory and state across every interaction. It runs on Workers AI by default, with Claude and Groq as optional executors, and the base deployment fits the Workers free tier. The sandbox executor is opt-in and needs Workers Paid (Containers).

- **Cognitive Kernel:** Workers AI-first dispatch with optional Claude and Groq executors, plus procedural memory routing.
- **Multi-Tier Memory:** episodic (what happened), semantic (what matters), procedural (what works) and narrative. Memory consolidates, decays and strengthens over time.
- **Autonomous Goals:** goals with standing orders, pursued on a schedule, with progress and blockers reported.
- **Dreaming Cycle:** nightly reflection over conversation history that proposes improvements and tools and consolidates knowledge.
- **Runtime Dynamic Tools:** prompt-template tools created at runtime, stored in D1, with TTL, garbage collection and auto-promotion.
- **Entropy Detection:** flags stale tasks, dormant goals and stale agenda items in the daily digest.
- **Content and Social:** scheduled content generation, plus Bluesky posting and engagement with rate limits.
- **Declarative Governance:** ADF files hold behavior, constraints and architectural rules as version-controlled configuration.
- **MCP Native:** a Model Context Protocol server (20+ tools) and client.

## Quick Start

You need Node 22+, a Cloudflare account (the free tier works) and `npx wrangler login`. Then:

```bash
git clone https://github.com/Stackbilt-dev/aegis-oss.git
cd aegis-oss/web
corepack enable        # once per machine; provides pnpm
pnpm install
pnpm run setup         # "run" matters: `pnpm setup` is a different, built-in command
```

`setup` does the following:
- asks for a name;
- creates the D1 database (or reuses one with that name) and writes `wrangler.toml`;
- applies the schema;
- deploys;
- sets a generated `AEGIS_TOKEN`;
- checks `/health` and confirms the token signs in, then prints your URL and token.

`pnpm run setup --dry-run` prints every command without changing anything. The manual steps are in [docs/getting-started.md](docs/getting-started.md).

Visit your Worker URL and sign in with the `AEGIS_TOKEN` setup printed. The embedded console uses Workers AI for the base chat and voice path; Claude and Groq keys are optional executor upgrades.

Talk to the same deployment from a terminal:

```bash
AEGIS_HOST=your-worker.workers.dev AEGIS_TOKEN=your-token npx @stackbilt/aegis-core --quick
```

Release proof: [AEGIS 0.8.0 Proof of Work](docs/proof-of-work-0.8.0.md). Demo path: [AEGIS 0.8.0 Demo Script](docs/demo-script-0.8.0.md).

## Use as a Dependency

Install `@stackbilt/aegis-core` and compose your own agent:

```bash
pnpm add @stackbilt/aegis-core
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
    │  (intent)   (learned patterns)          (WAI + optional)   │
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
| Sandbox task executor | `GITHUB_TOKEN` + Containers (Workers Paid) | Acceptance-gated pull requests from sandboxed coding tasks ([guide](docs/sandbox-executor.md)) |

## Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolates, global edge)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **Base Inference**: Cloudflare Workers AI
- **Optional Executors**: Claude (Anthropic), Groq (Llama 3.3)
- **Framework**: Hono (lightweight, edge-native HTTP)
- **Language**: TypeScript (strict mode)
- **Protocol**: MCP (Model Context Protocol)
- **Cost**: $0/month hosting (Workers free tier)

## Live Example

The production AEGIS instance is live at **[aegis.stackbilt.dev/health](https://aegis.stackbilt.dev/health)** — hit the health endpoint to see real-time kernel status, procedure counts, and memory metrics.

## Ecosystem

AEGIS pairs with other Stackbilt open-source tools:

- **[cc-taskrunner](https://github.com/Stackbilt-dev/cc-taskrunner)** — Autonomous task queue for Claude Code. Safety hooks, branch isolation, PR creation.
- **[agent-acceptance](https://github.com/Stackbilt-dev/agent-acceptance)** — The same acceptance contract as a GitHub Action: check any agent's PR against the issue it closes.
- **[Charter](https://github.com/Stackbilt-dev/charter)** — AI agent governance CLI. Modular .ai/ files replace monolithic CLAUDE.md configs.
- **[MindSpring](https://github.com/Stackbilt-dev/mindspring)** — Semantic search over ChatGPT/Claude conversation exports.
- **[Social Sentinel](https://github.com/Stackbilt-dev/social-sentinel)** — Privacy-first social media sentiment monitoring.

## Documentation

- [Getting Started](docs/getting-started.md) — Deploy your own instance in 5 minutes
- [Architecture](docs/architecture.md) — System design, dispatch flow, memory tiers
- [Configuration](docs/configuration.md) — Full operator config reference
- [Memory System](docs/memory-system.md) — Memory tiers, consolidation, and dreaming cycle
- [Connecting MCP Clients](docs/connecting-mcp-clients.md) — OpenClaw, Claude Desktop, Claude Code, Cursor, and any MCP client
- [AEGIS 0.8.0 Demo Script](docs/demo-script-0.8.0.md) — Browser console plus CLI proof path
- [AEGIS 0.8.0 Proof of Work](docs/proof-of-work-0.8.0.md) — Release evidence and validation notes
- [Sandbox Task Executor](docs/sandbox-executor.md) — Acceptance-gated pull requests from sandboxed coding tasks, including fork mode
- [Publishing](docs/publishing.md) — Release workflow, npm trusted publishing, and token fallback

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Credits

Built by [Stackbilt](https://stackbilt.dev). AEGIS is the cognitive kernel powering the Stackbilt platform.
