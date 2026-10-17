-- 0.11.0: approving a proposed task records who and when, and keeps the
-- authority 'proposed' so the task still runs isolated (worktree + PR,
-- never in the operator's checkout).
--
-- Apply to a database created before 0.11.0:
--   npx wrangler d1 execute <db> --remote --file=migrations/0002_cc_tasks_approval.sql
-- Fresh installs get the columns from schema.sql and do not need this file.
--
-- Tasks approved before 0.11.0 were rewritten to authority 'operator'; that
-- can't be undone here because the original authority wasn't kept.

ALTER TABLE cc_tasks ADD COLUMN approved_at TEXT;
ALTER TABLE cc_tasks ADD COLUMN approved_by TEXT;
