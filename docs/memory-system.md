# Memory System

AEGIS maintains four tiers of memory that work together to create persistent, improving intelligence.

## Memory tiers

### Episodic memory

Raw interaction logs — what happened, when, with what outcome.

Every dispatch through the cognitive kernel creates an episode:
- Intent classification
- Executor used
- Success/failure
- Duration and cost
- Conversation context

Episodes are the raw data that feeds all other memory tiers. They're pruned after 30 days to manage storage.

### Semantic memory

Durable facts with topic taxonomy — what the agent knows.

Facts are stored with:
- **Topic** — categorization for retrieval (`project`, `person`, `decision`, etc.)
- **Content** — the actual fact
- **Confidence** — EWA (exponentially weighted average) score that strengthens on access and decays over time
- **Timestamps** — creation time, last accessed time

Semantic memories are the agent's long-term knowledge. They persist indefinitely but can decay if never accessed.

### Procedural memory

Learned patterns — which executor works best for which intent.

Each procedure tracks:
- **Key** — intent category + complexity tier
- **Preferred executor** — the model that has historically performed best
- **Success count / rate** — accumulated over time
- **Refinements** — specific techniques learned for this intent type

Procedures need a minimum number of successful executions before they influence routing. This prevents premature optimization from a single lucky result.

### Narrative memory

Story arcs and cognitive state — the big picture.

Generated during the dreaming cycle, narrative memory captures:
- Themes across conversations
- Evolving priorities and focus areas
- Cross-session patterns
- Meta-insights about the agent's own performance

## Memory lifecycle

```
User message
  │
  ▼
Episode recorded (episodic)
  │
  ▼ (hourly consolidation)
Facts extracted (semantic)
  │
  ▼ (per-dispatch feedback)
Procedure updated (procedural)
  │
  ▼ (daily dreaming cycle)
Narratives synthesized (narrative)
```

### Consolidation (hourly)

The consolidation task reviews recent episodes and promotes significant facts to semantic memory. It looks for:
- New information not already in semantic memory
- Corrections to existing facts
- Patterns across multiple episodes

### Dreaming cycle (daily)

The dreaming cycle runs nightly to reflect on conversation history:

1. **Review** — Scan recent conversations for patterns
2. **Extract** — Pull out durable facts, decisions, and preferences
3. **Synthesize** — Generate narrative arcs and meta-insights
4. **Propose** — Queue improvement tasks or agenda items based on patterns

The dreaming cycle uses Workers AI (free) by default, falling back to Groq if needed.

### Memory decay

Memories that are never accessed gradually lose confidence. The EWA (exponentially weighted average) scoring means:
- Frequently accessed memories stay strong
- Rarely accessed memories decay toward zero
- Pruning removes memories below a confidence threshold

This prevents memory bloat and keeps the agent focused on what's currently relevant.

## Memory in the dispatch cycle

When the kernel dispatches a request, it enriches the context with relevant memories:

1. **Keyword search** — Extract keywords from the user's message and search semantic memory
2. **Topic filter** — Pull memories matching the classified intent's topic
3. **Recency bias** — Weight recently accessed memories higher
4. **Budget** — Cap the total memory context to avoid overwhelming the model's context window

The result is a focused slice of memory relevant to the current conversation.

## Memory via MCP

AEGIS exposes memory operations via MCP tools:

| Tool | Purpose |
|------|---------|
| `aegis_memory` | Search memory by topic and keywords |
| `aegis_record_memory` | Store a new fact |
| `aegis_forget_memory` | Remove a memory entry |

These tools let external AI assistants (Claude Code, Cursor, etc.) read and write to AEGIS memory, enabling persistent context across tools.
