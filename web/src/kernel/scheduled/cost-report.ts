import { type EdgeEnv } from '../dispatch.js';

// --- Cost Report ---
// Weekly cost aggregation by executor tier. Runs at 07 UTC on Mondays.
// Stores snapshot in digest_sections for inclusion in the daily digest.
// No LLM calls -- pure D1 queries.

interface ExecutorCost {
  executor: string;
  count: number;
  total_cost: number;
  avg_cost: number;
  avg_latency_ms: number;
}

export async function runCostReport(env: EdgeEnv): Promise<void> {
  // Gate: Monday at 07 UTC
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 7) return;

  // Cooldown: 6 days
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'cost_report'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < 6 * 24 * 60 * 60 * 1000) return;
  }

  // Aggregate costs by executor for the past 7 days
  const byExecutor = await env.db.prepare(`
    SELECT
      COALESCE(executor, 'unknown') as executor,
      COUNT(*) as count,
      ROUND(SUM(cost), 4) as total_cost,
      ROUND(AVG(cost), 4) as avg_cost,
      ROUND(AVG(latency_ms), 0) as avg_latency_ms
    FROM episodic_memory
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY executor
    ORDER BY total_cost DESC
  `).all<ExecutorCost>();

  if (!byExecutor.results?.length) return;

  // Total across all executors
  const totalCost = byExecutor.results.reduce((sum, r) => sum + r.total_cost, 0);
  const totalDispatches = byExecutor.results.reduce((sum, r) => sum + r.count, 0);

  // Top intent classes by cost
  const topIntents = await env.db.prepare(`
    SELECT
      intent_class,
      COUNT(*) as count,
      ROUND(SUM(cost), 4) as total_cost
    FROM episodic_memory
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY intent_class
    ORDER BY total_cost DESC
    LIMIT 5
  `).all<{ intent_class: string; count: number; total_cost: number }>();

  const snapshot = {
    period: '7d',
    generated_at: now.toISOString(),
    total_cost: Math.round(totalCost * 10000) / 10000,
    total_dispatches: totalDispatches,
    by_executor: byExecutor.results,
    top_intents: topIntents.results || [],
  };

  // Store for digest
  await env.db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('cost_report', ?)"
  ).bind(JSON.stringify(snapshot)).run();

  // Update watermark
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('cost_report', datetime('now'))"
  ).run();

  console.log(`[cost-report] Weekly: $${totalCost.toFixed(4)} across ${totalDispatches} dispatches, ${byExecutor.results.length} executors`);
}
