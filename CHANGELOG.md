# Changelog

## 0.9.1 (2026-09-24)

### Fixed
- `@stackbilt/aegis-core/factory` could not be imported outside the Workers runtime. It re-exported the executor Durable Object and `Sandbox`, which load `cloudflare:` modules, so any Node import failed: tests, scripts, and MCP handlers that only needed `parseAcceptanceSpec` or the repository policy. The classes moved to a new entry point, `@stackbilt/aegis-core/factory/executor`. `factory` is now runtime-neutral, and a test imports it under plain Node to keep it that way.
- **Migration from 0.9.0:** import `createTaskExecutorDO` and `Sandbox` from `@stackbilt/aegis-core/factory/executor` instead of `@stackbilt/aegis-core/factory`. The `TaskExecutorConfig` and `TaskExecutorEnv` types are still available from both.

## 0.9.0 (2026-09-24)

### Added
- **Sandbox task executor** (`@stackbilt/aegis-core/factory`), ported from the Stackbilt reference deployment, where it has delivered acceptance-gated PRs including one to a repository outside its org.
  - It runs a `do_sandbox` cc_task in a Cloudflare Sandbox container with a bounded Workers AI tool loop.
  - It checks the result against the task's ` ```acceptance ` contract using facts the executor gathers itself (staged diff, file contents, a vitest re-run with a JSON report).
  - It publishes a PR only when every check passes. Branches are named after the diff, so an identical re-run attaches to the open PR instead of duplicating it.
  - Fork mode handles `owner/name` repositories outside `homeOrg`.
  - Configured through `createTaskExecutorDO({ homeOrg, gitIdentity, model?, bootstrap?, verificationCwd?, externalRepoPolicy? })`.
  - Opt-in through `taskExecutorDispatchPlugin` (heartbeat dispatch) and `taskExecutorRoutes` (`/api/task-executor/{run,status,artifacts}`).
  - The container config ships commented out in `wrangler.toml.example`, with `Dockerfile.sandbox`, so the default deploy is unchanged: free tier, no Docker. Guide: `docs/sandbox-executor.md`.
- `cc_tasks.executor` (`claude_code` | `do_sandbox`, default `claude_code`). Existing databases apply `migrations/0001_cc_tasks_executor.sql`, the first numbered migration; existing rows keep `claude_code`.
- `aegis_create_cc_task` accepts `executor`. For `do_sandbox` it rejects a malformed acceptance block, and it rejects `auto_safe` tasks that lack one.
- Optional `TASK_EXECUTOR` binding on `Env`, mapped to `EdgeEnv.taskExecutor`.

### Changed
- `@stackbilt/llm-providers` `^1.6.4` → `^1.21.0` (tool calling for the executor). New dependencies: `@cloudflare/sandbox` `0.12.1`, pinned to match the container image tag, and `@cloudflare/shell` `^0.4.0`.
- `src/version.ts` said 0.8.6 through the 0.8.7 and 0.8.8 releases. It now tracks `package.json`.

## 0.8.8 (2026-09-24)

### Fixed
- `runEntropyDetection` inserted a text `id` into `digest_sections`, whose `id` is database-assigned; every other writer omits it. The entropy digest row now lets the database assign its id.
- `detectLlmTraceAnomalies` selected `json_extract(summary, '$')`, which throws on any episode whose summary isn't JSON (most of them), failing the whole query. The column was never read, so it's removed.
- Both fixes had been carried downstream as a pnpm patch in the reference deployment; they are upstreamed here so it can drop the patch.

## 0.8.7 (2026-07-01)

