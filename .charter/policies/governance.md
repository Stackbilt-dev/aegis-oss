# Governance Policy

## Commit Trailers

High-risk commits (migrations, handlers, services) should include:

```
Governed-By: <ADR-ID or ledger entry reference>
Resolves-Request: <governance request ID>
```

Keep governance trailers in one contiguous block at the end of the commit message.
Do not insert a blank line between governance trailers and other trailers like Co-Authored-By.

## Change Classification

Changes are classified as:
- **SURFACE**: Docs, comments, naming - no code logic
- **LOCAL**: Single service, contained impact
- **CROSS_CUTTING**: Multiple services, data model, API contracts

## Exception Path

Use documented exception requests when policy cannot be applied directly.
Capture waiver reason, approver, and expiration.

## Escalation & Approval

Cross-cutting changes require architectural review before merge.
Escalate ambiguous or high-risk decisions for explicit approval.

## Agent Standards Compatibility

If repository-level agent standards exist (for example `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`), Charter policy is complementary and does not override those files.
Keep governance workflows aligned across all active agent instruction standards.
