// Stub — full implementation not yet extracted to OSS

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { getAllProceduresWithDerivedStats, getActiveAgendaItems } from '../kernel/memory/index.js';
import { detectEntropy } from '../kernel/scheduled/entropy.js';
import { buildEdgeEnv } from '../edge-env.js';

const observability = new Hono<{ Bindings: Env }>();

function boundedDays(value: string | undefined, fallback: number, max: number): number {
  const days = parseInt(value ?? String(fallback), 10);
  return Number.isNaN(days) || days < 1 || days > max ? fallback : days;
}

// ─── Shadow Write Stats ─────────────────────────────────────

observability.get('/api/shadow-stats', async (c) => {
  const days = parseInt(c.req.query('days') ?? '7', 10);

  const summary = await c.env.DB.prepare(
    "SELECT COUNT(*) as total_writes, SUM(CASE WHEN worker_ok THEN 1 ELSE 0 END) as worker_ok, SUM(CASE WHEN d1_ok THEN 1 ELSE 0 END) as d1_ok FROM shadow_writes WHERE created_at > datetime('now', '-' || ? || ' days')"
  ).bind(days).first();

  const errors = await c.env.DB.prepare(
    "SELECT error_source, COUNT(*) as count FROM shadow_write_errors WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY error_source"
  ).bind(days).all();

  const recent = await c.env.DB.prepare(
    "SELECT topic, worker_ok, d1_ok FROM shadow_writes WHERE created_at > datetime('now', '-' || ? || ' days') ORDER BY created_at DESC LIMIT 20"
  ).bind(days).all();

  return c.json({ days, summary, errors: errors.results, recent: recent.results });
});

// ─── Shadow Read Stats ──────────────────────────────────────

observability.get('/api/shadow-read-stats', async (c) => {
  const days = parseInt(c.req.query('days') ?? '7', 10);

  const summary = await c.env.DB.prepare(
    "SELECT COUNT(*) as total_reads, AVG(overlap_ratio) as avg_overlap_ratio FROM shadow_reads WHERE created_at > datetime('now', '-' || ? || ' days')"
  ).bind(days).first();

  const bySite = await c.env.DB.prepare(
    "SELECT call_site, COUNT(*) as reads FROM shadow_reads WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY call_site"
  ).bind(days).all();

  const recent = await c.env.DB.prepare(
    "SELECT call_site, query_text FROM shadow_reads WHERE created_at > datetime('now', '-' || ? || ' days') ORDER BY created_at DESC LIMIT 20"
  ).bind(days).all();

  return c.json({ days, summary, by_site: bySite.results, recent: recent.results });
});

// ─── Entropy ────────────────────────────────────────────────

observability.get('/api/entropy', async (c) => {
  const env = buildEdgeEnv(c.env);
  const report = await detectEntropy(env);
  return c.json(report);
});

// ─── Shadow Read Drift ──────────────────────────────────────

