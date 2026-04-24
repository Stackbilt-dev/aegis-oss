import type { ProceduralEntry, ProceduralStatus, Refinement } from '../types.js';
import {
  getEpisodeStatsByComplexity,
  getAllEpisodeStatsByComplexity,
  type EpisodeStatsAggregate,
} from './episodic.js';

// ─── Constants ──────────────────────────────────────────────

export const PROCEDURE_MIN_SUCCESSES = 3;
export const PROCEDURE_MIN_SUCCESS_RATE = 0.7;
const CIRCUIT_BREAKER_THRESHOLD = 2;
const PROCEDURE_STALENESS_DAYS = 14;
const UTILITY_MIN_INVOCATIONS = 5;
const UTILITY_MIN_SUCCESS_RATE = 0.5;
const CANDIDATE_PROMOTION_THRESHOLD = 3; // consecutive successes to promote candidate

// ─── Procedure Key Helpers ──────────────────────────────────

export function complexityTier(complexity: number | undefined): string {
  const c = complexity ?? 2;
  if (c <= 1) return 'low';
  if (c >= 3) return 'high';
  return 'mid';
}

export function procedureKey(classification: string, complexity: number | undefined): string {
  return `${classification}:${complexityTier(complexity)}`;
}

// ─── Procedural Memory ──────────────────────────────────────

export async function getProcedure(db: D1Database, taskPattern: string): Promise<ProceduralEntry | null> {
  const row = await db.prepare(
    'SELECT * FROM procedural_memory WHERE task_pattern = ?'
  ).bind(taskPattern).first<ProceduralEntry>();
  return row ?? null;
}

export async function getAllProcedures(db: D1Database): Promise<ProceduralEntry[]> {
  const result = await db.prepare(
    'SELECT * FROM procedural_memory ORDER BY last_used DESC'
  ).all();
  return result.results as unknown as ProceduralEntry[];
}

// aegis#564 — compat helper for callers that read the five cached
// aggregate columns (success_count, fail_count, avg_latency_ms, avg_cost,
// last_used). Phased migration:
//   Phase 1: pass-through to getProcedure. Established the API.
//   Phase 2 (here): opt-in shadow-read logging against
//     getEpisodeStatsByComplexity. Still returns cached so behavior is
//     identical; shadow_read_drift captures cached-vs-derived gaps so
//     the Phase 3 cached-column drop is data-driven.
//   Phase 3: flip to derived values and drop the cached columns from
//     procedural_memory in the same move.
//
// Drift-log opts are opt-in per caller. Omitting opts entirely = pure
// pass-through. Pass `{ reader: '...' }` (default sample 1.0) for cold
// paths; `{ reader: '...', sample: 0.1 }` for hot paths.
export interface DriftLogOpts {
  /** Label for shadow_read_drift.reader — router / dashboard / ... */
  reader: string;
  /** Sample rate in [0, 1]. Default 1.0. Omit `opts` entirely to skip logging. */
  sample?: number;
}

export async function getProcedureWithDerivedStats(
  db: D1Database,
  taskPattern: string,
  opts?: DriftLogOpts,
): Promise<ProceduralEntry | null> {
  const row = await getProcedure(db, taskPattern);
  if (!row) return null;

  if (opts && Math.random() < (opts.sample ?? 1.0)) {
    // Drift log failure must never break the read. Awaited + try/catch so
    // observability is synchronous for tests and ordered for ctx.waitUntil.
    try {
      await logDriftSingle(db, row, opts.reader);
    } catch (err) {
      console.warn('[shadow-read] drift log failed (non-fatal):',
        err instanceof Error ? err.message : String(err));
    }
  }

  return row;
}

export async function getAllProceduresWithDerivedStats(
  db: D1Database,
  opts?: DriftLogOpts,
): Promise<ProceduralEntry[]> {
  const procedures = await getAllProcedures(db);

  if (opts && Math.random() < (opts.sample ?? 1.0)) {
    try {
      await logDriftBulk(db, procedures, opts.reader);
    } catch (err) {
      console.warn('[shadow-read] bulk drift log failed (non-fatal):',
        err instanceof Error ? err.message : String(err));
    }
  }

  return procedures;
}

// ─── Shadow-read drift logging (Phase 2) ────────────────────────

