// Cognitive Self-Measurement (#255)
// Computes whether AEGIS is getting smarter by aggregating existing data.
// Runs daily. Stores a snapshot to D1 for trend analysis.
// No LLM calls — pure D1 queries.

import { type EdgeEnv } from '../dispatch.js';

// ─── Metrics Schema ──────────────────────────────────────────

export interface CognitiveSnapshot {
  // Dispatch quality
  dispatch_success_rate_7d: number;      // % success in last 7 days
  dispatch_success_rate_prior_7d: number; // % success in prior 7 days (for delta)
  dispatch_volume_7d: number;
  avg_cost_7d: number;
  avg_cost_prior_7d: number;
  avg_latency_ms_7d: number;
  avg_latency_ms_prior_7d: number;
  reclassification_rate_7d: number;      // % of dispatches that got reclassified

  // Procedural learning
  procedures_learned: number;
  procedures_learning: number;
  procedures_degraded: number;
  procedures_broken: number;
  procedure_convergence_rate: number;     // learned / total

  // Task execution
  tasks_completed_7d: number;
  tasks_failed_7d: number;
  task_success_rate_7d: number;
  task_success_rate_prior_7d: number;
  top_failure_kind: string | null;

  // Scheduled task health
  scheduled_task_error_rate_24h: number;

  // Classifier source breakdown (classify-cast monitoring)
  classify_cast_rate_48h: number;       // % of dispatches using classify-cast
  user_correction_rate_48h: number;     // % of dispatches followed by user_correction
  classify_cast_correction_rate_48h: number; // user_correction rate specifically for classify-cast episodes

  // Memory growth
  memory_count: number;
  memory_count_prior: number;             // from last snapshot

  // Composite score (0-100)
  cognitive_score: number;
  score_delta: number;                    // vs last snapshot

  computed_at: string;
}

// ─── Queries ─────────────────────────────────────────────────

async function queryDispatchMetrics(db: D1Database): Promise<{
  success_rate_7d: number;
  success_rate_prior_7d: number;
  volume_7d: number;
  avg_cost_7d: number;
  avg_cost_prior_7d: number;
  avg_latency_7d: number;
  avg_latency_prior_7d: number;
  reclassification_rate_7d: number;
}> {
  const [current, prior, reclass] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
             AVG(cost) as avg_cost,
             AVG(latency_ms) as avg_latency
      FROM episodic_memory
      WHERE created_at > datetime('now', '-7 days')
    `).first<{ total: number; successes: number; avg_cost: number; avg_latency: number }>(),

    db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
             AVG(cost) as avg_cost,
             AVG(latency_ms) as avg_latency
      FROM episodic_memory
      WHERE created_at > datetime('now', '-14 days')
        AND created_at <= datetime('now', '-7 days')
    `).first<{ total: number; successes: number; avg_cost: number; avg_latency: number }>(),

    db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN reclassified = 1 THEN 1 ELSE 0 END) as reclassified
      FROM episodic_memory
      WHERE created_at > datetime('now', '-7 days')
    `).first<{ total: number; reclassified: number }>(),
  ]);

  const curTotal = current?.total ?? 0;
  const priorTotal = prior?.total ?? 0;

  return {
    success_rate_7d: curTotal > 0 ? (current?.successes ?? 0) / curTotal : 1,
    success_rate_prior_7d: priorTotal > 0 ? (prior?.successes ?? 0) / priorTotal : 1,
    volume_7d: curTotal,
    avg_cost_7d: current?.avg_cost ?? 0,
    avg_cost_prior_7d: prior?.avg_cost ?? 0,
    avg_latency_7d: current?.avg_latency ?? 0,
    avg_latency_prior_7d: prior?.avg_latency ?? 0,
    reclassification_rate_7d: (reclass?.total ?? 0) > 0
      ? (reclass?.reclassified ?? 0) / (reclass?.total ?? 1)
      : 0,
  };
}

async function queryProceduralMetrics(db: D1Database): Promise<{
  learned: number;
  learning: number;
  degraded: number;
  broken: number;
  convergence_rate: number;
}> {
  const result = await db.prepare(`
    SELECT status, COUNT(*) as count
    FROM procedural_memory
    GROUP BY status
  `).all<{ status: string; count: number }>();

  const counts: Record<string, number> = {};
  for (const row of result.results) {
    counts[row.status] = row.count;
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    learned: counts['learned'] ?? 0,
    learning: counts['learning'] ?? 0,
    degraded: counts['degraded'] ?? 0,
    broken: counts['broken'] ?? 0,
    convergence_rate: total > 0 ? (counts['learned'] ?? 0) / total : 0,
  };
}

async function queryTaskMetrics(db: D1Database): Promise<{
  completed_7d: number;
  failed_7d: number;
  success_rate_7d: number;
  success_rate_prior_7d: number;
  top_failure_kind: string | null;
}> {
  const [current, prior, failures] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM cc_tasks
      WHERE completed_at > datetime('now', '-7 days')
    `).first<{ total: number; completed: number; failed: number }>(),

    db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM cc_tasks
      WHERE completed_at > datetime('now', '-14 days')
        AND completed_at <= datetime('now', '-7 days')
    `).first<{ total: number; completed: number }>(),

    db.prepare(`
      SELECT failure_kind, COUNT(*) as cnt
      FROM cc_tasks
      WHERE status = 'failed' AND completed_at > datetime('now', '-7 days')
        AND failure_kind IS NOT NULL
      GROUP BY failure_kind
      ORDER BY cnt DESC
      LIMIT 1
    `).first<{ failure_kind: string; cnt: number }>(),
  ]);

  const curTotal = (current?.completed ?? 0) + (current?.failed ?? 0);
  const priorTotal = prior?.total ?? 0;

  return {
    completed_7d: current?.completed ?? 0,
    failed_7d: current?.failed ?? 0,
    success_rate_7d: curTotal > 0 ? (current?.completed ?? 0) / curTotal : 1,
    success_rate_prior_7d: priorTotal > 0 ? (prior?.completed ?? 0) / priorTotal : 1,
    top_failure_kind: failures?.failure_kind ?? null,
  };
}

async function queryScheduledTaskHealth(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM task_runs
    WHERE created_at > datetime('now', '-24 hours')
  `).first<{ total: number; errors: number }>();

  const total = result?.total ?? 0;
  return total > 0 ? (result?.errors ?? 0) / total : 0;
}

