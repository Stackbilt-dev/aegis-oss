# Changelog

## 0.6.3 (2026-05-08)

### Changed
- All executor LLM calls now routed through `@stackbilt/llm-providers` `LLMProviderFactory` — eliminates hand-rolled inference in `executeGroq`, `executeWorkersAi`, and `executeGptOss` (Phase D.1–D.5)
- `executeGptOss` two-phase tool loop migrated to factory: `LLMMessage[]` message format, cost from `result.usage.cost`, `topP`/`frequencyPenalty` forwarded via new `LLMRequest` fields
- `kernel/executors` now exports `EXECUTOR_FNS` — uniform `(intent, env) → {text, cost}` dispatch map for groq, workers_ai, gpt_oss, claude; powers route-driven dispatch in `dispatch.ts`
- `dispatch.ts` switch collapsed: groq/workers_ai/gpt_oss/shadow-exploration cases replaced by `EXECUTOR_FNS` lookup; explicit branches kept only for claude/claude_opus failover, composite, direct, claude_code, tarotscript
- New: `kernel/executor-router.ts` — `EXECUTOR_ROUTES` catalog (provider, model fn, fallback chain) for all 7 LLM executors; `getExecutorRoute()` helper
- New: `kernel/provider-factory.ts` — `buildLLMProviderFactory(env)` wraps `@stackbilt/llm-providers` with EdgeEnv bindings

### Dependencies
- `@stackbilt/llm-providers` bumped to `^1.6.4` (published):
  - `gpt-oss-120b` cost rates fixed: `$0.35/$0.75 per MTok` (was `$0.0008/MTok` placeholder)
  - `topP` and `frequencyPenalty` added to `LLMRequest`; forwarded as `top_p`/`frequency_penalty` by the Cloudflare provider

## 0.6.2 (2026-05-07)

### Added
- `kernel/patterns` — convergence pattern contracts (P1 `PositionalDispatch`, P7 `TieredExecution`); exports `POSITIONAL_DISPATCH_PATTERN_ID`, `TIERED_EXECUTION_PATTERN_ID`, and their `*_CONTRACT_VERSION` constants; consumer repos import the interface for structural-compat tests

## 0.6.1 (2026-05-07)

### Changed
- `Executor` union extended with `'cerebras_mid' | 'cerebras_reasoning'` — unblocks daemon shadow collapse; `EXECUTOR_ATTACHMENTS` in `kernel/memory/blocks` maps both to `CORE_BLOCKS`

## 0.6.0 (2026-05-07)

### Added
- `kernel/grounding/verify` — `verifyAgendaClaim`, `verifyTaskClaim`, `verifyWikiPageClaim` (aegis-oss#34 PR 3)
- `kernel/grounding/fanout` — `extractEntities`, `groundIntent`, `summarizeGrounding`, `formatGroundingBlock` (entity grounding fanout without BizOps leg)
- `kernel/grounding/fabrication-detector` — mutation-claim v1 + referential-claim v2 post-pass; `pattern_id` verification skipped in core (catalog is consumer-specific)
- `kernel/grounding/semantic-sanhedrin` — Workers AI wiki-contradiction gate (aegis#573)
- `kernel/grounding-layer` — orchestrator: `augmentWithInsights`, `augmentWithEntityGrounding`, `augmentWithMemoryRecall`, `applyFabricationCheck`, `applyGapSignal`, `applyGroundingProof`
- `wikiBinding?: Fetcher` and `wikiToken?: string` added to `EdgeEnv` (required by grounding-layer)
- `grounded?`, `sources?`, `unknowns?`, `searched?`, `unverified_claims?` added to `DispatchResult`

### Notes
- Decision-entity fanout (BizOps `verifyDecisionClaim`) is omitted — daemon-specific; consumers compose at call site
- Circuit-breaker wrapping absent from this layer; consumers wanting auto-disable-after-N-failures compose at call site using `createResilience()` from `kernel/resilience`
- `pattern_id` verification skipped in `verifyReferentialClaims`; the convergence-patterns catalog lives in the daemon and is not generic
- No tests ported in this release

## 0.5.1 (2026-05-07)

### Changed
- Removed `court_card` from `EpisodicEntry` interface and `episodic_memory` schema — it is TarotScript/Stackbilt-specific, not generic agent framework content (scope creep from 0.5.0)

### Migration
- `episodic_memory` schema: if you applied 0.5.0's `court_card TEXT` column, drop it: `ALTER TABLE episodic_memory DROP COLUMN court_card` (SQLite 3.35+) or recreate the table

## 0.5.0 (2026-05-07)

### Added
- `kernel/memory-service` — `MemoryService` class and `memoryServiceFor()` factory ported from daemon (aegis-oss#34 PR 2)
- `recordGapSignal` / `clearGapSignal` added to `kernel/memory/procedural` and exported from `kernel/memory` index
- `gap_signal_count` / `gap_last_seen` columns added to `procedural_memory` schema
- `executor_config` column added to `episodic_memory` schema (parity with daemon)
- `EpisodicEntry` extended with `complexity_tier`, `executor_config` optional fields
- `ProceduralEntry` extended with `gap_signal_count`, `gap_last_seen` optional fields

## 0.4.0 (2026-05-07)

### Added
- `wiki/client` — EmDash CMS client ported from daemon; `WikiClientEnv.wikiBaseUrl` replaces hardcoded Stackbilt URL (configurable by consuming apps)
- `wiki/types` — `WikiScope`, `WikiType`, `WikiConfidence`, `WikiStatus` enums + all page/write/result interfaces
- Exported at `@stackbilt/aegis-core/wiki/client` and `@stackbilt/aegis-core/wiki/types`

## 0.3.0 (2026-05-07)

### Added
- ODD contracts for 4 core entities: `GoalContract`, `AgendaItemContract`, `CCTaskContract`, `MemoryEntryContract`
- Exported at `@stackbilt/aegis-core/contracts/{goal,agenda-item,cc-task,memory-entry}`
- Contracts use camelCase (ODD convention); existing snake_case D1 interfaces untouched
- `@stackbilt/contracts` and `zod` added as dependencies

## 0.2.0 (2026-05-07)

### Added
- `schema-enums` is now a public export (`@stackbilt/aegis-core/schema-enums`)
- Generic `ScheduledTaskPlugin<TEnv>` — consuming apps with extended `EdgeEnv` superset no longer need a cast wrapper; `scheduledTasks` accepts `ScheduledTaskPlugin<any>[]`
- Upstreamed generic enums from daemon: `JOB_STATUSES`, `TERMINAL_JOB_STATUSES`, `SPRINT_STAGES`, `RISK_LEVELS`, `ALERT_SEVERITIES`

## 0.1.0 (2026-05-07)

Initial public release.
