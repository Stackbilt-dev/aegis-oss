# CRIX: Cross-Repo Insight Exchange

> Git-auditable, offline-readable, context-searchable insight storage for Claude Code agents.

## Purpose

This directory stores validated engineering insights discovered during development. Unlike ephemeral chat history or volatile memory, these insights are:

- **Git-auditable** — every insight has a commit trail
- **Offline-readable** — no API calls needed; Claude Code loads them via ADF context
- **Context-searchable** — keywords enable targeted retrieval during relevant work
- **Cross-repo portable** — insights flow between repos via the Memory Worker registry

## Insight Lifecycle

Each insight progresses through four stages:

| Stage | Meaning | Promotion criteria |
|-------|---------|-------------------|
| `candidate` | Newly discovered, single occurrence | Agent flags it during a session |
| `validated` | Confirmed across 2+ occurrences or by human review | Recurrence or explicit operator approval |
| `expert` | Battle-tested, reliably prevents issues | Deployed fix + no regressions over 5+ sessions |
| `canonical` | Universal truth, applies across all repos | Published to Memory Worker registry, consumed elsewhere |

Insights only move forward. If an insight is invalidated, it gets a `**Revoked**` tag with rationale rather than deletion (preserves the learning trail).

## Entry Schema

Every insight entry follows this template:

```markdown
### [Short descriptive title]
- **Type**: pattern | bug_signature | perf_win | arch_improvement | gotcha
- **Origin**: repo@commit (e.g., aegis-daemon@c5cd3f6)
- **Applicable to**: [list of repos where this insight applies]
- **Confidence**: 0.0-1.0 (how certain we are this is a real pattern)
- **Impact**: unknown | confirmed | tested | deployed
- **Keywords**: [searchable terms for context matching]

[Narrative description of the insight: what happened, why it matters,
what to do about it. Include code snippets only when they are load-bearing.]
```

### Field definitions

| Field | Required | Description |
|-------|----------|-------------|
| **Type** | yes | Category bucket — determines which file the insight lives in |
| **Origin** | yes | `repo@commit` where the insight was first discovered |
| **Applicable to** | yes | Repos where this insight is relevant (use `*` for universal) |
| **Confidence** | yes | Float 0.0-1.0. Start at 0.5 for first occurrence, bump on recurrence |
| **Impact** | yes | Current deployment status of the fix/pattern |
| **Keywords** | yes | Terms that help Claude Code surface this insight in relevant contexts |

## File Organization

| File | Contains |
|------|----------|
| `bug-signatures.md` | Locally discovered gotchas, crash patterns, subtle failure modes |
| `perf-patterns.md` | Performance wins — optimizations that measurably improved latency, cost, or throughput |
| `arch-improvements.md` | Architecture learnings — structural changes that improved maintainability or extensibility |
| `cross-repo-learnings.md` | Insights imported from the Memory Worker registry (originated in other repos) |

## Insight Flow

```
Developer session (any repo)
  → Agent discovers pattern / bug / optimization
  → Writes entry to local .ai/insights/<category>.md
  → Entry starts as `candidate`
  → On recurrence or human review → promoted to `validated`
  → On sustained reliability → promoted to `expert`
  → Published to Memory Worker registry → `canonical`
  → Other repos pull from registry → appears in their cross-repo-learnings.md
```

## Runtime Architecture

CRIX has two storage tiers that work together:

### Memory Worker Registry (primary)
- Insights stored in `stackbilt-memory` D1 with Vectorize semantic embeddings
- Topic: `cross_repo_insights`, source: `crix_publish`
- Fields: `insight_type`, `origin_repo`, `keywords`, `cross_repo_impact`, `validation_stage`
- Recall via `memoryBinding.recall()` with semantic search (BGE-base-en-v1.5)

### AEGIS D1 Anchor (dedup)
- Lightweight entries in `memory_entries` table for fact-hash dedup across consolidation cycles
- Prevents re-publishing the same insight every hourly tick
- Contains `validation_stage` and `validators` columns for the promotion state machine

### Publishing Pipeline
1. **Consolidation cycle** (hourly) → `publishInsightsFromMemory()` scans:
   - Learned procedures: ≥70% success rate, 3+ successes
   - High-confidence semantic entries: ≥0.85 confidence, from dreaming/consolidation, last 24h
2. **Three publish gates**: confidence ≥ 0.75, fact-hash dedup, context-specificity filter
3. Rate limited to 5 insights per consolidation cycle

### Dispatch Injection
- `fetchRelevantInsights()` queries Memory Worker for `validated`+ insights
- Keyword-scored against current query, top 3 injected as `[Cross-Repo Intelligence]` block
- 1-hour in-memory cache, skips greeting/heartbeat intents

### Validation Pipeline
- **Self-improvement** (4x/day) → `validateCandidateInsights()` confirms candidates against local memory
- **State machine**: candidate → validated → expert → canonical (forward-only)
- **Circuit breaker**: 2+ rejections → `refuted` (terminal state)

## Convention

- One insight per `###` heading block
- Newest entries at the bottom of each file
- Never delete — revoke with rationale if invalidated
- Keep descriptions concise but complete enough to act on without additional context
