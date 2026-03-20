import { Hono } from 'hono';
import type { Env } from '../types.js';
import { getAllProcedures } from '../kernel/memory/index.js';
import { VERSION } from '../version.js';
import { healthPage, type HealthData } from '../health-page.js';

export const health = new Hono<{ Bindings: Env }>();

health.get('/health', async (c) => {
  const procedures = await getAllProcedures(c.env.DB);

  // Last 24h task run stats
  const taskStats = await c.env.DB.prepare(`
    SELECT task_name,
      COUNT(*) as runs,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
      MAX(created_at) as last_run
    FROM task_runs
    WHERE created_at > datetime('now', '-24 hours')
    GROUP BY task_name
    ORDER BY errors DESC, task_name
  `).all<{ task_name: string; runs: number; ok: number; errors: number; last_run: string }>().catch(() => ({ results: [] }));

  const kernel = {
    learned: procedures.filter(p => p.status === 'learned').length,
    learning: procedures.filter(p => p.status === 'learning').length,
    degraded: procedures.filter(p => p.status === 'degraded').length,
    broken: procedures.filter(p => p.status === 'broken').length,
  };

  // Docs sync staleness watermark
  const lastDocSync = await c.env.DB.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_docs_sync_at'"
  ).first<{ received_at: string }>().catch(() => null);
  const docsSyncAgeMs = lastDocSync ? Date.now() - new Date(lastDocSync.received_at + 'Z').getTime() : null;
  const docsSyncAgeHours = docsSyncAgeMs != null ? Math.round(docsSyncAgeMs / 3_600_000) : null;
  const docsSyncStatus = {
    lastSyncAge: docsSyncAgeHours,
    status: (docsSyncAgeHours == null || docsSyncAgeHours > 168 ? 'alert' : docsSyncAgeHours > 48 ? 'warn' : 'ok') as 'ok' | 'warn' | 'alert',
  };

  // JSON response for programmatic consumers (?format=json, explicit Accept, curl)
  const accept = c.req.header('accept') ?? '';
  const wantsJson = c.req.query('format') === 'json'
    || (accept.includes('application/json') && !accept.includes('text/html'));

  if (wantsJson) {
    return c.json({
      status: 'ok',
      service: 'aegis-web',
      version: VERSION,
      mode: 'edge-native',
      timestamp: new Date().toISOString(),
      kernel,
      tasks_24h: taskStats.results,
      docs_sync_status: docsSyncStatus,
    });
  }

  // Gather extra stats for the HTML dashboard (non-sensitive counts only)
  const [memoryRow, agendaRow, goalRow, uptimeRow] = await Promise.all([
    // Memory count from Memory Worker (sole knowledge store)
    c.env.MEMORY
      ? c.env.MEMORY.health().then(h => ({ c: h.active_fragments })).catch(() => ({ c: 0 }))
      : Promise.resolve({ c: 0 }),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM agent_agenda WHERE status = 'active'").first<{ c: number }>().catch(() => ({ c: 0 })),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM agent_goals WHERE status = 'active'").first<{ c: number }>().catch(() => ({ c: 0 })),
    c.env.DB.prepare("SELECT MIN(created_at) as first_run FROM task_runs").first<{ first_run: string | null }>().catch(() => ({ first_run: null })),
  ]);

  const uptimeHours = uptimeRow?.first_run
    ? Math.round((Date.now() - new Date(uptimeRow.first_run + 'Z').getTime()) / 3_600_000)
    : 0;

  const healthData: HealthData = {
    version: VERSION,
    kernel,
    tasks: taskStats.results,
    memoryCount: memoryRow?.c ?? 0,
    agendaCount: agendaRow?.c ?? 0,
    goalCount: goalRow?.c ?? 0,
    uptimeHours,
    docsSyncStatus,
  };

  return c.html(healthPage(healthData));
});
