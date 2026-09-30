-- Index the "last 24h" task_runs queries (/health, pulse, issue-proposer,
-- cognitive-metrics). Without it every one of them reads the whole table.
--
-- Apply to a database created before this release:
--   npx wrangler d1 execute <db> --remote --file=migrations/0002_task_runs_created_index.sql
--   npx wrangler d1 execute <db> --remote --command "PRAGMA optimize"
-- The GROUP BY task_name queries only avoid a full scan once the table has
-- statistics; if sqlite_stat1 has no task_runs rows after PRAGMA optimize,
-- run ANALYZE task_runs. Fresh installs get the index from schema.sql.

CREATE INDEX IF NOT EXISTS idx_task_runs_created ON task_runs(created_at, task_name, status);
