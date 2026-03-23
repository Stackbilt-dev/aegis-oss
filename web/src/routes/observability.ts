// Stub — full implementation not yet extracted to OSS

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { getAllProcedures, getActiveAgendaItems } from '../kernel/memory/index.js';

const observability = new Hono<{ Bindings: Env }>();

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

// ─── Agenda ─────────────────────────────────────────────────

observability.get('/agenda', async (c) => {
  const items = await getActiveAgendaItems(c.env.DB);
  return c.json({ count: items.length, items });
});

// ─── Procedures ─────────────────────────────────────────────

observability.get('/procedures', async (c) => {
  const raw = await getAllProcedures(c.env.DB);

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
