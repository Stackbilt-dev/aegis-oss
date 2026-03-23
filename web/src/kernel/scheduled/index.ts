import { type EdgeEnv } from '../dispatch.js';
import { type ImgForgeConfig } from '../../content/index.js';
import { operatorConfig } from '../../operator/index.js';
import { runHeartbeat } from './heartbeat.js';
import { runMemoryConsolidation } from './consolidation.js';
import { runSelfImprovementAnalysis, runSelfImprovementHousekeeping, runInfraComplianceCheck } from './self-improvement.js';
import { runGoalLoop } from './goals.js';
import { runRoundtableContentGeneration, runDispatchContentGeneration, runColumnContentGeneration } from './content.js';
import { runAgendaEscalation } from './escalation.js';
import { runMemoryReflectionCycle, runOperatorLogCycle } from './reflection.js';
import { runCuriosityCycle } from './curiosity.js';
import { runDreamingCycle } from './dreaming.js';
import { runProductHealthSweep } from './product-health.js';
import { runIssueWatcher } from './issue-watcher.js';
import { runCiWatcher } from './ci-watcher.js';
import { runDailyDigest } from './digest.js';
import { runArgusNotifications } from './argus-notify.js';
import { runArgusHeartbeat } from './argus-heartbeat.js';
import { runCognitiveMetrics } from './cognitive-metrics.js';
import { runArgusAnalytics } from './argus-analytics.js';
import { runPrAutomerge } from './pr-automerge.js';
import { runFeedWatcher } from './feed-watcher.js';
import { runCostReport } from './cost-report.js';
import { runBoardSync } from './board-sync.js';
import { runContentDrip } from './content-drip.js';

export function buildImgForgeConfig(env: EdgeEnv): ImgForgeConfig | undefined {
  if (!env.imgForgeFetcher || !env.imgForgeSbSecret || !operatorConfig.integrations.imgForge.enabled) {
    return undefined;
  }
  return {
    fetcher: env.imgForgeFetcher,
    sbSecret: env.imgForgeSbSecret,
    baseUrl: operatorConfig.integrations.imgForge.baseUrl,
  };
}

// ─── Task Runner Infrastructure ─────────────────────────────

type TaskKind = 'heartbeat' | 'cron';

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
  kind: TaskKind,
  fn: (env: EdgeEnv) => Promise<void>,
): Promise<void> {
  const start = Date.now();
  try {
    await fn(env);
    await recordTaskRun(env.db, name, 'ok', Date.now() - start);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${kind}] ${name} failed:`, msg);
    await recordTaskRun(env.db, name, 'error', Date.now() - start, msg);
  }
}

// ─── Heartbeat Phase ────────────────────────────────────────
// Runs every hour, never skipped. Cheap operations that share
// context and maintain system awareness. These are the pulse.

async function runHeartbeatPhase(env: EdgeEnv): Promise<void> {
  // Escalation runs first: bumps stale priorities, returns stale items for heartbeat
  let staleHighItems: import('./escalation.js').StaleHighItem[] = [];
  {
    const start = Date.now();
    try {
      staleHighItems = await runAgendaEscalation(env);
      await recordTaskRun(env.db, 'escalation', 'ok', Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[heartbeat] escalation failed:', msg);
      await recordTaskRun(env.db, 'escalation', 'error', Date.now() - start, msg);
    }
  }

  // Awareness — lightweight monitors, always run
  await runTask(env, 'ci-watcher', 'heartbeat', runCiWatcher);
  await runTask(env, 'argus-notify', 'heartbeat', runArgusNotifications);
  await runTask(env, 'argus-heartbeat', 'heartbeat', runArgusHeartbeat);
  await runTask(env, 'cognitive-metrics', 'heartbeat', runCognitiveMetrics);
  await runTask(env, 'pr-automerge', 'heartbeat', runPrAutomerge);

  // Memory maintenance
  await runTask(env, 'consolidation', 'heartbeat', runMemoryConsolidation);
  await runTask(env, 'heartbeat', 'heartbeat', (e) => runHeartbeat(e, staleHighItems));
  await runTask(env, 'product-health', 'heartbeat', runProductHealthSweep);

  // Housekeeping — outcomes, task patterns, CRIX
  await runTask(env, 'self-improvement-housekeeping', 'heartbeat', runSelfImprovementHousekeeping);
}

// ─── Cron Phase ─────────────────────────────────────────────
// Time-gated, isolated tasks. Each has its own frequency and
// internal time gate. These are the scheduled work.

async function runCronPhase(env: EdgeEnv): Promise<void> {
  const hour = new Date().getUTCHours();

  // 2-hourly: issue watcher + board sync
  if (hour % 2 === 0) {
    await runTask(env, 'issue-watcher', 'cron', runIssueWatcher);
    await runTask(env, 'board-sync', 'cron', runBoardSync);
  }

  // Analytics + feeds + cost (internally time-gated)
  await runTask(env, 'argus-analytics', 'cron', runArgusAnalytics);
  await runTask(env, 'feed-watcher', 'cron', runFeedWatcher);
  await runTask(env, 'cost-report', 'cron', runCostReport);

  // Heavy tasks — mutually exclusive to stay under 50 subrequest limit
  const isSelfImprovementHour = hour % 6 === 0;

  if (isSelfImprovementHour) {
    await runTask(env, 'self-improvement', 'cron', runSelfImprovementAnalysis);
  } else {
    await runTask(env, 'goals', 'cron', runGoalLoop);
  }

  // Daily infra compliance + docs drift (runs at 05 UTC)
  await runTask(env, 'infra-compliance', 'cron', runInfraComplianceCheck);

  // Content drip — publish scheduled social posts
  await runTask(env, 'content-drip', 'cron', runContentDrip);

  // Content generation — time-guarded, won't fire most hours
  await runTask(env, 'roundtable', 'cron', runRoundtableContentGeneration);
  await runTask(env, 'dispatch', 'cron', runDispatchContentGeneration);
  await runTask(env, 'column', 'cron', runColumnContentGeneration);

  // Introspection
  await runTask(env, 'reflection', 'cron', runMemoryReflectionCycle);
  await runTask(env, 'operator-log', 'cron', runOperatorLogCycle);
  await runTask(env, 'daily-digest', 'cron', runDailyDigest);

  // Curiosity — daily, non-self-improvement hours only
  if (!isSelfImprovementHour) {
    await runTask(env, 'curiosity', 'cron', runCuriosityCycle);
  }

  // Dreaming — daily async reflection (self-gated via watermark)
  await runTask(env, 'dreaming', 'cron', runDreamingCycle);
}

// ─── Main Entry Point ───────────────────────────────────────

export async function runScheduledTasks(env: EdgeEnv): Promise<void> {
  // Heartbeat first — cheap, always runs, maintains awareness
  await runHeartbeatPhase(env);

  // Cron second — time-gated, isolated, may be heavy
  await runCronPhase(env);
}
