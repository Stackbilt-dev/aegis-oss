# Changelog

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
