// ─── AEGIS-OSS Scheduled Task Orchestrator ────────────────────
// Runs on hourly cron (0 * * * *). Tasks are phased by cost:
// Phase 1: Free (D1 + GitHub API only)
// Phase 2: Cheap (1-4 LLM subrequests)
// Phase 3: Heavy (mutually exclusive, stay under 50 subrequest limit)

import { type EdgeEnv } from '../dispatch.js';
import { operatorConfig } from '../../operator/index.js';
import { runHeartbeat } from './heartbeat.js';
import { runMemoryConsolidation } from './consolidation.js';
import { runGoalLoop } from './goals.js';
import { runAgendaEscalation } from './escalation.js';
import { runMemoryReflectionCycle, runOperatorLogCycle } from './reflection.js';
import { runCuriosityCycle } from './curiosity.js';
import { runDreamingCycle } from './dreaming.js';
import { runCognitiveMetrics } from './cognitive-metrics.js';

async function recordTaskRun(
  db: D1Database,
  taskName: string,
  status: 'ok' | 'error' | 'skipped',
  durationMs: number,
  errorMessage?: string,
): Promise<void> {
  try {
    await db.prepare(
      'INSERT INTO task_runs (task_name, status, duration_ms, error_message) VALUES (?, ?, ?, ?)'
    ).bind(taskName, status, durationMs, errorMessage ?? null).run();
  } catch {
    // Don't let observability failures break the scheduler
  }
}

async function runTask(
  env: EdgeEnv,
  name: string,
  fn: (env: EdgeEnv) => Promise<void>,
): Promise<void> {
  const start = Date.now();
  try {
    await fn(env);
    await recordTaskRun(env.db, name, 'ok', Date.now() - start);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduled] ${name} failed:`, msg);
    await recordTaskRun(env.db, name, 'error', Date.now() - start, msg);
  }
}

export async function runScheduledTasks(env: EdgeEnv): Promise<void> {
  // Phase 1: Free — D1 only, 0 subrequests
  let staleHighItems: import('./escalation.js').StaleHighItem[] = [];
  {
    const start = Date.now();
    try {
      staleHighItems = await runAgendaEscalation(env);
      await recordTaskRun(env.db, 'escalation', 'ok', Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduled] escalation failed:`, msg);
      await recordTaskRun(env.db, 'escalation', 'error', Date.now() - start, msg);
    }
  }
  await runTask(env, 'cognitive-metrics', runCognitiveMetrics);

  // Phase 2: Cheap — 1-4 subrequests
  await runTask(env, 'consolidation', runMemoryConsolidation);
  await runTask(env, 'heartbeat', (e) => runHeartbeat(e, staleHighItems));

  // Phase 3: Heavy — mutually exclusive to stay under 50 subrequest limit
  const hour = new Date().getUTCHours();
  const isGoalHour = hour % 6 !== 0;

  if (isGoalHour) {
    await runTask(env, 'goals', runGoalLoop);
  }

  // Introspection — time-guarded, won't fire most hours
  await runTask(env, 'reflection', runMemoryReflectionCycle);
  await runTask(env, 'operator-log', runOperatorLogCycle);

  // Curiosity — daily, non-goal hours
  if (!isGoalHour) {
    await runTask(env, 'curiosity', runCuriosityCycle);
  }

  // Dreaming cycle — daily async reflection
  // Self-gated (checks last_dreaming_at watermark, runs once per ~24h)
  await runTask(env, 'dreaming', runDreamingCycle);
}
