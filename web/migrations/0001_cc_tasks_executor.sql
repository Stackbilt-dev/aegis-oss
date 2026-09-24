-- 0.9.0: route cc_tasks to an executor. Existing rows keep running on the
-- local task runner (claude_code); the sandbox task executor claims only
-- rows with executor = 'do_sandbox'.
--
-- Apply to a database created before 0.9.0:
--   npx wrangler d1 execute <db> --remote --file=migrations/0001_cc_tasks_executor.sql
-- Fresh installs get the column from schema.sql and do not need this file.

ALTER TABLE cc_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'claude_code'
  CHECK (executor IN ('claude_code', 'do_sandbox'));

CREATE INDEX IF NOT EXISTS idx_cc_tasks_executor ON cc_tasks(executor, status, priority);
