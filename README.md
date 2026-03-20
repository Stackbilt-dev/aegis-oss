# AEGIS

**A persistent AI agent framework for Cloudflare Workers.**

Cognitive kernel with multi-tier memory, autonomous goal pursuit, a dreaming cycle, and declarative governance. Deploy your own persistent AI co-founder on the edge.

## What is AEGIS?

AEGIS is a framework for building **personal AI agents** that remember everything, pursue goals autonomously, and improve themselves while you sleep. Unlike chat-based AI tools that forget between sessions, AEGIS maintains persistent identity, memory, and state across every interaction.

Built on Cloudflare Workers for edge-native deployment. Zero cold starts. Global distribution. Pay-per-request economics.

### Core Capabilities

- **Cognitive Kernel** — Multi-model dispatch (Claude, Groq, Workers AI) with procedural memory routing. The right model for the right task, automatically.
- **Multi-Tier Memory** — Episodic (what happened), semantic (what matters), procedural (what works), narrative (the story arc). Memory consolidates, decays, and strengthens over time.
- **Autonomous Goals** — Set goals and let AEGIS pursue them on a schedule. Progress tracked, blockers surfaced, results reported.
- **Dreaming Cycle** — Nightly self-reflection over conversation history. Discovers patterns, proposes improvements, consolidates knowledge.
- **Declarative Governance** — ADF (Agent Definition Format) files control behavior, constraints, and architectural rules. Version-controlled agent configuration.
- **Operator Identity** — Fully configurable persona, traits, and integration preferences. Your agent, your personality.
- **MCP Native** — Full Model Context Protocol server and client. Connect any MCP-compatible tool.

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

## Architecture

```
                    ┌─────────────────────────┐
                    │     Operator Config      │
                    │  (identity, persona,     │
                    │   integrations)          │
                    └────────────┬────────────┘
                                 │
    ┌────────────────────────────▼────────────────────────────┐
    │                   COGNITIVE KERNEL                       │
    │                                                          │
    │  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
    │  │ Classify  │→│  Route   │→│      Execute            │  │
    │  │ (intent)  │ │(procedure│ │ Claude / Groq / WAI /   │  │
    │  │          │  │ memory)  │ │ Composite / Direct      │  │
    │  └──────────┘  └──────────┘  └───────────────────────┘  │
    │                                                          │
    │  ┌──────────────────────────────────────────────────┐    │
    │  │              MEMORY TIERS                         │    │
    │  │  Episodic → Semantic → Procedural → Narrative    │    │
    │  │  (events)   (facts)    (skills)     (story arcs) │    │
    │  └──────────────────────────────────────────────────┘    │
    │                                                          │
    │  ┌──────────────────────────────────────────────────┐    │
    │  │           SCHEDULED TASKS (hourly cron)           │    │
    │  │  Heartbeat | Consolidation | Goals | Dreaming    │    │
    │  │  Curiosity | Reflection | Escalation             │    │
    │  └──────────────────────────────────────────────────┘    │
    └──────────────────────────────────────────────────────────┘
```

## Configuration

Copy `src/operator/config.example.ts` to `src/operator/config.ts` and customize:

```typescript
export const operatorConfig: OperatorConfig = {
  identity: {
    name: 'Alex',                    // Your name
    possessive: "Alex's",
  },
  persona: {
    tagline: 'pragmatic technical co-founder',
    traits: ['direct', 'systems-thinking', 'builder'],
  },
  // ... integrations, products, etc.
};
```

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Memory System

AEGIS maintains four tiers of memory that work together:

| Tier | Purpose | Lifecycle |
|------|---------|-----------|
| **Episodic** | Raw interaction logs (intent, outcome, cost) | Created per dispatch, pruned after 30 days |
| **Semantic** | Durable facts with topic taxonomy | Promoted from episodic during consolidation |
| **Procedural** | Learned patterns (which executor works for which intent) | Updated on every dispatch outcome |
| **Narrative** | Story arcs and cognitive state | Generated during dreaming cycle |

Memory consolidation runs hourly. The dreaming cycle runs daily to reflect on conversation history and discover cross-session patterns.

## Scheduled Tasks

AEGIS runs these tasks on an hourly cron:

| Task | Cadence | Purpose |
|------|---------|---------|
| Heartbeat | 6h | System health check, dispatch test |
| Consolidation | Hourly | Episodic → semantic memory promotion |
| Goals | 5 of 6 hours | Autonomous goal execution |
| Curiosity | Daily | Research topics from memory gaps |
| Reflection | Weekly | Deep memory reflection cycle |
| Operator Log | Daily | Generate daily activity summary |
| Dreaming | Daily | Nightly self-reflection and pattern discovery |
| Escalation | Hourly | Bump stale agenda item priorities |
| Cognitive Metrics | Daily | Memory health and dispatch quality metrics |

## Optional Integrations

| Integration | Secret | Purpose |
|-------------|--------|---------|
| GitHub | `GITHUB_TOKEN` | Repository scanning, issue management, self-improvement |
| Brave Search | `BRAVE_API_KEY` | Web research capability |
| Resend | `RESEND_API_KEY` | Email notifications |
| Memory Worker | Service Binding | Persistent semantic memory with vector search |
| TarotScript | Service Binding | Deterministic symbolic reasoning |

## Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolates, global edge)
- **Database**: Cloudflare D1 (SQLite at the edge)
- **AI Models**: Claude (Anthropic), Groq (Llama 3.3), Workers AI (GPT-OSS-120B)
- **Framework**: Hono (lightweight, edge-native HTTP)
- **Language**: TypeScript (strict mode)
- **Protocol**: MCP (Model Context Protocol)

## Documentation

- [Getting Started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Memory System](docs/memory-system.md)

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Credits

Built by [Stackbilt](https://stackbilt.dev). AEGIS is the cognitive kernel powering the Stackbilt platform.
