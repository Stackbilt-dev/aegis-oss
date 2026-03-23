# aegis-oss Cleanup Punch List

Remaining work to fully polish the OSS repo for public presentation.

## Test fixture sanitization

Test files use internal repo names and URLs as fixture data. These don't leak to users but should be cleaned for consistency:

- [ ] `web/tests/claude-tools.test.ts` — `aegis@stackbilt.dev`, `edgestack` references
- [ ] `web/tests/dispatch.test.ts` — `edgestack` in insight fixture
- [ ] `web/tests/dreaming.test.ts` — `aegis-daemon` repo name
- [ ] `web/tests/github.test.ts` — `aegis-daemon` alias resolution tests
- [ ] `web/tests/governance.test.ts` — `aegis-daemon`, `edgestack-v2` repo names
- [ ] `web/tests/mcp.test.ts` — `aegis-daemon` repo name
- [ ] `web/tests/memory.test.ts` — `aegis-daemon` origin_repo (many occurrences)
- [ ] `web/tests/memory/insights.test.ts` — `/mnt/c/Users/kover/` path
- [ ] `web/tests/roundtable.test.ts` — `edgestack` CTA product
- [ ] `web/tests/sanitize.test.ts` — real account IDs/tokens in sanitizer test assertions (intentional test data but looks odd in OSS)
- [ ] `web/tests/scheduled.test.ts` — `edgestack_v2` in watch repos
- [ ] `web/tests/self-improvement.test.ts` — `edgestack_v2`, `edgestack-v2`
- [ ] `web/tests/sessions.test.ts` — `aegis-daemon` repo
- [ ] `web/tests/task-intelligence.test.ts` — `aegis-daemon` repo
- [ ] `web/tests/column.test.ts` — `stackbilt.dev` CTA URL

## Source code

- [ ] `web/src/kernel/scheduled/dreaming.ts` — `bizops_drift` key at line 32 (hardcoded, should be configurable or removed)
- [ ] `web/tests/email.test.ts` — `aegis@stackbilt.dev`, `admin@stackbilt.dev` fixtures

## README improvements

- [ ] Add badges (license, tests, TypeScript)
- [ ] Add "Live Example" section linking to https://aegis.stackbilt.dev/health
- [ ] Consider adding a screenshot of the health dashboard
- [ ] Add CONTRIBUTING.md

## General

- [ ] Run full test suite and fix any failures from sanitization changes
- [ ] Verify all doc links in README resolve
- [ ] Add GitHub repo description and topics
