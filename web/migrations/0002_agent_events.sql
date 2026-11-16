-- 0.12.0: agent_events, the durable event inbox for the always-on run model
-- (aegis-oss#100). Handlers only insert rows; one runner per principal claims
-- them in batches, and a claim left behind by a crashed run is reclaimed.
--
-- Apply to a database created before 0.12.0:
--   npx wrangler d1 execute <db> --remote --file=migrations/0002_agent_events.sql
-- Fresh installs get the table from schema.sql and do not need this file.

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL DEFAULT 'operator',   -- whose inbox: one runner per principal
  source TEXT NOT NULL,                          -- 'github', 'telegram', 'chat', 'timer', 'approval', ...
  source_id TEXT,                                -- delivery/message ID from the source; NULL = no dedup
  kind TEXT NOT NULL,                            -- e.g. 'user_message', 'webhook', 'followup', 'approval'
  payload TEXT NOT NULL DEFAULT '{}',            -- JSON
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'deferred')),
  attempts INTEGER NOT NULL DEFAULT 0,           -- claims so far
  claim_id TEXT,                                 -- token of the run holding the claim
  claimed_at TEXT,
  available_at TEXT NOT NULL,                    -- not claimable before this (retry backoff)
  run_id TEXT,                                   -- run that completed, failed or deferred it
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_events_claim
  ON agent_events(principal, status, available_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_created
  ON agent_events(created_at);
