# Architecture

AEGIS is a cognitive kernel — a persistent AI agent framework that runs on Cloudflare Workers.

## System overview

```
Request → Auth → Cognitive Kernel → Response
                     │
                     ├── Classify (intent detection)
                     ├── Route (procedural memory lookup)
                     ├── Execute (model dispatch)
                     └── Learn (episode recording)

Cron (hourly) → Scheduled Tasks
                     │
                     ├── Phase 1: Free (D1 only)
                     │   └── Escalation, consolidation
                     ├── Phase 2: Cheap (1-4 LLM calls)
                     │   └── Heartbeat, cognitive metrics
                     └── Phase 3: Heavy (budget-aware)
                         └── Goals, dreaming, curiosity
```

## The dispatch cycle

Every user message follows the same path through the kernel:

1. **Classify** — Determine the user's intent from the message. Uses fast models (Groq/Workers AI) for classification, not the expensive model.

2. **Route** — Check procedural memory for a learned procedure matching this intent. If a procedure exists with enough successful executions, route to its preferred executor. Otherwise, use the default routing logic.

3. **Execute** — Dispatch to the selected executor (Claude, Groq, Workers AI, composite, or direct). The executor receives the message plus context from memory (relevant facts, recent conversation, agenda items).

4. **Learn** — Record the episode: what was asked, which executor handled it, whether it succeeded, how long it took, what it cost. This feeds back into procedural memory over time.

## Executors

AEGIS supports multiple AI backends, selected per-request based on intent and learned performance:

| Executor | Model | Use case |
|----------|-------|----------|
| `claude` | Claude Sonnet | Complex reasoning, code, analysis |
| `claude-opus` | Claude Opus | Highest capability tasks |
| `groq` | Llama 3.3 70B | Fast responses, classification |
| `workers-ai` | Workers AI models | Free inference, summarization |
| `composite` | Multi-model | Complex queries requiring multiple perspectives |
| `direct` | None (D1 only) | Memory lookups, agenda management |
| `tarotscript` | Symbolic engine | Deterministic computation (optional) |

The kernel learns over time which executor works best for each intent category via procedural memory.

## Scheduled tasks

The hourly cron runs tasks in phases to respect Cloudflare's subrequest limits:

**Phase 1 — Free (D1 only, 0 subrequests)**
- Agenda escalation (bump stale item priorities)
- Memory consolidation (episodic → semantic promotion)

**Phase 2 — Cheap (1-4 LLM calls)**
- Heartbeat (system health check)
- Cognitive metrics (memory health, dispatch quality)
- Operator log (daily activity summary)

**Phase 3 — Heavy (mutually exclusive, budget-aware)**
- Goal execution (autonomous goal pursuit)
- Dreaming cycle (nightly self-reflection)
- Curiosity (research from memory gaps)
- Reflection (weekly deep review)

Phase 3 tasks are mutually exclusive within a single cron invocation to stay under Cloudflare's 50-subrequest limit per Worker invocation.

## Storage

All state lives in a single D1 database:

- `conversations` / `messages` — Chat history
- `episodic_memory` — Raw interaction logs
- `memory_entries` — Semantic facts with topic taxonomy
- `procedures` — Learned execution patterns
- `agenda_items` — Persistent action items
- `goals` / `goal_actions` — Autonomous goal tracking
- `task_runs` — Scheduled task observability
- `cc_tasks` — External task queue (for cc-taskrunner integration)

## MCP integration

AEGIS exposes its capabilities via the [Model Context Protocol](https://modelcontextprotocol.io/):

- **MCP Server** — Other AI tools can call AEGIS tools (memory, agenda, goals, chat)
- **MCP Client** — AEGIS can call external MCP services (configured via service bindings)

## Key design decisions

**Edge-native**: Everything runs in V8 isolates on Cloudflare's edge. No containers, no servers, no cold starts beyond single-digit milliseconds.

**Single database**: All state in one D1 instance. Simpler ops, atomic transactions, no distributed consistency problems.

**Phased scheduling**: Rather than running all tasks every hour, tasks are grouped by cost and time-gated internally. Expensive tasks run less frequently.

**Procedural learning**: The kernel doesn't just dispatch — it learns. Each successful execution strengthens the procedure that chose that executor. Failed executions degrade it. Over time, routing improves without manual tuning.

**Operator-configurable**: Identity, persona, integrations, and behavior are all controlled via TypeScript config files, not hardcoded. Same codebase, different agent.