function reconstructDerivedFields(
  stats: EpisodeStatsAggregate['derived'][string] | undefined,
): {
  count: number;
  successCount: number;
  failCount: number;
  avgLatency: number;
  avgCost: number;
  lastUsed: string | null;
} {
  if (!stats) {
    return { count: 0, successCount: 0, failCount: 0, avgLatency: 0, avgCost: 0, lastUsed: null };
  }
  return {
    count: stats.count,
    successCount: stats.successCount,
    failCount: stats.failCount,
    avgLatency: stats.avgLatency,
    avgCost: stats.avgCost,
    lastUsed: stats.lastUsed,
  };
}

function parseProcedureKey(taskPattern: string): { intentClass: string; tier: string } | null {
  const idx = taskPattern.lastIndexOf(':');
  if (idx === -1) return null;
  return {
    intentClass: taskPattern.slice(0, idx),
    tier: taskPattern.slice(idx + 1),
  };
}

async function logDriftSingle(
  db: D1Database,
  cached: ProceduralEntry,
  reader: string,
): Promise<void> {
  const parsed = parseProcedureKey(cached.task_pattern);
  if (!parsed) return; // legacy non-conforming key — skip rather than pollute the log

  const derivedStats = await getEpisodeStatsByComplexity(db, parsed.intentClass, parsed.tier);
  const preTierRow = await db.prepare(
    `SELECT COUNT(*) as c FROM episodic_memory
     WHERE intent_class = ? AND complexity_tier IS NULL`
  ).bind(parsed.intentClass).first<{ c: number }>();

  // Use exact successCount from SUM(CASE ...) rather than reconstructing
  // via Math.round(count * rate). Float rounding on ugly rates would
  // break strict-equality drift checks.
  const derived = derivedStats
    ? {
        count: derivedStats.count,
        successCount: derivedStats.successCount,
        failCount: derivedStats.count - derivedStats.successCount,
        avgLatency: derivedStats.avgLatency,
        avgCost: derivedStats.avgCost,
        lastUsed: derivedStats.lastUsed,
      }
    : reconstructDerivedFields(undefined);

  await db.prepare(
    `INSERT INTO shadow_read_drift (
      reader, task_pattern,
      cached_count, cached_success_count, cached_fail_count,
      cached_avg_latency_ms, cached_avg_cost, cached_last_used,
      derived_count, derived_success_count, derived_fail_count,
      derived_avg_latency_ms, derived_avg_cost, derived_last_used,
      pre_tier_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reader, cached.task_pattern,
    cached.success_count + cached.fail_count,
    cached.success_count,
    cached.fail_count,
    cached.avg_latency_ms,
    cached.avg_cost,
    cached.last_used ?? null,
    derived.count,
    derived.successCount,
    derived.failCount,
    derived.avgLatency,
    derived.avgCost,
    derived.lastUsed,
    preTierRow?.c ?? 0,
  ).run();
}

async function logDriftBulk(
  db: D1Database,
  procedures: ProceduralEntry[],
  reader: string,
): Promise<void> {
  if (procedures.length === 0) return;

  const aggregate = await getAllEpisodeStatsByComplexity(db);

  const stmt = db.prepare(
    `INSERT INTO shadow_read_drift (
      reader, task_pattern,
      cached_count, cached_success_count, cached_fail_count,
      cached_avg_latency_ms, cached_avg_cost, cached_last_used,
      derived_count, derived_success_count, derived_fail_count,
      derived_avg_latency_ms, derived_avg_cost, derived_last_used,
      pre_tier_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const batch: D1PreparedStatement[] = [];
  for (const cached of procedures) {
    const parsed = parseProcedureKey(cached.task_pattern);
    if (!parsed) continue;
    const classStats = aggregate.get(parsed.intentClass);
    const derived = reconstructDerivedFields(classStats?.derived[parsed.tier]);
    const preTierCount = classStats?.preTierCount ?? 0;

    batch.push(stmt.bind(
      reader, cached.task_pattern,
      cached.success_count + cached.fail_count,
      cached.success_count,
      cached.fail_count,
      cached.avg_latency_ms,
      cached.avg_cost,
      cached.last_used ?? null,
      derived.count,
      derived.successCount,
      derived.failCount,
      derived.avgLatency,
      derived.avgCost,
      derived.lastUsed,
      preTierCount,
    ));
  }

  // D1 caps batch size (~100 statements in practice). Chunk so a large
  // procedural_memory table doesn't trip the cap and get swallowed by
  // the non-fatal catch upstream, silently blinding the drift dashboard.
  const BATCH = 100;
  for (let i = 0; i < batch.length; i += BATCH) {
    await db.batch(batch.slice(i, i + BATCH));
  }
}

export async function findNearMiss(db: D1Database, classification: string): Promise<string | null> {
  const prefix = classification.split('_')[0];
  if (!prefix) return null;

  const row = await db.prepare(
    "SELECT task_pattern FROM procedural_memory WHERE task_pattern != ? AND task_pattern LIKE ? || '_%' ORDER BY success_count DESC LIMIT 1"
  ).bind(classification, prefix).first<{ task_pattern: string }>();

  return row?.task_pattern ?? null;
}

function computeStatus(successCount: number, failCount: number, currentStatus: ProceduralStatus): ProceduralStatus {
  if (currentStatus === 'broken') return 'broken';

  const total = successCount + failCount;
  const rate = total > 0 ? successCount / total : 0;

  if (successCount >= PROCEDURE_MIN_SUCCESSES && rate >= PROCEDURE_MIN_SUCCESS_RATE) {
    return currentStatus === 'degraded' ? 'degraded' : 'learned';
  }
  return currentStatus === 'degraded' ? 'degraded' : 'learning';
}

export async function upsertProcedure(
  db: D1Database,
  taskPattern: string,
  executor: string,
  executorConfig: string,
  outcome: 'success' | 'failure' | 'partial_failure',
  latencyMs: number,
  cost: number,
): Promise<void> {
  const existing = await getProcedure(db, taskPattern);
  const succInc = outcome === 'success' ? 1 : 0;
  const failInc = outcome !== 'success' ? 1 : 0;

  if (!existing) {
    // First time seeing this pattern — only record executor if it succeeded
    await db.prepare(`
      INSERT INTO procedural_memory (task_pattern, executor, executor_config, success_count, fail_count, avg_latency_ms, avg_cost, status, consecutive_failures, refinements, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'learning', 0, '[]', datetime('now'))
    `).bind(
      taskPattern,
      outcome === 'success' ? executor : 'pending',
      outcome === 'success' ? executorConfig : '{}',
      succInc, failInc, latencyMs, cost,
    ).run();
    return;
  }

  const newSuccesses = existing.success_count + succInc;
  const newFailures = existing.fail_count + failInc;
  const total = existing.success_count + existing.fail_count;
  const newAvgLatency = total > 0
    ? (existing.avg_latency_ms * total + latencyMs) / (total + 1)
    : latencyMs;
  const newAvgCost = total > 0
    ? (existing.avg_cost * total + cost) / (total + 1)
    : cost;

  const newConsecFailures = outcome !== 'success'
    ? existing.consecutive_failures + 1
    : 0;

  let newStatus = existing.status;
  if (outcome === 'success' && existing.status === 'degraded') {
    newStatus = 'learned';
  } else if (newConsecFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    newStatus = newStatus === 'broken' ? 'broken' : 'degraded';
  } else {
    newStatus = computeStatus(newSuccesses, newFailures, existing.status);
  }

  // ─── Probation system ─────────────────────────────────────
  // If the executor being used differs from the learned one, treat it as a
  // candidate. Only promote after CANDIDATE_PROMOTION_THRESHOLD consecutive
  // successes. If it fails, discard the candidate entirely.
  const isSameExecutor = executor === existing.executor;
  let candidateExecutor = existing.candidate_executor ?? null;
  let candidateSuccesses = existing.candidate_successes ?? 0;
  let newExecutor = existing.executor;
  let newConfig = existing.executor_config;

  if (isSameExecutor) {
    // Using the trusted executor — update normally on success
    if (outcome === 'success') {
      newExecutor = executor;
      newConfig = executorConfig;
    }
    // Clear any candidate since we reverted to trusted
    candidateExecutor = null;
    candidateSuccesses = 0;
  } else {
    // Using a different executor — probation logic
    if (outcome === 'success') {
      if (candidateExecutor === executor) {
        candidateSuccesses += 1;
      } else {
        // New candidate, start probation
        candidateExecutor = executor;
        candidateSuccesses = 1;
      }

      // Promote candidate after threshold
      if (candidateSuccesses >= CANDIDATE_PROMOTION_THRESHOLD) {
        console.log(`[procedures] Promoting candidate "${executor}" for ${taskPattern} (${candidateSuccesses} consecutive successes)`);
        newExecutor = executor;
        newConfig = executorConfig;
        candidateExecutor = null;
        candidateSuccesses = 0;
      }
    } else {
      // Candidate failed — discard it, keep trusted executor
      if (candidateExecutor === executor) {
        console.log(`[procedures] Discarding candidate "${executor}" for ${taskPattern} (failed during probation)`);
        candidateExecutor = null;
        candidateSuccesses = 0;
      }
      // Do NOT update newExecutor — the trusted one stays
    }
  }

  await db.prepare(`
    UPDATE procedural_memory SET
      executor = ?, executor_config = ?,
      success_count = ?, fail_count = ?,
      avg_latency_ms = ?, avg_cost = ?,
      status = ?, consecutive_failures = ?,
      candidate_executor = ?, candidate_successes = ?,
      last_used = datetime('now')
    WHERE task_pattern = ?
  `).bind(
    newExecutor, newConfig,
    newSuccesses, newFailures,
    newAvgLatency, newAvgCost,
    newStatus, newConsecFailures,
    candidateExecutor, candidateSuccesses,
    taskPattern,
  ).run();
}

export async function addRefinement(db: D1Database, taskPattern: string, refinement: Refinement): Promise<void> {
  const procedure = await getProcedure(db, taskPattern);
  if (!procedure) return;

  const refinements: Refinement[] = JSON.parse(procedure.refinements);
  refinements.push(refinement);
  const trimmed = refinements.slice(-10);

  await db.prepare(
    'UPDATE procedural_memory SET refinements = ? WHERE task_pattern = ?'
  ).bind(JSON.stringify(trimmed), taskPattern).run();
}

/** Degrade a procedure retroactively (called by implicit feedback) */
export async function degradeProcedure(db: D1Database, taskPattern: string, executor: string): Promise<void> {
  const procedure = await getProcedure(db, taskPattern);
  if (!procedure) return;

  const newFailures = procedure.fail_count + 1;
  const newConsecFailures = procedure.consecutive_failures + 1;
  const newStatus = newConsecFailures >= CIRCUIT_BREAKER_THRESHOLD ? 'degraded' : procedure.status;

  await db.prepare(`
    UPDATE procedural_memory SET
      fail_count = ?, consecutive_failures = ?, status = ?,
      last_used = datetime('now')
    WHERE task_pattern = ?
  `).bind(newFailures, newConsecFailures, newStatus, taskPattern).run();

  await addRefinement(db, taskPattern, {
    timestamp: Date.now(),
    what: `Implicit feedback: user corrected ${executor} response`,
    why: 'User correction detected — retroactive semantic failure',
    impact: 'negative',
  });

  console.log(`[procedures] Retrograde degradation: ${taskPattern} (${executor}) → status=${newStatus}, consec_failures=${newConsecFailures}`);
}

// ─── Procedural Maintenance ─────────────────────────────────

// Reset stale learned procedures to learning — forces re-validation
// after long periods of inactivity (executor landscape may have changed)
export async function maintainProcedures(db: D1Database): Promise<void> {
  const staleThreshold = `-${PROCEDURE_STALENESS_DAYS} days`;
  const stale = await db.prepare(
    "SELECT task_pattern FROM procedural_memory WHERE status = 'learned' AND last_used < datetime('now', ?)"
  ).bind(staleThreshold).all<{ task_pattern: string }>();

  for (const { task_pattern } of stale.results) {
    await db.prepare(
      "UPDATE procedural_memory SET status = 'learning' WHERE task_pattern = ?"
    ).bind(task_pattern).run();
    console.log(`[procedures] Stale procedure reset: ${task_pattern} (unused ${PROCEDURE_STALENESS_DAYS}+ days)`);
  }

  // Utility-rate pruning (#53) — degrade procedures with poor success rates after sufficient invocations
  const lowUtility = await db.prepare(
    `SELECT task_pattern, success_count, fail_count
     FROM procedural_memory
     WHERE status IN ('learned', 'learning')
       AND (success_count + fail_count) >= ?
       AND CAST(success_count AS REAL) / (success_count + fail_count) < ?`
  ).bind(UTILITY_MIN_INVOCATIONS, UTILITY_MIN_SUCCESS_RATE).all<{
    task_pattern: string; success_count: number; fail_count: number;
  }>();

  for (const proc of lowUtility.results) {
    await db.prepare(
      "UPDATE procedural_memory SET status = 'degraded' WHERE task_pattern = ?"
    ).bind(proc.task_pattern).run();
    const rate = proc.success_count / (proc.success_count + proc.fail_count);
    console.log(`[procedures] Utility-pruned: ${proc.task_pattern} (${(rate * 100).toFixed(0)}% success over ${proc.success_count + proc.fail_count} invocations)`);
  }
}