async function queryClassifierMetrics(db: D1Database): Promise<{
  classify_cast_rate: number;
  user_correction_rate: number;
  classify_cast_correction_rate: number;
}> {
  const [totals, corrections] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN summary LIKE '%[clf:classify-cast]%' THEN 1 ELSE 0 END) as classify_cast,
             SUM(CASE WHEN intent_class = 'user_correction' THEN 1 ELSE 0 END) as user_corrections
      FROM episodic_memory
      WHERE created_at > datetime('now', '-48 hours')
        AND channel != 'internal'
    `).first<{ total: number; classify_cast: number; user_corrections: number }>(),

    // Count user_corrections that follow a classify-cast episode in the same thread
    db.prepare(`
      SELECT COUNT(DISTINCT e2.id) as cc_corrections
      FROM episodic_memory e2
      INNER JOIN episodic_memory e1
        ON e1.thread_id = e2.thread_id
        AND e1.created_at < e2.created_at
      WHERE e2.intent_class = 'user_correction'
        AND e1.summary LIKE '%[clf:classify-cast]%'
        AND e2.created_at > datetime('now', '-48 hours')
    `).first<{ cc_corrections: number }>(),
  ]);

  const total = totals?.total ?? 0;
  const ccTotal = totals?.classify_cast ?? 0;

  return {
    classify_cast_rate: total > 0 ? ccTotal / total : 0,
    user_correction_rate: total > 0 ? (totals?.user_corrections ?? 0) / total : 0,
    classify_cast_correction_rate: ccTotal > 0 ? (corrections?.cc_corrections ?? 0) / ccTotal : 0,
  };
}

async function queryMemoryCount(db: D1Database): Promise<number> {
  const result = await db.prepare(
    "SELECT COUNT(*) as cnt FROM memory_entries WHERE valid_until IS NULL"
  ).first<{ cnt: number }>();
  return result?.cnt ?? 0;
}

// ─── Composite Score ─────────────────────────────────────────
// Weighted average of key health indicators, 0-100 scale.

function computeScore(snapshot: Omit<CognitiveSnapshot, 'cognitive_score' | 'score_delta' | 'computed_at'>): number {
  const weights = {
    dispatch_success: 25,    // most important — is the kernel routing correctly?
    procedure_convergence: 20, // is learning working?
    task_success: 20,        // is autonomous work succeeding?
    cost_efficiency: 15,     // is cost trending down?
    routing_stability: 10,   // low reclassification = stable routing
    scheduled_health: 10,    // are cron tasks healthy?
  };

  const scores = {
    dispatch_success: snapshot.dispatch_success_rate_7d * 100,
    procedure_convergence: snapshot.procedure_convergence_rate * 100,
    task_success: snapshot.task_success_rate_7d * 100,
    cost_efficiency: snapshot.avg_cost_prior_7d > 0
      ? Math.min(100, (1 - (snapshot.avg_cost_7d - snapshot.avg_cost_prior_7d) / snapshot.avg_cost_prior_7d) * 50 + 50)
      : 50, // neutral if no prior data
    routing_stability: (1 - snapshot.reclassification_rate_7d) * 100,
    scheduled_health: (1 - snapshot.scheduled_task_error_rate_24h) * 100,
  };

  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    weighted += (scores[key as keyof typeof scores] ?? 50) * weight;
    totalWeight += weight;
  }

  return Math.round(Math.max(0, Math.min(100, weighted / totalWeight)));
}

// ─── Storage ─────────────────────────────────────────────────

// Store snapshots in digest_sections for the Co-Founder Brief
async function storeSnapshot(db: D1Database, snapshot: CognitiveSnapshot): Promise<void> {
  const payload = JSON.stringify({
    type: 'cognitive_metrics',
    ...snapshot,
  });
  await db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('cognitive_metrics', ?)"
  ).bind(payload).run();
}

async function getLastScore(db: D1Database): Promise<{ score: number; memory_count: number } | null> {
  const row = await db.prepare(
    "SELECT payload FROM digest_sections WHERE section = 'cognitive_metrics' ORDER BY created_at DESC LIMIT 1"
  ).first<{ payload: string }>();

  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload);
    return { score: parsed.cognitive_score ?? 50, memory_count: parsed.memory_count ?? 0 };
  } catch { return null; }
}

// ─── Main ────────────────────────────────────────────────────

export async function runCognitiveMetrics(env: EdgeEnv): Promise<void> {
  // Daily gate — run once per day at 11 UTC (before the 12 UTC digest)
  const hour = new Date().getUTCHours();
  if (hour !== 11) return;

  // Cooldown: 22 hours
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'cognitive_metrics'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < 22 * 60 * 60 * 1000) return;
  }

  // Gather all metrics in parallel
  const [dispatch, procedural, tasks, scheduledHealth, memoryCount, lastSnapshot, classifier] = await Promise.all([
    queryDispatchMetrics(env.db),
    queryProceduralMetrics(env.db),
    queryTaskMetrics(env.db),
    queryScheduledTaskHealth(env.db),
    queryMemoryCount(env.db),
    getLastScore(env.db),
    queryClassifierMetrics(env.db),
  ]);

  const partial = {
    dispatch_success_rate_7d: dispatch.success_rate_7d,
    dispatch_success_rate_prior_7d: dispatch.success_rate_prior_7d,
    dispatch_volume_7d: dispatch.volume_7d,
    avg_cost_7d: dispatch.avg_cost_7d,
    avg_cost_prior_7d: dispatch.avg_cost_prior_7d,
    avg_latency_ms_7d: dispatch.avg_latency_7d,
    avg_latency_ms_prior_7d: dispatch.avg_latency_prior_7d,
    reclassification_rate_7d: dispatch.reclassification_rate_7d,
    procedures_learned: procedural.learned,
    procedures_learning: procedural.learning,
    procedures_degraded: procedural.degraded,
    procedures_broken: procedural.broken,
    procedure_convergence_rate: procedural.convergence_rate,
    tasks_completed_7d: tasks.completed_7d,
    tasks_failed_7d: tasks.failed_7d,
    task_success_rate_7d: tasks.success_rate_7d,
    task_success_rate_prior_7d: tasks.success_rate_prior_7d,
    top_failure_kind: tasks.top_failure_kind,
    scheduled_task_error_rate_24h: scheduledHealth,
    classify_cast_rate_48h: classifier.classify_cast_rate,
    user_correction_rate_48h: classifier.user_correction_rate,
    classify_cast_correction_rate_48h: classifier.classify_cast_correction_rate,
    memory_count: memoryCount,
    memory_count_prior: lastSnapshot?.memory_count ?? memoryCount,
  };

  const score = computeScore(partial);
  const scoreDelta = score - (lastSnapshot?.score ?? score);

  const snapshot: CognitiveSnapshot = {
    ...partial,
    cognitive_score: score,
    score_delta: scoreDelta,
    computed_at: new Date().toISOString(),
  };

  await storeSnapshot(env.db, snapshot);

  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('cognitive_metrics', datetime('now'))"
  ).run();

  const arrow = scoreDelta > 0 ? '+' : scoreDelta < 0 ? '' : '=';
  console.log(`[cognitive-metrics] Score: ${score}/100 (${arrow}${scoreDelta}) | dispatch: ${Math.round(dispatch.success_rate_7d * 100)}% | procedures: ${procedural.learned}/${procedural.learned + procedural.learning} learned | tasks: ${tasks.completed_7d}/${tasks.completed_7d + tasks.failed_7d}`);
  console.log(`[cognitive-metrics] classifier: classify-cast=${Math.round(classifier.classify_cast_rate * 100)}% | correction_rate=${Math.round(classifier.user_correction_rate * 100)}% | cc_correction_rate=${Math.round(classifier.classify_cast_correction_rate * 100)}%`);
}
