# aegis-oss Cleanup Punch List

Remaining work to fully polish the OSS repo for public presentation.

## Completed

- [x] Test fixture sanitization (30 test files — all internal refs replaced)
- [x] Source code sanitization (all hardcoded account IDs, tokens, URLs, personal names removed)
- [x] Script sanitization (deploy.sh, session-digest.sh, taskrunner.sh)
- [x] Schema.sql comment cleanup
- [x] ADF file sanitization (core.adf, state.adf, agent.adf, persona.adf)
- [x] Insights file sanitization
- [x] `.env` deleted, added to `.gitignore`
- [x] Hardcoded CF account ID → `env.CF_ACCOUNT_ID`
- [x] `bizops_drift` in dreaming.ts → conditionally included based on config
- [x] Charter governance bootstrapped (.charter/, CI workflow, manifest)
- [x] Orphaned ADF modules registered in manifest
- [x] README badges (license, TypeScript, Vitest, Cloudflare Workers)
- [x] Live example section in README
- [x] CONTRIBUTING.md
- [x] Doc links verified
- [x] Agent platform pointers (CLAUDE.md, .cursorrules, agents.md, GEMINI.md, copilot-instructions.md)

## Remaining

### Source stubs needed

12 source files referenced by tests haven't been extracted from the private repo yet.
Stub files are being created so tests can import; full implementations needed later:

- [ ] `web/src/kernel/memory/insights.ts` — insight publishing/validation pipeline
- [ ] `web/src/kernel/board.ts` — project board integration
- [ ] `web/src/content/hero-image.ts` — hero image generation
- [ ] `web/src/kernel/scheduled/self-improvement.ts` — scheduled self-improvement analysis
- [ ] `web/src/routes/operator-logs.ts` — operator log API routes
- [ ] `web/src/content/column.ts` — column content generation
- [ ] `web/src/content/journal.ts` — journal content generation
- [ ] `web/src/content/roundtable.ts` — roundtable content generation
- [ ] `web/src/kernel/scheduled/issue-watcher.ts` — GitHub issue monitoring
- [ ] `web/src/routes/content.ts` — content API routes
- [ ] `web/src/routes/observability.ts` — observability API routes
- [ ] `web/src/routes/pages.ts` — pages/UI routes

### Pre-existing test failures

These test failures exist independent of sanitization work:

- [ ] `web/tests/email.test.ts` — 6 failures (function signature mismatches: `sendMorningBriefing`, `sendStaleAgendaAlert` not exported)
- [ ] `web/tests/composite.test.ts` — 1 failure (`result.meta` undefined in fast-path test)
- [ ] `web/tests/messages.test.ts` — 1 failure (500 error response format)
- [ ] `web/tests/health.test.ts` — 2 failures

### Polish

- [ ] Add GitHub repo description and topics (after push)
- [ ] Consider adding a screenshot of the health dashboard to README
- [ ] `charter adf populate` — auto-fill ADF context from codebase signals
