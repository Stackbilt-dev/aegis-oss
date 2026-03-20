-- AEGIS Web — D1 Schema
-- Run: wrangler d1 execute aegis-web --file=schema.sql

-- ─── Chat ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);


CREATE TABLE IF NOT EXISTS web_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── ARGUS Phase 1: Webhook Event Ingestion ──────────────────


-- ─── Kernel Memory ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  fact_hash TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.8,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  valid_until TEXT,                           -- NULL = current/active; set to invalidate
  superseded_by INTEGER,                     -- FK to replacing entry's id
  strength INTEGER NOT NULL DEFAULT 1,       -- recall frequency (for decay)
  last_recalled_at TEXT,                     -- last retrieval time
  -- CRIX Phase 2a: validation pipeline
  validation_stage TEXT DEFAULT 'candidate'
    CHECK (validation_stage IN ('candidate', 'validated', 'expert', 'canonical', 'refuted')),
  validators TEXT                            -- JSON array: [{ repo, confirmed, date }]
);

CREATE TABLE IF NOT EXISTS episodic_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_class TEXT NOT NULL,
  channel TEXT NOT NULL,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  near_miss TEXT,
  classifier_confidence REAL,
  reclassified INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,                              -- conversation thread for dreaming cycle
  executor TEXT,                               -- which executor handled this
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS procedural_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_pattern TEXT NOT NULL UNIQUE,
  executor TEXT NOT NULL,
  executor_config TEXT NOT NULL DEFAULT '{}',
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'learning',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  refinements TEXT NOT NULL DEFAULT '[]',
  last_used TEXT,
  candidate_executor TEXT,                     -- probation: untrusted executor being tested
  candidate_successes INTEGER NOT NULL DEFAULT 0,  -- consecutive successes of candidate
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heartbeat_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actionable BOOLEAN NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_agenda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  context TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- ─── Autonomous Goals (#14) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  authority_level TEXT NOT NULL DEFAULT 'propose' CHECK (authority_level IN ('propose', 'auto_low', 'auto_high')),
  schedule_hours INTEGER NOT NULL DEFAULT 6,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_run_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  context_json TEXT
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  goal_id TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('proposed', 'executed', 'skipped')),
  description TEXT NOT NULL,
  tool_called TEXT,
  tool_args_json TEXT,
  tool_result_json TEXT,
  outcome TEXT CHECK (outcome IN ('success', 'failure', 'pending')),
  auto_executed INTEGER NOT NULL DEFAULT 0,
  authority_level TEXT NOT NULL DEFAULT 'propose',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Reflections (#introspection) ─────────────────────────────

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  memory_count INTEGER NOT NULL DEFAULT 0,
  topics_covered TEXT,               -- JSON array of topic strings
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Operator Log (#introspection) ────────────────────────────

CREATE TABLE IF NOT EXISTS operator_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  episodes_count INTEGER NOT NULL DEFAULT 0,
  goals_run INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed INTEGER NOT NULL DEFAULT 0,
  prs_created INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,            -- cost of generating this log entry
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_topic ON memory_entries(topic);
CREATE INDEX IF NOT EXISTS idx_memory_dedup ON memory_entries(topic, fact_hash);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_entries(expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_valid ON memory_entries(valid_until);
CREATE INDEX IF NOT EXISTS idx_memory_validation_stage ON memory_entries(validation_stage);
CREATE INDEX IF NOT EXISTS idx_episodic_class ON episodic_memory(intent_class);
CREATE INDEX IF NOT EXISTS idx_episodic_created ON episodic_memory(created_at);
CREATE INDEX IF NOT EXISTS idx_episodic_thread ON episodic_memory(thread_id);
CREATE INDEX IF NOT EXISTS idx_procedural_pattern ON procedural_memory(task_pattern);
CREATE INDEX IF NOT EXISTS idx_procedural_status ON procedural_memory(status);
CREATE INDEX IF NOT EXISTS idx_heartbeat_created ON heartbeat_results(created_at);
CREATE INDEX IF NOT EXISTS idx_agenda_status ON agent_agenda(status);
CREATE INDEX IF NOT EXISTS idx_agenda_priority ON agent_agenda(priority);
CREATE INDEX IF NOT EXISTS idx_goals_status ON agent_goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_next_run ON agent_goals(next_run_at);
CREATE INDEX IF NOT EXISTS idx_actions_goal ON agent_actions(goal_id);
CREATE INDEX IF NOT EXISTS idx_actions_created ON agent_actions(created_at);

-- ─── Task Observability ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  duration_ms INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_runs_name ON task_runs(task_name, created_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status, created_at);

-- ─── Shadow Mode: Dual-Write Tracking ───────────────────────

CREATE TABLE IF NOT EXISTS shadow_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  fact_hash TEXT NOT NULL,
  worker_ok INTEGER NOT NULL DEFAULT 0,
  d1_ok INTEGER NOT NULL DEFAULT 0,
  worker_ms INTEGER,
  d1_ms INTEGER,
  error_source TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shadow_writes_created ON shadow_writes(created_at);
CREATE INDEX IF NOT EXISTS idx_shadow_writes_errors ON shadow_writes(error_source, created_at);

-- ─── Claude Code Session Ingestion ──────────────────────────

CREATE TABLE IF NOT EXISTS cc_sessions (
  id TEXT PRIMARY KEY,
  session_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  commits TEXT,
  files_changed TEXT,
  issues_opened TEXT,
  issues_closed TEXT,
  decisions TEXT,
  repos TEXT,
  duration_minutes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cc_sessions_date ON cc_sessions(session_date);

-- ─── Shadow Mode: Dual-Read Comparison ──────────────────────

CREATE TABLE IF NOT EXISTS shadow_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_site TEXT NOT NULL,
  query_text TEXT,
  worker_count INTEGER NOT NULL DEFAULT 0,
  d1_count INTEGER NOT NULL DEFAULT 0,
  overlap_count INTEGER NOT NULL DEFAULT 0,
  worker_only_count INTEGER NOT NULL DEFAULT 0,
  d1_only_count INTEGER NOT NULL DEFAULT 0,
  rank_drift REAL,
  worker_ms INTEGER,
  d1_ms INTEGER,
  error_source TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shadow_reads_created ON shadow_reads(created_at);
CREATE INDEX IF NOT EXISTS idx_shadow_reads_site ON shadow_reads(call_site, created_at);

-- ─── Claude Code Task Queue ──────────────────────────────────

CREATE TABLE IF NOT EXISTS cc_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  repo TEXT NOT NULL,                            -- target repo path (e.g. aegis-daemon, edgestack-v2)
  prompt TEXT NOT NULL,                          -- mission brief for Claude Code
  completion_signal TEXT,                        -- string to look for in output to confirm success
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 50,          -- 0=highest, 100=lowest
  depends_on TEXT,                               -- task ID this depends on (NULL = no dependency)
  max_turns INTEGER NOT NULL DEFAULT 25,         -- --max-turns for safety
  allowed_tools TEXT,                            -- JSON array of allowed tool patterns (NULL = default set)
  session_id TEXT,                               -- Claude Code session ID once started
  result TEXT,                                   -- output/result summary
  error TEXT,                                    -- error message if failed
  exit_code INTEGER,                             -- process exit code
  preflight_json TEXT,                           -- structured runner-side viability/preflight data
  failure_kind TEXT,                             -- normalized failure classifier for self-improvement
  retryable INTEGER NOT NULL DEFAULT 0,          -- whether the failure is likely transient/retryable
  autopsy_json TEXT,                             -- structured failure autopsy + recommended action
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'operator',   -- who created: operator, aegis, goal:{id}
  authority TEXT NOT NULL DEFAULT 'operator'     -- operator=run immediately, auto_safe=safe category, proposed=needs approval
    CHECK (authority IN ('proposed', 'auto_safe', 'operator')),
  category TEXT NOT NULL DEFAULT 'feature'       -- task type for governance routing
    CHECK (category IN ('docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy')),
  branch TEXT,                                   -- git branch name (auto/{task_id:8})
  pr_url TEXT,                                   -- GitHub PR URL if one was created
  github_issue_repo TEXT,                        -- source issue repo (e.g. 'Stackbilt-dev/aegis')
  github_issue_number INTEGER                    -- source issue number (repo-scoped)
);

CREATE INDEX IF NOT EXISTS idx_cc_tasks_status ON cc_tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_depends ON cc_tasks(depends_on);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_created ON cc_tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_authority ON cc_tasks(authority);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_gh_issue ON cc_tasks(github_issue_repo, github_issue_number);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_failure_kind ON cc_tasks(failure_kind, completed_at);

-- ─── Cognitive Layer ──────────────────────────────────────────

-- Phase 1: Narratives — maintained story arcs across sessions
CREATE TABLE IF NOT EXISTS narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  arc TEXT NOT NULL,                          -- short label: "llc_formation", "oauth_migration"
  arc_hash TEXT NOT NULL DEFAULT '',          -- djb2 hash for dedup
  title TEXT NOT NULL,                        -- human-readable: "LLC formation stuck on bureaucracy"
  summary TEXT NOT NULL,                      -- 2-4 sentence current state
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved', 'stalled', 'abandoned')),
  tension TEXT,                              -- what's unresolved
  last_beat TEXT,                            -- most recent development (1 sentence)
  beat_count INTEGER NOT NULL DEFAULT 1,
  related_topics TEXT NOT NULL DEFAULT '[]', -- JSON array of memory topic strings
  related_goal_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Phase 2: Knowledge Graph — nodes + edges with spreading activation
CREATE TABLE IF NOT EXISTS kg_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL
    CHECK (node_type IN ('concept','project','person','decision','pattern','tool','event',
                         'file','module','function','class','interface','type_alias')),
  description TEXT,
  activation REAL NOT NULL DEFAULT 0.0,
  last_activated_at TEXT,
  memory_ids TEXT NOT NULL DEFAULT '[]',     -- JSON array of memory_entries.id links
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_system TEXT NOT NULL DEFAULT 'cognitive'
    CHECK (source_system IN ('cognitive', 'code', 'manual')),
  source_ref TEXT,                           -- e.g. "aegis-daemon:src/kernel/dispatch.ts:45"
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES kg_nodes(id),
  target_id INTEGER NOT NULL REFERENCES kg_nodes(id),
  relation TEXT NOT NULL,                    -- depends_on, part_of, decided_by, blocks, uses, related_to, caused
  weight REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.7,
  evidence TEXT,
  co_activation_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_system TEXT NOT NULL DEFAULT 'cognitive'
    CHECK (source_system IN ('cognitive', 'code', 'manual'))
);


-- Phase 1: CognitiveState — precomputed warm-boot blob (singleton)
CREATE TABLE IF NOT EXISTS cognitive_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  compute_cost REAL NOT NULL DEFAULT 0,
  compute_ms INTEGER NOT NULL DEFAULT 0
);

-- ─── Cognitive Layer Indexes ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_narratives_status ON narratives(status);
CREATE INDEX IF NOT EXISTS idx_narratives_arc ON narratives(arc);
CREATE INDEX IF NOT EXISTS idx_narratives_updated ON narratives(updated_at);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_label ON kg_nodes(label);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_activation ON kg_nodes(activation);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_source ON kg_nodes(source_system);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_source_ref ON kg_nodes(source_ref);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_edges_relation ON kg_edges(relation);
CREATE INDEX IF NOT EXISTS idx_kg_edges_source_system ON kg_edges(source_system);

-- ─── Tech Posts (consolidated to roundtable-db, kept for reference) ──
-- Posts are now in ROUNDTABLE_DB `posts` table. This table is legacy.

-- ─── Exocortex v2: Memory Blocks ─────────────────────────────

CREATE TABLE IF NOT EXISTS memory_blocks (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL,
  max_bytes  INTEGER NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'operator',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Platform Feedback ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  email TEXT,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'bug', 'feature', 'question')),
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',         -- web, mcp, api
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
