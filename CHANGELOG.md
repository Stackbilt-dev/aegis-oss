# Changelog

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