### Changed
- **Memory unification follow-up (aegis-oss#78)**: `consolidateEpisodicToSemantic` (`kernel/memory/consolidation.ts`) redesigned to write through `writeDreamFact()` (new `kernel/memory/dream-write.ts`) into the wiki's `dreams` scope, instead of writing raw fragments straight into the memory-worker fragment store — this was the deferred piece of the #457 wiki unification the original decision doc flagged as needing design work. Consolidation is now purely additive (extract 0-3 genuine facts per cycle, write each as its own dream page); the old ADD/UPDATE/DELETE-by-fragment-id model doesn't map cleanly onto wiki pages, so update/delete semantics are dropped in favor of the dreams lifecycle (promote on corroboration, archive if stale) already used by PRISM's cross-domain synthesis.
- Removed `publishInsightsFromMemory()` from `kernel/scheduled/consolidation.ts` — this CRIX insight-publishing step called `publishInsight()`/`validateInsight()` against a D1 table literally named `memory`, which is never created by any migration in this repo or in aegis-daemon. Every invocation was silently failing (caught and logged as a warning) on every consolidation cycle. `insights.ts`'s public API (`publishInsight`, `validateInsight`, `promoteInsight`, `listInsights`, etc.) is left intact as OSS surface for downstream consumers — only the internal, broken call site was removed.

### Added
- OTDD contract test suites for all five bounded contexts — AgendaItem (48 tests), CCTask (53 tests), Goal (65 tests), ExecutorRouter I1/I2 violation paths (4 tests), and MemoryEntry/CRIX pipeline (33 tests). Tests are derived directly from `.contract.ts` schema, state machine, invariant, and authority declarations with no mocks.

### Fixed
- `executor-router.ts` — added `isDefault?: true` to `ExecutorRoute` interface to match `ExecutorRouteShapeSchema` in the contract; removes TS2353 on the `workers_ai` route.
- `workers-ai-chat.ts` — narrowed `Ai.run()` overload cast via explicit function-signature cast to resolve TS2769/TS2352; removes the `as Record<string, unknown>` workaround that leaked the intersection mismatch.
- `kernel/memory/agenda.ts` — `resolveAgendaItem` now adds `AND status = 'active'` to its UPDATE and throws when 0 rows are affected, enforcing the contract's terminal-state invariant for `done` and `dismissed`.

## 0.8.0 (2026-06-02)

### Added
- Vite-built embedded web console served through the Worker `ASSETS` binding, including text chat, conversation history, health summary, and a voice panel using `@cloudflare/voice/react`. (aegis-oss#40)
- `AegisVoiceAdapter` standalone Worker export and Agents SDK `/agents/aegis-voice-adapter/operator` routing for Cloudflare-native voice calls. (aegis-oss#40)
- Built `public/` SPA assets in the package so a fresh checkout can deploy a working console without a private Stackbilt UI dependency. (aegis-oss#40)

### Changed
- `npm run deploy` and `npm run dev` now build the embedded UI before invoking Wrangler, and `wrangler.toml.example` includes `ASSETS`, `CHAT_SESSION`, `AegisVoiceAdapter`, `DB`, and `AI` bindings.
- The browser console uses Workers AI for its base chat path and treats Claude/Groq keys as optional executor upgrades.

### Fixed
- `/agents/*` voice routes now enforce the same `AEGIS_TOKEN` via bearer header, cookie, or query token before reaching the Agents SDK router.
- HTTP message routes skip Groq title generation when `GROQ_API_KEY` is unset.

## 0.7.0 (2026-06-02)

### Added
- `cli/aegis.mjs` and the `aegis` package binary, including quick-start connection handling and executor override support for terminal demos. (aegis-oss#55)
- `/chat/ws`, `ChatSession`, and `ChatSessionAuth` primitives for websocket-backed chat sessions, plus schema/configuration docs and tests. (aegis-oss#55)
- Standalone chat shell UI support and a disambiguation firewall for safer routing and demo-path trust hardening.

### Changed
- Migrated the remaining in-repo LLM inference paths through `@stackbilt/llm-providers`: Claude executor, dynamic tools, Groq helpers, Workers AI helper fallbacks, composite execution, and the last raw Groq logprobs path. (aegis-oss#24)
- Hardened digest delivery, grounding dispatch, and grounding-gap persistence so failed or missing evidence is recorded more consistently.

### Fixed
- Restored the release workflow's npm publish auth fallback while preserving trusted publishing support. (aegis-oss#51)

## 0.6.5 (2026-06-02)

### Fixed
- `auth.ts` — the bearer-token login form now renders for **any** HTML navigation (GET request with `Accept: text/html`) instead of a hardcoded `'/chat' | '/overworld' | '/console'` path list. Path-agnostic, so downstream variant pages (e.g. the daemon's `/lite` mobile surface) get the fresh-device login form for free with no core-side route coupling. Non-HTML (fetch/XHR) requests still get a JSON 401. (aegis-oss#50)

## 0.6.4 (2026-05-19)

### Added
- `kernel/scheduled/curiosity.ts` — new `'conversation_gap'` source type (7th in `CuriosityCandidate['source']` union) surfaces consolidation pipeline gaps alongside knowledge gaps; MindSpring fanout (up to 3 parallel queries with 1.5s timeout, threshold 0.5) identifies topics with ≥1 conversation match but ≤2 MW entries; `thinTopicSeeds: string[]` collector preserves raw MW topic strings before wrapping in question format

## 0.6.3 (2026-05-08)

### Changed
- All executor LLM calls now routed through `@stackbilt/llm-providers` `LLMProviderFactory` — eliminates hand-rolled inference in `executeGroq`, `executeWorkersAi`, and `executeGptOss` (Phase D.1–D.5)
- `executeGptOss` two-phase tool loop migrated to factory: `LLMMessage[]` message format, cost from `result.usage.cost`, `topP`/`frequencyPenalty` forwarded via new `LLMRequest` fields
- `kernel/executors` now exports `EXECUTOR_FNS` — uniform `(intent, env) → {text, cost}` dispatch map for groq, workers_ai, gpt_oss, claude; powers route-driven dispatch in `dispatch.ts`
- `dispatch.ts` switch collapsed: groq/workers_ai/gpt_oss/shadow-exploration cases replaced by `EXECUTOR_FNS` lookup; explicit branches kept only for claude/claude_opus failover, composite, direct, claude_code, tarotscript
- New: `kernel/executor-router.ts` — `EXECUTOR_ROUTES` catalog (provider, model fn, fallback chain) for all 7 LLM executors; `getExecutorRoute()` helper
- New: `kernel/provider-factory.ts` — `buildLLMProviderFactory(env)` wraps `@stackbilt/llm-providers` with EdgeEnv bindings

### Exports (aegis-oss#43)
- `@stackbilt/aegis-core/kernel/provider-factory` — `buildLLMProviderFactory(env)` now a named subpath import
- `@stackbilt/aegis-core/kernel/executor-router` — `EXECUTOR_ROUTES`, `getExecutorRoute`, `ExecutorRoute`, `LLMExecutor` now importable by consumers

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
