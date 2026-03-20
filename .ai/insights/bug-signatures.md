# Bug Signatures

Locally discovered gotchas, crash patterns, and subtle failure modes. These are the bugs that bite twice if you don't document them.

---

### MCP SSE response null-guard failure
- **Type**: bug_signature
- **Origin**: aegis-daemon@c5cd3f6
- **Applicable to**: [aegis-daemon, bizops-copilot]
- **Confidence**: 0.9
- **Impact**: deployed
- **Keywords**: mcp, sse, replace, trim, null guard, crash loop, groq, response validation

Two-sided failure across BizOps and AEGIS. BizOps `validation.ts` used fragile `query.replace()` for SQL sanitization, producing malformed MCP SSE responses. AEGIS `mcp-client.ts` didn't validate the response structure before consuming it, and `router.ts:99` / `evaluator.ts:60` called `.trim()` and `.replace()` on Groq responses without null guards. The combination caused a crash loop — malformed upstream data met unguarded downstream consumers. Fix: validate MCP response structure at the boundary AND null-guard all string operations on LLM/external responses.

### D1 constraint violation on partial_failure outcome
- **Type**: bug_signature
- **Origin**: aegis-daemon@goals.ts:91
- **Applicable to**: [aegis-daemon]
- **Confidence**: 0.8
- **Impact**: deployed
- **Keywords**: d1, constraint, agent_actions, partial_failure, outcome mapping

The `agent_actions` table had a CHECK constraint on the outcome column that didn't include `partial_failure` as a valid value. The composite executor could legitimately produce a partial failure, but D1 rejected the insert. Fix: map `partial_failure` to `'failure'` at the persistence boundary rather than expanding the constraint (keeps the schema tight, handles the edge case at the application layer).

### Goal cadence runaway from touchGoal placement
- **Type**: bug_signature
- **Origin**: aegis-daemon@goals.ts:114-118
- **Applicable to**: [aegis-daemon]
- **Confidence**: 0.85
- **Impact**: deployed
- **Keywords**: goals, cadence, runaway, scheduled, touchGoal, finally block

`touchGoal` was called early in the goal evaluation flow. If the evaluation threw an error, the goal's `last_run` wasn't updated, so the scheduler kept re-triggering it — 28-38 runs/day instead of the expected cadence. Fix: move `touchGoal` into a `finally` block so the timestamp updates regardless of success or failure.
