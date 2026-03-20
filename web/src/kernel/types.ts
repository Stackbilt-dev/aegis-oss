// ─── Channel ─────────────────────────────────────────────────

export type Channel = 'web' | 'cli' | 'internal';

// ─── KernelIntent ────────────────────────────────────────────

export interface KernelIntent {
  source: {
    channel: Channel;
    threadId: string;
  };
  raw: string;
  classified?: string;
  complexity?: number;
  needsTools?: boolean;
  confidence?: number;
  domain?: string;
  domainConfidence?: number;
  timestamp: number;
  costCeiling: 'free' | 'cheap' | 'expensive';
  classifierSource?: 'classify-cast' | 'workers-ai' | 'groq';
}

// ─── Memory Types ────────────────────────────────────────────

export interface EpisodicEntry {
  id?: number;
  intent_class: string;
  channel: string;
  summary: string;
  outcome: 'success' | 'failure';
  cost: number;
  latency_ms: number;
  near_miss?: string | null;
  classifier_confidence?: number;
  reclassified?: boolean;
  thread_id?: string | null;
  executor?: string | null;
  created_at?: string;
}

export type ProceduralStatus = 'learning' | 'learned' | 'degraded' | 'broken';

export interface Refinement {
  timestamp: number;
  what: string;
  why: string;
  impact: 'pending' | 'positive' | 'negative';
}

export interface ProceduralEntry {
  id?: number;
  task_pattern: string;
  executor: string;
  executor_config: string;
  success_count: number;
  fail_count: number;
  avg_latency_ms: number;
  avg_cost: number;
  status: ProceduralStatus;
  consecutive_failures: number;
  refinements: string;
  last_used?: string;
  candidate_executor?: string | null;
  candidate_successes?: number;
  created_at?: string;
}

export interface MemoryEntry {
  id: number;
  topic: string;
  fact: string;
  confidence: number;
  source: string;
  created_at: string;
  valid_until: string | null;
  superseded_by: number | null;
  strength: number;
  last_recalled_at: string | null;
}

// ─── Execution Plan ──────────────────────────────────────────

export type Executor = 'claude' | 'groq' | 'direct' | 'claude_code' | 'workers_ai' | 'claude_opus' | 'gpt_oss' | 'composite' | 'tarotscript';

export interface ExecutionPlan {
  executor: Executor;
  reasoning: string;
  procedureId?: number;
  costCeiling: 'free' | 'cheap' | 'expensive';
}

// ─── Cognitive State ─────────────────────────────────────────

export interface CognitiveState {
  version: number;
  computed_at: string;

  // Phase 1: Active narratives (max 10)
  narratives: Array<{
    arc: string;
    title: string;
    summary: string;
    status: 'active' | 'stalled';
    tension: string | null;
    last_beat: string | null;
    beat_count: number;
  }>;

  // Operational pulse
  open_threads: number;
  proposed_actions: number;

  // Phase 2 (empty until populated)
  activated_nodes: Array<{ label: string; type: string; activation: number }>;
  active_projects: Array<{ project: string; status: string; top_blocker: string | null }>;

  // Product portfolio (populated from BizOps project registry via heartbeat)
  product_portfolio: Array<{ name: string; description: string; model: string; status: string; revenue?: string }>;

  // Phase 3
  latest_metacog: string | null;

  // Stats
  memory_count: number;
  episode_count_24h: number;
  last_heartbeat_severity: string | null;
}

// ─── Dispatch Result ─────────────────────────────────────────

export interface DispatchResult {
  text: string;
  executor: Executor;
  cost: number;
  latency_ms: number;
  procedureHit: boolean;
  classification: string;
  confidence?: number;
  reclassified?: boolean;
  probeResult?: 'agreed' | 'split' | 'escalated';
  meta?: unknown;
}