observability.get('/api/shadow-read-drift', async (c) => {
  const days = boundedDays(c.req.query('days'), 7, 30);
  const reader = c.req.query('reader');

  const latestWhere = reader
    ? "WHERE reader = ? AND sampled_at > datetime('now', '-' || ? || ' days')"
    : "WHERE sampled_at > datetime('now', '-' || ? || ' days')";
  const latestBindings = reader ? [reader, days] : [days];
  const windowBindings = reader ? [days, reader] : [days];

  const [distribution, readiness, topDrifters] = await Promise.all([
    c.env.DB.prepare(`
      WITH ranked AS (
        SELECT reader,
          ABS((cached_count - pre_tier_count) - derived_count) AS count_abs_drift,
          ABS(cached_avg_latency_ms - derived_avg_latency_ms) AS latency_abs_drift,
          ABS(cached_avg_cost - derived_avg_cost) AS cost_abs_drift,
          ROW_NUMBER() OVER (PARTITION BY reader ORDER BY ABS((cached_count - pre_tier_count) - derived_count)) AS count_rank,
          ROW_NUMBER() OVER (PARTITION BY reader ORDER BY ABS(cached_avg_latency_ms - derived_avg_latency_ms)) AS latency_rank,
          ROW_NUMBER() OVER (PARTITION BY reader ORDER BY ABS(cached_avg_cost - derived_avg_cost)) AS cost_rank,
          COUNT(*) OVER (PARTITION BY reader) AS n
        FROM shadow_read_drift
        WHERE sampled_at > datetime('now', '-' || ? || ' days')
        ${reader ? 'AND reader = ?' : ''}
      )
      SELECT reader,
        MAX(n) AS samples,
        ROUND(AVG(count_abs_drift), 2) AS avg_abs_count_drift,
        ROUND(MAX(count_abs_drift), 2) AS max_abs_count_drift,
        ROUND(MAX(CASE WHEN count_rank = MAX(1, (n + 1) / 2) THEN count_abs_drift END), 2) AS p50_count_drift,
        ROUND(MAX(CASE WHEN count_rank = MAX(1, (n * 19 + 19) / 20) THEN count_abs_drift END), 2) AS p95_count_drift,
        ROUND(MAX(CASE WHEN count_rank = MAX(1, (n * 99 + 99) / 100) THEN count_abs_drift END), 2) AS p99_count_drift,
        ROUND(AVG(latency_abs_drift), 2) AS avg_latency_drift_ms,
        ROUND(MAX(latency_abs_drift), 2) AS max_latency_drift_ms,
        ROUND(MAX(CASE WHEN latency_rank = MAX(1, (n + 1) / 2) THEN latency_abs_drift END), 2) AS p50_latency_drift_ms,
        ROUND(MAX(CASE WHEN latency_rank = MAX(1, (n * 19 + 19) / 20) THEN latency_abs_drift END), 2) AS p95_latency_drift_ms,
        ROUND(MAX(CASE WHEN latency_rank = MAX(1, (n * 99 + 99) / 100) THEN latency_abs_drift END), 2) AS p99_latency_drift_ms,
        ROUND(AVG(cost_abs_drift), 6) AS avg_cost_drift,
        ROUND(MAX(cost_abs_drift), 6) AS max_cost_drift,
        ROUND(MAX(CASE WHEN cost_rank = MAX(1, (n + 1) / 2) THEN cost_abs_drift END), 6) AS p50_cost_drift,
        ROUND(MAX(CASE WHEN cost_rank = MAX(1, (n * 19 + 19) / 20) THEN cost_abs_drift END), 6) AS p95_cost_drift,
        ROUND(MAX(CASE WHEN cost_rank = MAX(1, (n * 99 + 99) / 100) THEN cost_abs_drift END), 6) AS p99_cost_drift
      FROM ranked
      GROUP BY reader
    `).bind(...windowBindings).all(),

    c.env.DB.prepare(`
      WITH latest AS (
        SELECT reader, task_pattern, cached_count, cached_success_count,
          cached_avg_latency_ms, cached_avg_cost,
          derived_count, derived_success_count,
          derived_avg_latency_ms, derived_avg_cost,
          pre_tier_count,
          ROW_NUMBER() OVER (PARTITION BY reader, task_pattern ORDER BY sampled_at DESC) as rn
        FROM shadow_read_drift
        ${latestWhere}
      )
      SELECT
        COUNT(*) as total_pairs,
        COUNT(DISTINCT task_pattern) as distinct_procedures,
        SUM(CASE WHEN pre_tier_count = 0 THEN 1 ELSE 0 END) as clean_pairs,
        SUM(CASE
          WHEN pre_tier_count = 0
           AND cached_count = derived_count
           AND cached_success_count = derived_success_count
           AND ABS(cached_avg_latency_ms - derived_avg_latency_ms) < 10
           AND ABS(cached_avg_cost - derived_avg_cost) < 0.0001
          THEN 1 ELSE 0 END) as ready_pairs
      FROM latest WHERE rn = 1
    `).bind(...latestBindings).first(),

    c.env.DB.prepare(`
      WITH latest_per_pattern AS (
        SELECT task_pattern, reader,
          cached_count, derived_count, pre_tier_count,
          cached_avg_latency_ms, derived_avg_latency_ms,
          cached_avg_cost, derived_avg_cost,
          sampled_at,
          ROW_NUMBER() OVER (PARTITION BY task_pattern, reader ORDER BY sampled_at DESC) as rn
        FROM shadow_read_drift
        WHERE sampled_at > datetime('now', '-' || ? || ' days')
        ${reader ? 'AND reader = ?' : ''}
      )
      SELECT task_pattern, reader,
        cached_count, derived_count, pre_tier_count,
        ABS((cached_count - pre_tier_count) - derived_count) as count_drift,
        ROUND(ABS(cached_avg_latency_ms - derived_avg_latency_ms), 1) as latency_drift,
        ROUND(ABS(cached_avg_cost - derived_avg_cost), 6) as cost_drift,
        sampled_at
      FROM latest_per_pattern
      WHERE rn = 1
      ORDER BY ABS((cached_count - pre_tier_count) - derived_count) DESC
      LIMIT 15
    `).bind(...windowBindings).all(),
  ]);

  return c.json({
    days,
    reader_filter: reader ?? null,
    distribution: distribution.results,
    readiness,
    top_drifters: topDrifters.results,
  });
});

// ─── Agenda ─────────────────────────────────────────────────

observability.get('/agenda', async (c) => {
  const items = await getActiveAgendaItems(c.env.DB);
  return c.json({ count: items.length, items });
});

// ─── Procedures ─────────────────────────────────────────────

observability.get('/procedures', async (c) => {
  const raw = await getAllProceduresWithDerivedStats(c.env.DB, { reader: 'observability' });

  const procedures = raw.map((p: any) => {
    const total = p.success_count + p.fail_count;
    const successRate = total > 0 ? Math.round((p.success_count / total) * 100) / 100 : 0;

    return {
      pattern: p.task_pattern,
      executor: p.executor,
      status: p.status,
      successes: p.success_count,
      failures: p.fail_count,
      consecutiveFailures: p.consecutive_failures,
      successRate,
      avgLatencyMs: Math.round(p.avg_latency_ms),
      avgCost: Math.round(p.avg_cost * 10000) / 10000,
      lastUsed: p.last_used,
    };
  });

  return c.json({ count: procedures.length, procedures });
});

export { observability };
