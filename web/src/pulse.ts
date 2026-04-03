/**
 * /pulse — Live neural activity feed for AEGIS
 * A real-time window into the system's autonomous operations.
 * Public-facing, no sensitive data exposed.
 */

export interface PulseEvent {
  ts: string;
  type: 'task' | 'heartbeat' | 'goal' | 'memory' | 'cc_task' | 'agenda' | 'reflection' | 'operator';
  icon: string;
  title: string;
  detail: string;
  status: 'ok' | 'warn' | 'error' | 'info' | 'active';
}

export interface PulseData {
  version: string;
  events: PulseEvent[];
  summary: {
    taskRuns24h: number;
    taskErrors24h: number;
    memoriesTotal: number;
    goalsActive: number;
    ccTasksCompleted: number;
    ccTasksPending: number;
    agendaActive: number;
    lastHeartbeat: string | null;
    lastDreaming: string | null;
  };
  kernel: { learned: number; learning: number; degraded: number; broken: number };
}

export async function getPulseData(db: D1Database, version = '0.0.0', memoryBinding?: import('./types.js').MemoryServiceBinding): Promise<PulseData> {
  const events: PulseEvent[] = [];

  // Parallel queries for all data sources
  const [
    taskRuns,
    heartbeats,
    goalActions,
    recentMemories,
    ccTasks,
    agendaChanges,
    reflections,
    operatorLogs,
    taskStats,
    memoryCount,
    goalCount,
    ccStats,
    agendaCount,
    procedures,
  ] = await Promise.all([
    // Recent task runs (last 12h)
    db.prepare(`
      SELECT task_name, status, duration_ms, created_at FROM task_runs
      WHERE created_at > datetime('now', '-12 hours')
      ORDER BY created_at DESC LIMIT 60
    `).all<{ task_name: string; status: string; duration_ms: number; created_at: string }>().catch(() => ({ results: [] })),

    // Recent heartbeats
    db.prepare(`
      SELECT severity, summary, created_at FROM heartbeat_results
      WHERE created_at > datetime('now', '-24 hours')
      ORDER BY created_at DESC LIMIT 10
    `).all<{ severity: string; summary: string; created_at: string }>().catch(() => ({ results: [] })),

    // Recent goal actions
    db.prepare(`
      SELECT a.action_type, a.outcome, a.description, a.created_at, g.title as goal_title
      FROM agent_actions a LEFT JOIN agent_goals g ON a.goal_id = g.id
      WHERE a.created_at > datetime('now', '-24 hours')
      ORDER BY a.created_at DESC LIMIT 20
    `).all<{ action_type: string; outcome: string; description: string; created_at: string; goal_title: string }>().catch(() => ({ results: [] })),

    // Recent memory writes — shadow_writes tracks all write activity (topic + timestamp)
    db.prepare(`
      SELECT topic, 1.0 as confidence, 'memory_worker' as source, created_at FROM shadow_writes
      WHERE created_at > datetime('now', '-24 hours') AND worker_ok = 1
      ORDER BY created_at DESC LIMIT 15
    `).all<{ topic: string; confidence: number; source: string; created_at: string }>().catch(() => ({ results: [] })),

    // Recent cc_tasks activity
    db.prepare(`
      SELECT title, repo, status, category, authority, pr_url, created_at, completed_at FROM cc_tasks
      WHERE created_at > datetime('now', '-48 hours') OR completed_at > datetime('now', '-48 hours')
      ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 15
    `).all<{ title: string; repo: string; status: string; category: string; authority: string; pr_url: string | null; created_at: string; completed_at: string | null }>().catch(() => ({ results: [] })),

    // Recent agenda changes
    db.prepare(`
      SELECT item, priority, status, created_at, resolved_at FROM agent_agenda
      WHERE created_at > datetime('now', '-48 hours') OR resolved_at > datetime('now', '-48 hours')
      ORDER BY COALESCE(resolved_at, created_at) DESC LIMIT 10
    `).all<{ item: string; priority: string; status: string; created_at: string; resolved_at: string | null }>().catch(() => ({ results: [] })),

    // Recent reflections
    db.prepare(`
      SELECT content, memory_count, topics_covered, created_at FROM reflections
      WHERE created_at > datetime('now', '-48 hours')
      ORDER BY created_at DESC LIMIT 5
    `).all<{ content: string; memory_count: number; topics_covered: number; created_at: string }>().catch(() => ({ results: [] })),

    // Recent operator logs
    db.prepare(`
      SELECT episodes_count, goals_run, tasks_completed, tasks_failed, prs_created, created_at FROM operator_log
      WHERE created_at > datetime('now', '-48 hours')
      ORDER BY created_at DESC LIMIT 5
    `).all<{ episodes_count: number; goals_run: number; tasks_completed: number; tasks_failed: number; prs_created: number; created_at: string }>().catch(() => ({ results: [] })),

    // Summary stats
    db.prepare(`
      SELECT COUNT(*) as runs, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
      FROM task_runs WHERE created_at > datetime('now', '-24 hours')
    `).first<{ runs: number; errors: number }>().catch(() => ({ runs: 0, errors: 0 })),

    // Memory count from Memory Worker (sole store)
    memoryBinding
      ? memoryBinding.health().then(h => ({ c: h.active_fragments })).catch(() => ({ c: 0 }))
      : Promise.resolve({ c: 0 }),

    db.prepare("SELECT COUNT(*) as c FROM agent_goals WHERE status = 'active'").first<{ c: number }>().catch(() => ({ c: 0 })),

    db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
      FROM cc_tasks
    `).first<{ completed: number; pending: number }>().catch(() => ({ completed: 0, pending: 0 })),

    db.prepare("SELECT COUNT(*) as c FROM agent_agenda WHERE status = 'active'").first<{ c: number }>().catch(() => ({ c: 0 })),

    db.prepare(`
      SELECT status, COUNT(*) as c FROM procedural_memory GROUP BY status
    `).all<{ status: string; c: number }>().catch(() => ({ results: [] })),
  ]);

  // Build kernel from procedures
  const kernel = { learned: 0, learning: 0, degraded: 0, broken: 0 };
  for (const p of procedures.results) {
    if (p.status in kernel) kernel[p.status as keyof typeof kernel] = p.c;
  }

  // Transform task runs into events
  for (const t of taskRuns.results) {
    events.push({
      ts: t.created_at,
      type: 'task',
      icon: t.status === 'ok' ? '\u2713' : t.status === 'error' ? '\u2717' : '\u2014',
      title: `System task`,
      detail: `${t.status} in ${t.duration_ms}ms`,
      status: t.status === 'ok' ? 'ok' : t.status === 'error' ? 'error' : 'info',
    });
  }

  // Heartbeats
  for (const h of heartbeats.results) {
    const sev = h.severity || 'none';
    events.push({
      ts: h.created_at,
      type: 'heartbeat',
      icon: '\u2665',
      title: `Heartbeat: ${sev}`,
      detail: 'System check complete',
      status: sev === 'none' || sev === 'low' ? 'ok' : sev === 'medium' ? 'warn' : 'error',
    });
  }

  // Goal actions
  for (const g of goalActions.results) {
    events.push({
      ts: g.created_at,
      type: 'goal',
      icon: '\u25C9',
      title: `Goal activity`,
      detail: `${g.action_type} \u2192 ${g.outcome}`,
      status: g.outcome === 'success' ? 'ok' : g.outcome === 'failure' ? 'error' : 'info',
    });
  }

  // Memory writes
  for (const m of recentMemories.results) {
    events.push({
      ts: m.created_at,
      type: 'memory',
      icon: '\u25C6',
      title: `Memory write`,
      detail: `confidence ${(m.confidence * 100).toFixed(0)}%`,
      status: 'info',
    });
  }

  // CC tasks
  for (const t of ccTasks.results) {
    const ts = t.completed_at || t.created_at;
    const statusMap: Record<string, PulseEvent['status']> = {
      completed: 'ok', failed: 'error', running: 'active', pending: 'info', cancelled: 'warn',
    };
    events.push({
      ts,
      type: 'cc_task',
      icon: t.status === 'completed' ? '\u2713' : t.status === 'running' ? '\u25B6' : '\u25CB',
      title: `Pipeline: ${t.category}`,
      detail: `${t.status}${t.pr_url ? ' \u2192 PR' : ''}`,
      status: statusMap[t.status] || 'info',
    });
  }

  // Agenda changes
  for (const a of agendaChanges.results) {
    const ts = a.resolved_at || a.created_at;
    events.push({
      ts,
      type: 'agenda',
      icon: a.status === 'done' ? '\u2611' : a.status === 'dismissed' ? '\u2612' : '\u2610',
      title: `Agenda item`,
      detail: `${a.priority} / ${a.status}`,
      status: a.status === 'done' ? 'ok' : a.status === 'active' ? 'active' : 'info',
    });
  }

  // Reflections
  for (const r of reflections.results) {
    events.push({
      ts: r.created_at,
      type: 'reflection',
      icon: '\u2727',
      title: `Reflection cycle`,
      detail: `${r.memory_count} memories consolidated, ${r.topics_covered} topics covered`,
      status: 'info',
    });
  }

  // Operator logs
  for (const o of operatorLogs.results) {
    events.push({
      ts: o.created_at,
      type: 'operator',
      icon: '\u2318',
      title: `Operator worklog`,
      detail: `${o.episodes_count} episodes, ${o.goals_run} goals, ${o.tasks_completed} tasks, ${o.prs_created} PRs`,
      status: o.tasks_failed > 0 ? 'warn' : 'ok',
    });
  }

  // Sort by timestamp descending
  events.sort((a, b) => b.ts.localeCompare(a.ts));

  // Find last heartbeat and dreaming timestamps
  const lastHeartbeat = taskRuns.results.find(t => t.task_name === 'heartbeat')?.created_at ?? null;
  const lastDreaming = taskRuns.results.find(t => t.task_name === 'dreaming')?.created_at ?? null;

  return {
    version,
    events: events.slice(0, 100), // Cap at 100 events
    summary: {
      taskRuns24h: taskStats?.runs ?? 0,
      taskErrors24h: taskStats?.errors ?? 0,
      memoriesTotal: memoryCount?.c ?? 0,
      goalsActive: goalCount?.c ?? 0,
      ccTasksCompleted: ccStats?.completed ?? 0,
      ccTasksPending: ccStats?.pending ?? 0,
      agendaActive: agendaCount?.c ?? 0,
      lastHeartbeat,
      lastDreaming,
    },
    kernel,
  };
}

export function pulsePage(data: PulseData): string {
  const statusOk = data.summary.taskErrors24h === 0;

  const eventRows = data.events.map((e, i) => {
    const ts = e.ts ? new Date(e.ts.endsWith('Z') ? e.ts : e.ts + 'Z') : new Date();
    const timeStr = ts.toISOString().replace('T', ' ').slice(0, 19);
    const relTime = getRelativeTime(ts);
    const delay = Math.min(i * 30, 1500);
    return `
      <div class="ev ev-${e.status} ev-${e.type}" style="animation-delay:${delay}ms">
        <div class="ev-time">
          <span class="ev-rel">${esc(relTime)}</span>
          <span class="ev-abs">${timeStr}</span>
        </div>
        <div class="ev-icon">${e.icon}</div>
        <div class="ev-body">
          <div class="ev-title">${esc(e.title)}</div>
          <div class="ev-detail">${esc(e.detail)}</div>
        </div>
        <div class="ev-tag ev-tag-${e.type}">${e.type}</div>
      </div>`;
  }).join('');

  const kernelTotal = data.kernel.learned + data.kernel.learning + data.kernel.degraded + data.kernel.broken;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AEGIS Neural Pulse</title>
  <meta name="description" content="Live neural activity feed for AEGIS — watch an autonomous AI agent think, learn, and ship code in real-time.">
  <meta name="theme-color" content="#04040a">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #04040a;
      --bg-card: #080812;
      --bg-hover: #0c0c1a;
      --border: rgba(123, 123, 223, 0.06);
      --border-bright: rgba(123, 123, 223, 0.12);
      --accent: #7b7bdf;
      --accent-glow: #8b8bff;
      --teal: #3dd6c8;
      --green: #2dd4a0;
      --amber: #f5a623;
      --red: #ef4444;
      --text: #c8c8d8;
      --text-sec: #7a7a90;
      --text-dim: #3e3e50;
      --mono: 'JetBrains Mono', monospace;
      --display: 'Syne', sans-serif;
    }

    html { -webkit-font-smoothing: antialiased; scroll-behavior: smooth; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.5;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Noise */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      opacity: 0.018;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 256px 256px;
      pointer-events: none;
      z-index: 1;
    }

    .ambient {
      position: fixed;
      top: -30%;
      left: 50%;
      transform: translateX(-50%);
      width: 120%;
      height: 60%;
      background: radial-gradient(ellipse at center, rgba(61,214,200,0.025) 0%, rgba(123,123,223,0.015) 40%, transparent 70%);
      pointer-events: none;
      z-index: 0;
      animation: breathe 12s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.25; }
    }

    /* Scan line */
    .scan {
      position: fixed;
      left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent 10%, rgba(61,214,200,0.06) 50%, transparent 90%);
      pointer-events: none;
      z-index: 50;
      animation: scan 8s linear infinite;
    }

    @keyframes scan {
      0% { top: -1px; }
      100% { top: 100vh; }
    }

    .wrap {
      position: relative;
      z-index: 2;
      max-width: 1060px;
      margin: 0 auto;
      padding: 1.5rem 1.25rem 4rem;
    }

    /* ── Header ─────────────────────────── */
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 1.25rem;
    }

    .head-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .head-logo {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: linear-gradient(135deg, rgba(61,214,200,0.12), rgba(123,123,223,0.08));
      border: 1px solid rgba(61,214,200,0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--display);
      font-weight: 800;
      font-size: 13px;
      color: var(--teal);
    }

    .head-info h1 {
      font-family: var(--display);
      font-size: 15px;
      font-weight: 800;
      letter-spacing: -0.01em;
    }

    .head-info span {
      font-size: 10px;
      color: var(--text-dim);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .head-right {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .head-ver {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(123,123,223,0.06);
      border: 1px solid var(--border-bright);
      color: var(--accent);
    }

    .head-live {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: var(--green);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .head-live-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 6px rgba(45,212,160,0.6);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.3); }
    }

    /* ── Stats Bar ──────────────────────── */
    .stats {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.75rem;
      text-align: center;
      transition: border-color 0.2s;
    }

    .stat-card:hover { border-color: var(--border-bright); }

    .stat-val {
      font-size: 18px;
      font-weight: 700;
      line-height: 1;
    }

    .stat-val.teal { color: var(--teal); }
    .stat-val.green { color: var(--green); }
    .stat-val.accent { color: var(--accent-glow); }
    .stat-val.amber { color: var(--amber); }

    .stat-lbl {
      font-size: 9px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: 4px;
    }

    /* ── Layout ─────────────────────────── */
    .main {
      display: grid;
      grid-template-columns: 1fr 260px;
      gap: 1rem;
    }

    /* ── Event Feed ─────────────────────── */
    .feed-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }

    .feed-title {
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .feed-count {
      font-size: 10px;
      color: var(--text-dim);
    }

    .feed-filters {
      display: flex;
      gap: 4px;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
    }

    .feed-filter {
      font-family: var(--mono);
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      color: var(--text-dim);
      cursor: pointer;
      transition: all 0.15s;
    }

    .feed-filter:hover, .feed-filter.active {
      border-color: var(--teal);
      color: var(--teal);
      background: rgba(61,214,200,0.06);
    }

    .feed {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .ev {
      display: grid;
      grid-template-columns: 120px 24px 1fr auto;
      align-items: center;
      gap: 0.5rem;
      padding: 6px 10px;
      border-radius: 4px;
      background: transparent;
      transition: background 0.15s;
      opacity: 0;
      animation: fadeIn 0.3s ease forwards;
      border-left: 2px solid transparent;
    }

    @keyframes fadeIn {
      to { opacity: 1; }
    }

    .ev:hover { background: var(--bg-hover); }

    .ev-ok { border-left-color: rgba(45,212,160,0.3); }
    .ev-warn { border-left-color: rgba(245,166,35,0.3); }
    .ev-error { border-left-color: rgba(239,68,68,0.3); }
    .ev-info { border-left-color: rgba(123,123,223,0.2); }
    .ev-active { border-left-color: rgba(61,214,200,0.4); }

    .ev-time {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .ev-rel {
      font-size: 10px;
      color: var(--text-sec);
    }

    .ev-abs {
      font-size: 9px;
      color: var(--text-dim);
    }

    .ev-icon {
      font-size: 12px;
      text-align: center;
      width: 20px;
    }

    .ev-ok .ev-icon { color: var(--green); }
    .ev-warn .ev-icon { color: var(--amber); }
    .ev-error .ev-icon { color: var(--red); }
    .ev-info .ev-icon { color: var(--accent); }
    .ev-active .ev-icon { color: var(--teal); }

    .ev-body {
      min-width: 0;
    }

    .ev-title {
      font-size: 11px;
      font-weight: 500;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ev-detail {
      font-size: 10px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ev-tag {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .ev-tag-task { background: rgba(45,212,160,0.08); color: var(--green); }
    .ev-tag-heartbeat { background: rgba(239,68,68,0.08); color: #f87171; }
    .ev-tag-goal { background: rgba(123,123,223,0.08); color: var(--accent); }
    .ev-tag-memory { background: rgba(61,214,200,0.08); color: var(--teal); }
    .ev-tag-cc_task { background: rgba(245,166,35,0.08); color: var(--amber); }
    .ev-tag-agenda { background: rgba(255,255,255,0.04); color: var(--text-sec); }
    .ev-tag-reflection { background: rgba(168,85,247,0.08); color: #a78bfa; }
    .ev-tag-operator { background: rgba(45,212,160,0.06); color: var(--green); }

    /* ── Sidebar ────────────────────────── */
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .side-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.85rem;
    }

    .side-label {
      font-size: 9px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 0.5rem;
    }

    /* Kernel bar */
    .kern-bar {
      display: flex;
      height: 4px;
      border-radius: 2px;
      overflow: hidden;
      background: rgba(255,255,255,0.02);
      margin-bottom: 0.5rem;
    }

    .kern-bar .seg-l { background: var(--green); }
    .kern-bar .seg-n { background: var(--teal); }
    .kern-bar .seg-d { background: var(--amber); }
    .kern-bar .seg-b { background: var(--red); }

    .kern-legend {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .kern-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
    }

    .kern-row-left {
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--text-dim);
    }

    .kern-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
    }

    .kern-dot.l { background: var(--green); }
    .kern-dot.n { background: var(--teal); }
    .kern-dot.d { background: var(--amber); }
    .kern-dot.b { background: var(--red); }

    .kern-row-val {
      font-weight: 500;
      color: var(--text);
    }

    /* Timeline markers */
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tl-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
    }

    .tl-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--text-dim);
      flex-shrink: 0;
    }

    .tl-dot.active { background: var(--green); box-shadow: 0 0 4px rgba(45,212,160,0.4); }

    .tl-label { color: var(--text-dim); }
    .tl-val { color: var(--text-sec); margin-left: auto; }

    /* ── Footer ─────────────────────────── */
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 1.25rem;
      margin-top: 1.25rem;
      border-top: 1px solid var(--border);
      font-size: 10px;
      color: var(--text-dim);
    }

    .foot a {
      color: var(--text-dim);
      text-decoration: none;
      padding: 3px 8px;
      border-radius: 3px;
      border: 1px solid var(--border);
      transition: all 0.15s;
    }

    .foot a:hover { border-color: var(--accent); color: var(--accent); }

    .foot-links { display: flex; gap: 0.5rem; }

    /* Auto-refresh indicator */
    .refresh-bar {
      position: fixed;
      top: 0;
      left: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--teal), var(--accent));
      z-index: 100;
      animation: refresh-progress 30s linear infinite;
      opacity: 0.6;
    }

    @keyframes refresh-progress {
      0% { width: 0; }
      100% { width: 100%; }
    }

    /* ── Neural Viz ─────────────────────── */
    .pulse-viz {
      position: relative;
      width: 100%;
      height: 180px;
      margin-bottom: 1.25rem;
      border-radius: 6px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      overflow: hidden;
    }

    .pulse-viz canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* ── Responsive ─────────────────────── */
    @media (max-width: 768px) {
      .stats { grid-template-columns: repeat(4, 1fr); }
      .main { grid-template-columns: 1fr; }
      .sidebar { display: grid; grid-template-columns: repeat(2, 1fr); }
      .ev { grid-template-columns: 80px 20px 1fr auto; }
      .ev-abs { display: none; }
    }

    @media (max-width: 480px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      .sidebar { grid-template-columns: 1fr; }
      .ev-tag { display: none; }
    }
  </style>
</head>
<body>
  <div class="ambient"></div>
  <div class="scan"></div>
  <div class="refresh-bar"></div>

  <div class="wrap">
    <header class="head">
      <div class="head-left">
        <div class="head-logo">A</div>
        <div class="head-info">
          <h1>Neural Pulse</h1>
          <span>Autonomous Activity Feed</span>
        </div>
      </div>
      <div class="head-right">
        <span class="head-ver">v${esc(data.version)}</span>
        <div class="head-live">
          <span class="head-live-dot"></span>
          Live
        </div>
      </div>
    </header>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-val green">${data.summary.taskRuns24h}</div>
        <div class="stat-lbl">Tasks 24h</div>
      </div>
      <div class="stat-card">
        <div class="stat-val ${data.summary.taskErrors24h === 0 ? 'green' : 'amber'}">${data.summary.taskErrors24h === 0 ? '0' : data.summary.taskErrors24h}</div>
        <div class="stat-lbl">Errors</div>
      </div>
      <div class="stat-card">
        <div class="stat-val teal">${data.summary.memoriesTotal}</div>
        <div class="stat-lbl">Memories</div>
      </div>
      <div class="stat-card">
        <div class="stat-val accent">${data.summary.goalsActive}</div>
        <div class="stat-lbl">Goals</div>
      </div>
      <div class="stat-card">
        <div class="stat-val green">${data.summary.ccTasksCompleted}</div>
        <div class="stat-lbl">Tasks Done</div>
      </div>
      <div class="stat-card">
        <div class="stat-val amber">${data.summary.ccTasksPending}</div>
        <div class="stat-lbl">Queued</div>
      </div>
      <div class="stat-card">
        <div class="stat-val accent">${data.summary.agendaActive}</div>
        <div class="stat-lbl">Agenda</div>
      </div>
    </div>

    <div class="pulse-viz">
      <canvas id="neural-pulse" data-tasks="${data.summary.taskRuns24h}" data-errors="${data.summary.taskErrors24h}" data-memories="${data.summary.memoriesTotal}" data-goals="${data.summary.goalsActive}" data-learned="${data.kernel.learned}" data-learning="${data.kernel.learning}"></canvas>
    </div>

    <div class="main">
      <div class="feed-col">
        <div class="feed-head">
          <span class="feed-title">Activity Stream</span>
          <span class="feed-count">${data.events.length} events</span>
        </div>
        <div class="feed-filters">
          <button class="feed-filter active" data-type="all">All</button>
          <button class="feed-filter" data-type="task">Tasks</button>
          <button class="feed-filter" data-type="heartbeat">Heartbeat</button>
          <button class="feed-filter" data-type="goal">Goals</button>
          <button class="feed-filter" data-type="memory">Memory</button>
          <button class="feed-filter" data-type="cc_task">Pipeline</button>
          <button class="feed-filter" data-type="reflection">Reflection</button>
        </div>
        <div class="feed" id="feed">
          ${eventRows}
          <div id="feed-empty" style="display:none;padding:2rem;text-align:center;color:var(--text-dim);font-size:11px">No events matching this filter in the current window.</div>
        </div>
      </div>

      <aside class="sidebar">
        <div class="side-card">
          <div class="side-label">Procedural Kernel</div>
          <div class="kern-bar">
            ${kernelTotal > 0 ? `
            <div class="seg-l" style="width:${(data.kernel.learned / kernelTotal * 100).toFixed(1)}%"></div>
            <div class="seg-n" style="width:${(data.kernel.learning / kernelTotal * 100).toFixed(1)}%"></div>
            <div class="seg-d" style="width:${(data.kernel.degraded / kernelTotal * 100).toFixed(1)}%"></div>
            <div class="seg-b" style="width:${(data.kernel.broken / kernelTotal * 100).toFixed(1)}%"></div>
            ` : '<div class="seg-l" style="width:100%"></div>'}
          </div>
          <div class="kern-legend">
            <div class="kern-row"><span class="kern-row-left"><span class="kern-dot l"></span> Learned</span><span class="kern-row-val">${data.kernel.learned}</span></div>
            <div class="kern-row"><span class="kern-row-left"><span class="kern-dot n"></span> Learning</span><span class="kern-row-val">${data.kernel.learning}</span></div>
            <div class="kern-row"><span class="kern-row-left"><span class="kern-dot d"></span> Degraded</span><span class="kern-row-val">${data.kernel.degraded}</span></div>
            <div class="kern-row"><span class="kern-row-left"><span class="kern-dot b"></span> Broken</span><span class="kern-row-val">${data.kernel.broken}</span></div>
          </div>
        </div>

        <div class="side-card">
          <div class="side-label">Last Activity</div>
          <div class="timeline">
            <div class="tl-item">
              <span class="tl-dot ${data.summary.lastHeartbeat ? 'active' : ''}"></span>
              <span class="tl-label">Heartbeat</span>
              <span class="tl-val">${data.summary.lastHeartbeat ? getRelativeTime(new Date((data.summary.lastHeartbeat.endsWith('Z') ? data.summary.lastHeartbeat : data.summary.lastHeartbeat + 'Z'))) : 'n/a'}</span>
            </div>
            <div class="tl-item">
              <span class="tl-dot ${data.summary.lastDreaming ? 'active' : ''}"></span>
              <span class="tl-label">Dreaming</span>
              <span class="tl-val">${data.summary.lastDreaming ? getRelativeTime(new Date((data.summary.lastDreaming.endsWith('Z') ? data.summary.lastDreaming : data.summary.lastDreaming + 'Z'))) : 'n/a'}</span>
            </div>
          </div>
        </div>

        <div class="side-card">
          <div class="side-label">System</div>
          <div class="timeline">
            <div class="tl-item">
              <span class="tl-dot active"></span>
              <span class="tl-label">Mode</span>
              <span class="tl-val">edge-native</span>
            </div>
            <div class="tl-item">
              <span class="tl-dot active"></span>
              <span class="tl-label">Runtime</span>
              <span class="tl-val">CF Workers</span>
            </div>
            <div class="tl-item">
              <span class="tl-dot active"></span>
              <span class="tl-label">Memory</span>
              <span class="tl-val">Vectorize</span>
            </div>
            <div class="tl-item">
              <span class="tl-dot active"></span>
              <span class="tl-label">Refresh</span>
              <span class="tl-val">30s</span>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <footer class="foot">
      <span>AEGIS v${esc(data.version)} &middot; auto-refresh 30s</span>
      <div class="foot-links">
        <a href="/">Landing</a>
        <a href="/health">Health</a>
        <a href="/health?format=json">JSON</a>
      </div>
    </footer>
  </div>

  <script>
    // Restore filter from URL hash
    var activeFilter = location.hash.replace('#', '') || 'all';

    function applyFilter(type) {
      document.querySelectorAll('.feed-filter').forEach(function(b) { b.classList.remove('active'); });
      var target = document.querySelector('.feed-filter[data-type="' + type + '"]');
      if (target) target.classList.add('active');

      var visible = 0;
      document.querySelectorAll('.ev').forEach(function(ev) {
        if (type === 'all' || ev.classList.contains('ev-' + type)) {
          ev.style.display = '';
          visible++;
        } else {
          ev.style.display = 'none';
        }
      });

      // Show empty state
      var empty = document.getElementById('feed-empty');
      if (empty) empty.style.display = visible === 0 ? '' : 'none';
    }

    // Filter buttons
    document.querySelectorAll('.feed-filter').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var type = btn.getAttribute('data-type');
        location.hash = type === 'all' ? '' : type;
        applyFilter(type);
      });
    });

    // Apply saved filter on load
    if (activeFilter !== 'all') applyFilter(activeFilter);

    // Auto-refresh preserving filter (uses hash)
    setTimeout(function() { location.reload(); }, 30000);

    // ── Neural Pulse Visualization ──
    (function() {
      var c = document.getElementById('neural-pulse');
      if (!c || !c.getContext) return;
      var ctx = c.getContext('2d');
      var dpr = window.devicePixelRatio || 1;
      var W, H;

      function resize() {
        var rect = c.parentElement.getBoundingClientRect();
        W = rect.width;
        H = rect.height;
        c.width = W * dpr;
        c.height = H * dpr;
        ctx.scale(dpr, dpr);
      }
      resize();
      window.addEventListener('resize', resize);

      var tasks = parseInt(c.dataset.tasks) || 0;
      var errors = parseInt(c.dataset.errors) || 0;
      var memories = parseInt(c.dataset.memories) || 0;
      var goals = parseInt(c.dataset.goals) || 0;
      var learned = parseInt(c.dataset.learned) || 0;
      var learning = parseInt(c.dataset.learning) || 0;

      // Nodes representing system components
      var nodes = [
        { label: 'KERNEL',   x: 0.5,  y: 0.35, r: 18, color: '#2dd4a0', pulse: learned / Math.max(learned + learning, 1) },
        { label: 'MEMORY',   x: 0.22, y: 0.3,  r: 14, color: '#3dd6c8', pulse: Math.min(memories / 500, 1) },
        { label: 'TASKS',    x: 0.78, y: 0.3,  r: 14, color: '#2dd4a0', pulse: Math.min(tasks / 30, 1) },
        { label: 'GOALS',    x: 0.35, y: 0.7,  r: 12, color: '#7b7bdf', pulse: Math.min(goals / 5, 1) },
        { label: 'PIPELINE', x: 0.65, y: 0.7,  r: 12, color: '#f5a623', pulse: 0.5 },
        { label: 'DREAMING', x: 0.12, y: 0.6,  r: 10, color: '#a78bfa', pulse: 0.6 },
        { label: 'ARGUS',    x: 0.88, y: 0.6,  r: 10, color: '#ef4444', pulse: errors > 0 ? 1 : 0.3 },
        { label: 'DISPATCH', x: 0.5,  y: 0.85, r: 10, color: '#8b8bff', pulse: 0.7 },
      ];

      // Connections between nodes (index pairs)
      var edges = [
        [0,1],[0,2],[0,3],[0,4],[1,3],[1,5],[2,4],[2,6],[3,7],[4,7],[5,3],[6,4]
      ];

      // Particles traveling along edges
      var particles = [];
      for (var i = 0; i < 12; i++) {
        var ei = i % edges.length;
        particles.push({ edge: ei, t: Math.random(), speed: 0.002 + Math.random() * 0.004 });
      }

      var frame = 0;

      function draw() {
        frame++;
        ctx.clearRect(0, 0, W, H);

        // Resolve node positions
        var ns = nodes.map(function(n) {
          return { x: n.x * W, y: n.y * H, r: n.r, color: n.color, pulse: n.pulse, label: n.label };
        });

        // Draw edges
        edges.forEach(function(e) {
          var a = ns[e[0]], b = ns[e[1]];
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = 'rgba(123,123,223,0.07)';
          ctx.lineWidth = 1;
          ctx.stroke();
        });

        // Draw particles
        particles.forEach(function(p) {
          p.t += p.speed;
          if (p.t > 1) { p.t -= 1; p.edge = Math.floor(Math.random() * edges.length); }
          var e = edges[p.edge];
          var a = ns[e[0]], b = ns[e[1]];
          var px = a.x + (b.x - a.x) * p.t;
          var py = a.y + (b.y - a.y) * p.t;
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(61,214,200,0.4)';
          ctx.fill();
        });

        // Draw nodes
        ns.forEach(function(n) {
          var glowSize = n.r + 8 + Math.sin(frame * 0.03 * (0.5 + n.pulse)) * 4 * n.pulse;

          // Outer glow
          var grad = ctx.createRadialGradient(n.x, n.y, n.r * 0.5, n.x, n.y, glowSize);
          grad.addColorStop(0, n.color + '18');
          grad.addColorStop(1, 'transparent');
          ctx.beginPath();
          ctx.arc(n.x, n.y, glowSize, 0, Math.PI * 2);
          ctx.fillStyle = grad;
          ctx.fill();

          // Core
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fillStyle = n.color + '12';
          ctx.strokeStyle = n.color + '40';
          ctx.lineWidth = 1;
          ctx.fill();
          ctx.stroke();

          // Center dot
          ctx.beginPath();
          ctx.arc(n.x, n.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = n.color;
          ctx.fill();

          // Label
          ctx.font = '500 8px "JetBrains Mono", monospace';
          ctx.fillStyle = n.color + '90';
          ctx.textAlign = 'center';
          ctx.fillText(n.label, n.x, n.y + n.r + 12);
        });

        requestAnimationFrame(draw);
      }
      draw();
    })();
  </script>
</body>
</html>`;
}

function getRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
