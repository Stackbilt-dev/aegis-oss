// Operator dashboard — server-rendered system health, memory, goals, cost tracking
// Auth-gated via existing bearerAuth middleware

import { getAllProceduresWithDerivedStats, getActiveAgendaItems, getActiveGoals } from './kernel/memory/index.js';
import { getMemoryStats } from './kernel/memory-adapter.js';
import type { MemoryServiceBinding } from './types.js';
import type { ProceduralEntry } from './kernel/types.js';
import { VERSION } from './version.js';

// ─── Data Model ──────────────────────────────────────────────

interface ExecutorStat {
  executor: string;
  count: number;
  totalCost: number;
  avgLatencyMs: number;
}

interface DashboardData {
  version: string;
  timestamp: string;
  procedures: {
    learned: number;
    learning: number;
    degraded: number;
    broken: number;
    total: number;
    top: Array<{
      pattern: string;
      executor: string;
      status: string;
      successRate: number;
      avgCost: number;
      avgLatencyMs: number;
    }>;
  };
  executorStats: ExecutorStat[];
  memory: {
    totalActive: number;
    topics: Array<{ topic: string; count: number }>;
    strengthDist: { low: number; medium: number; high: number };
    recentRecalls: number;
  };
  goals: Array<{
    id: string;
    title: string;
    status: string;
    authority: string;
    runCount: number;
    lastRun: string | null;
    nextRun: string | null;
  }>;
  agenda: Array<{
    id: number;
    item: string;
    priority: string;
    ageDays: number;
    context: string | null;
  }>;
  cost: {
    total24h: number;
    total7d: number;
  };
  recentEpisodes: Array<{
    summary: string;
    executor: string;
    outcome: string;
    cost: number;
    latencyMs: number;
    createdAt: string;
  }>;
  lastHeartbeat: {
    severity: string;
    summary: string;
    createdAt: string;
  } | null;
  tasks: {
    pending: number;
    proposed: number;
    running: number;
    completed24h: number;
    failed24h: number;
    recent: Array<{
      id: string;
      title: string;
      repo: string;
      status: string;
      authority: string;
      category: string;
      exit_code: number | null;
      pr_url: string | null;
      completed_at: string | null;
    }>;
  };
}

// ─── Data Fetching ───────────────────────────────────────────

function parseExecutorFromSummary(summary: string): string {
  const match = summary.match(/ via ([^:]+):/);
  return match ? match[1].trim() : 'unknown';
}

export async function getDashboardData(db: D1Database, memoryBinding?: MemoryServiceBinding): Promise<DashboardData> {
  const [
    procedures,
    agendaItems,
    goals,
    memStats,
    cost24h,
    cost7d,
    episodeRows,
    heartbeatRow,
    taskStatusRows,
    taskCompletedRows,
    taskRecentRows,
  ] = await Promise.all([
    getAllProceduresWithDerivedStats(db, { reader: 'dashboard' }),
    getActiveAgendaItems(db),
    getActiveGoals(db),
    memoryBinding ? getMemoryStats(memoryBinding) : Promise.resolve({ total_active: 0, topics: [], recalled_last_24h: 0, strength_distribution: { low: 0, medium: 0, high: 0 } }),
    db.prepare("SELECT COALESCE(SUM(cost), 0) as total FROM episodic_memory WHERE created_at > datetime('now', '-1 day')").first<{ total: number }>(),
    db.prepare("SELECT COALESCE(SUM(cost), 0) as total FROM episodic_memory WHERE created_at > datetime('now', '-7 days')").first<{ total: number }>(),
    db.prepare("SELECT summary, outcome, cost, latency_ms, created_at FROM episodic_memory ORDER BY created_at DESC LIMIT 20").all<{ summary: string; outcome: string; cost: number; latency_ms: number; created_at: string }>(),
    db.prepare("SELECT severity, summary, created_at FROM heartbeat_results ORDER BY created_at DESC LIMIT 1").first<{ severity: string; summary: string; created_at: string }>(),
    db.prepare("SELECT status, authority, COUNT(*) as c FROM cc_tasks WHERE status IN ('pending', 'running') GROUP BY status, authority").all<{ status: string; authority: string; c: number }>(),
    db.prepare("SELECT status, COUNT(*) as c FROM cc_tasks WHERE completed_at > datetime('now', '-24 hours') GROUP BY status").all<{ status: string; c: number }>(),
    db.prepare("SELECT id, title, repo, status, authority, category, exit_code, pr_url, completed_at FROM cc_tasks ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT 10").all<{ id: string; title: string; repo: string; status: string; authority: string; category: string; exit_code: number | null; pr_url: string | null; completed_at: string | null }>(),
  ]);

  // Build executor stats from episodes
  const execMap = new Map<string, { count: number; totalCost: number; totalLatency: number }>();
  for (const ep of episodeRows.results) {
    const executor = parseExecutorFromSummary(ep.summary);
    const stat = execMap.get(executor) ?? { count: 0, totalCost: 0, totalLatency: 0 };
    stat.count++;
    stat.totalCost += ep.cost;
    stat.totalLatency += ep.latency_ms;
    execMap.set(executor, stat);
  }
  const executorStats: ExecutorStat[] = [...execMap.entries()]
    .map(([executor, s]) => ({ executor, count: s.count, totalCost: s.totalCost, avgLatencyMs: Math.round(s.totalLatency / s.count) }))
    .sort((a, b) => b.count - a.count);

  // Procedure summary
  const procTop = [...procedures]
    .sort((a, b) => (b.success_count + b.fail_count) - (a.success_count + a.fail_count))
    .slice(0, 8)
    .map(p => {
      const total = p.success_count + p.fail_count;
      return {
        pattern: p.task_pattern,
        executor: p.executor,
        status: p.status,
        successRate: total > 0 ? p.success_count / total : 0,
        avgCost: p.avg_cost,
        avgLatencyMs: p.avg_latency_ms,
      };
    });

  const now = Date.now();

  return {
    version: VERSION,
    timestamp: new Date().toISOString(),
    procedures: {
      learned: procedures.filter(p => p.status === 'learned').length,
      learning: procedures.filter(p => p.status === 'learning').length,
      degraded: procedures.filter(p => p.status === 'degraded').length,
      broken: procedures.filter(p => p.status === 'broken').length,
      total: procedures.length,
      top: procTop,
    },
    executorStats,
    memory: {
      totalActive: memStats.total_active,
      topics: memStats.topics,
      strengthDist: memStats.strength_distribution,
      recentRecalls: memStats.recalled_last_24h,
    },
    goals: goals.map(g => ({
      id: g.id,
      title: g.title,
      status: g.status,
      authority: g.authority_level,
      runCount: g.run_count,
      lastRun: g.last_run_at,
      nextRun: g.next_run_at,
    })),
    agenda: agendaItems.map(a => {
      const ts = a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z';
      return {
        id: a.id,
        item: a.item,
        priority: a.priority,
        ageDays: Math.max(0, (now - new Date(ts).getTime()) / 86_400_000),
        context: a.context,
      };
    }),
    cost: {
      total24h: cost24h?.total ?? 0,
      total7d: cost7d?.total ?? 0,
    },
    recentEpisodes: episodeRows.results.map(e => ({
      summary: e.summary,
      executor: parseExecutorFromSummary(e.summary),
      outcome: e.outcome,
      cost: e.cost,
      latencyMs: e.latency_ms,
      createdAt: e.created_at,
    })),
    lastHeartbeat: heartbeatRow ? {
      severity: heartbeatRow.severity,
      summary: heartbeatRow.summary,
      createdAt: heartbeatRow.created_at,
    } : null,
    tasks: {
      pending: taskStatusRows.results.filter(r => r.status === 'pending' && r.authority !== 'proposed').reduce((s, r) => s + r.c, 0),
      proposed: taskStatusRows.results.filter(r => r.authority === 'proposed').reduce((s, r) => s + r.c, 0),
      running: taskStatusRows.results.filter(r => r.status === 'running').reduce((s, r) => s + r.c, 0),
      completed24h: taskCompletedRows.results.find(r => r.status === 'completed')?.c ?? 0,
      failed24h: taskCompletedRows.results.find(r => r.status === 'failed')?.c ?? 0,
      recent: taskRecentRows.results,
    },
  };
}

// ─── HTML Renderer ───────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function priorityColor(p: string): string {
  if (p === 'high') return '#ff6b6b';
  if (p === 'medium') return '#ffd93d';
  return '#555';
}

function executorColor(e: string): string {
  const map: Record<string, string> = {
    groq: '#3dd6c8',
    workers_ai: '#2dd4a0',
    gpt_oss: '#f59e0b',
    composite: '#8b8bff',
    claude: '#6366f1',
    claude_opus: '#4338ca',
  };
  return map[e] ?? '#666';
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    learned: '#2dd4a0',
    learning: '#ffd93d',
    degraded: '#ff6b6b',
    broken: '#ff4444',
    active: '#2dd4a0',
    paused: '#ffd93d',
    completed: '#666',
    failed: '#ff6b6b',
  };
  const color = colors[status] ?? '#666';
  return `<span style="display:inline-block;background:${color}20;color:${color};font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px">${esc(status)}</span>`;
}

export function dashboardPage(data: DashboardData): string {
  // ── System overview metrics
  const sysCards = [
    { label: 'Learned', value: data.procedures.learned, color: '#2dd4a0' },
    { label: 'Learning', value: data.procedures.learning, color: '#ffd93d' },
    { label: 'Degraded', value: data.procedures.degraded, color: '#ff6b6b' },
    { label: 'Broken', value: data.procedures.broken, color: '#ff4444' },
  ];

  // ── Executor bar chart (CSS only)
  const maxCount = Math.max(1, ...data.executorStats.map(e => e.count));
  const execBars = data.executorStats.map(e => {
    const pct = (e.count / maxCount) * 100;
    const color = executorColor(e.executor);
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span style="font-family:'JetBrains Mono',monospace;color:${color}">${esc(e.executor)}</span>
        <span style="color:var(--text-secondary)">${e.count}x &middot; $${e.totalCost.toFixed(4)} &middot; ${e.avgLatencyMs}ms</span>
      </div>
      <div style="height:6px;background:var(--bg-deep);border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;transition:width 0.3s"></div>
      </div>
    </div>`;
  }).join('');

  // ── Memory topic breakdown
  const topicList = data.memory.topics.map(t =>
    `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;border-bottom:1px solid var(--border-subtle)">
      <span style="color:var(--text-primary)">${esc(t.topic)}</span>
      <span style="color:var(--text-secondary);font-family:'JetBrains Mono',monospace">${t.count}</span>
    </div>`
  ).join('');

  // ── Strength distribution bar
  const stTotal = data.memory.strengthDist.low + data.memory.strengthDist.medium + data.memory.strengthDist.high;
  const stBar = stTotal > 0 ? `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:8px">
    <div style="width:${(data.memory.strengthDist.low / stTotal) * 100}%;background:#ff6b6b" title="Low (1)"></div>
    <div style="width:${(data.memory.strengthDist.medium / stTotal) * 100}%;background:#ffd93d" title="Medium (2-4)"></div>
    <div style="width:${(data.memory.strengthDist.high / stTotal) * 100}%;background:#2dd4a0" title="High (5+)"></div>
  </div>
  <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:var(--text-secondary)">
    <span>Low: ${data.memory.strengthDist.low}</span>
    <span>Med: ${data.memory.strengthDist.medium}</span>
    <span>High: ${data.memory.strengthDist.high}</span>
  </div>` : '';

  // ── Goals list
  const goalsList = data.goals.map(g => {
    const lastRun = g.lastRun ? new Date(g.lastRun + (g.lastRun.endsWith('Z') ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never';
    return `<div style="background:var(--bg-deep);border:1px solid var(--border-subtle);border-radius:6px;padding:10px 12px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:13px;color:var(--text-primary);font-weight:500">${esc(g.title)}</span>
        ${statusBadge(g.status)}
      </div>
      <div style="font-size:11px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace">
        ${g.authority} &middot; ${g.runCount} runs &middot; last: ${lastRun}
      </div>
    </div>`;
  }).join('');

  // ── Agenda items
  const agendaList = data.agenda.map(a => {
    const age = a.ageDays < 1 ? `${Math.round(a.ageDays * 24)}h` : `${Math.floor(a.ageDays)}d`;
    const isEscalated = a.context?.includes('[escalated:') ?? false;
    return `<div style="background:var(--bg-deep);border:1px solid var(--border-subtle);border-left:3px solid ${priorityColor(a.priority)};border-radius:6px;padding:8px 12px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
        <span style="font-size:10px;color:var(--text-secondary);font-family:'JetBrains Mono',monospace">#${a.id} &middot; ${esc(a.priority)} &middot; ${age} ago${isEscalated ? ' &middot; <span style="color:#ff6b6b">ESCALATED</span>' : ''}</span>
      </div>
      <span style="font-size:12px;color:var(--text-primary)">${esc(a.item.slice(0, 120))}</span>
    </div>`;
  }).join('');

  // ── Recent episodes
  const episodeList = data.recentEpisodes.slice(0, 10).map(e => {
    const time = e.createdAt.slice(11, 16);
    const color = executorColor(e.executor);
    const outcomeColor = e.outcome === 'success' ? '#2dd4a0' : '#ff6b6b';
    return `<div style="display:flex;gap:8px;padding:4px 0;font-size:11px;border-bottom:1px solid var(--border-subtle);align-items:center">
      <span style="color:var(--text-secondary);font-family:'JetBrains Mono',monospace;min-width:40px">${time}</span>
      <span style="color:${color};font-family:'JetBrains Mono',monospace;min-width:70px">${esc(e.executor)}</span>
      <span style="color:${outcomeColor};min-width:14px">${e.outcome === 'success' ? '+' : '-'}</span>
      <span style="color:var(--text-secondary);font-family:'JetBrains Mono',monospace;min-width:55px">$${e.cost.toFixed(4)}</span>
      <span style="color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.summary.slice(0, 80))}</span>
    </div>`;
  }).join('');

  // ── Heartbeat status
  const hb = data.lastHeartbeat;
  const hbColor = !hb ? '#666' : hb.severity === 'critical' ? '#ff4444' : hb.severity === 'high' ? '#ff6b6b' : hb.severity === 'medium' ? '#ffd93d' : '#2dd4a0';
  const hbLabel = hb ? `${hb.severity.toUpperCase()} — ${hb.createdAt.slice(0, 16)}` : 'No data';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="300">
  <title>AEGIS Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@300;400;500&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-deep: #04040a;
      --bg-surface: #080812;
      --bg-card: #0b0b18;
      --border-subtle: rgba(123, 123, 223, 0.06);
      --border-medium: rgba(123, 123, 223, 0.1);
      --accent: #7b7bdf;
      --accent-glow: #8b8bff;
      --accent-teal: #3dd6c8;
      --text-primary: #c8c8d8;
      --text-secondary: #6a6a80;
      --text-dim: #2e2e3e;
    }
    html { -webkit-font-smoothing: antialiased; }
    body {
      background: var(--bg-deep);
      color: var(--text-primary);
      font-family: 'Instrument Sans', sans-serif;
      padding: 20px;
      min-height: 100vh;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border-medium);
    }
    .header h1 {
      font-family: 'Syne', sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: var(--accent-glow);
      letter-spacing: -0.5px;
    }
    .header .meta {
      font-size: 11px;
      color: var(--text-secondary);
      font-family: 'JetBrains Mono', monospace;
      text-align: right;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 16px;
    }
    .card.full { grid-column: 1 / -1; }
    .card h2 {
      font-family: 'Syne', sans-serif;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
    }
    .stat-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .stat-box {
      flex: 1;
      min-width: 80px;
      background: var(--bg-deep);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 10px 12px;
      text-align: center;
    }
    .stat-box .value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 24px;
      font-weight: 500;
      line-height: 1;
    }
    .stat-box .label {
      font-size: 10px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 4px;
    }
    .cost-row {
      display: flex;
      gap: 16px;
      margin-bottom: 12px;
    }
    .cost-item {
      background: var(--bg-deep);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 10px 16px;
      flex: 1;
    }
    .cost-item .amount {
      font-family: 'JetBrains Mono', monospace;
      font-size: 20px;
      color: var(--accent-teal);
    }
    .cost-item .period {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .nav-links {
      display: flex;
      gap: 12px;
    }
    .nav-links a {
      color: var(--accent);
      text-decoration: none;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
    }
    .nav-links a:hover { color: var(--accent-glow); }
    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
      .card.full { grid-column: 1; }
      body { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>AEGIS Dashboard</h1>
      <div class="nav-links">
        <a href="/chat">Chat</a>
        <a href="/health">Health</a>
        <a href="/">Landing</a>
        <a href="https://stackbilt.dev">EdgeStack</a>
        <a href="https://docs.stackbilt.dev">Docs</a>
      </div>
    </div>
    <div class="meta">
      v${esc(data.version)}<br>
      <span style="color:${hbColor}">${esc(hbLabel)}</span><br>
      ${esc(data.timestamp.slice(0, 19))}
    </div>
  </div>

  <div class="grid">
    <!-- System Overview -->
    <div class="card full">
      <h2>Kernel Procedures</h2>
      <div class="stat-row">
        ${sysCards.map(c => `<div class="stat-box">
          <div class="value" style="color:${c.color}">${c.value}</div>
          <div class="label">${c.label}</div>
        </div>`).join('')}
        <div class="stat-box">
          <div class="value" style="color:var(--text-primary)">${data.procedures.total}</div>
          <div class="label">Total</div>
        </div>
      </div>
    </div>

    <!-- Executor Routing -->
    <div class="card">
      <h2>Executor Routing (Last 20)</h2>
      ${execBars || '<p style="font-size:12px;color:var(--text-secondary)">No episodes yet</p>'}
    </div>

    <!-- Memory Health -->
    <div class="card">
      <h2>Memory Health</h2>
      <div class="stat-row" style="margin-bottom:12px">
        <div class="stat-box">
          <div class="value" style="color:var(--accent-teal)">${data.memory.totalActive}</div>
          <div class="label">Active</div>
        </div>
        <div class="stat-box">
          <div class="value" style="color:var(--accent)">${data.memory.recentRecalls}</div>
          <div class="label">Recalled 24h</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Strength Distribution</div>
      ${stBar}
      <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px">Topics</div>
      ${topicList || '<p style="font-size:12px;color:var(--text-secondary)">No memory entries</p>'}
    </div>

    <!-- Goals -->
    <div class="card">
      <h2>Active Goals (${data.goals.length})</h2>
      ${goalsList || '<p style="font-size:12px;color:var(--text-secondary)">No active goals</p>'}
    </div>

    <!-- Agenda -->
    <div class="card">
      <h2>Agenda (${data.agenda.length})</h2>
      ${agendaList || '<p style="font-size:12px;color:var(--text-secondary)">No active items</p>'}
    </div>

    <!-- Task Queue -->
    <div class="card full">
      <h2>Task Queue</h2>
      <div class="stat-row" style="margin-bottom:12px">
        <div class="stat-box"><div class="value" style="color:#ffd93d">${data.tasks.pending}</div><div class="label">Pending</div></div>
        <div class="stat-box"><div class="value" style="color:#a855f7">${data.tasks.proposed}</div><div class="label">Proposed</div></div>
        <div class="stat-box"><div class="value" style="color:#3dd6c8">${data.tasks.running}</div><div class="label">Running</div></div>
        <div class="stat-box"><div class="value" style="color:#2dd4a0">${data.tasks.completed24h}</div><div class="label">Done 24h</div></div>
        <div class="stat-box"><div class="value" style="color:#ff6b6b">${data.tasks.failed24h}</div><div class="label">Failed 24h</div></div>
      </div>
      ${data.tasks.recent.map(t => {
        const statusColors: Record<string, string> = { completed: '#2dd4a0', failed: '#ff6b6b', running: '#3dd6c8', pending: '#ffd93d', cancelled: '#666' };
        const exitLabel = t.exit_code !== null ? ` · exit ${t.exit_code}` : '';
        return `<div style="display:flex;gap:8px;padding:4px 0;font-size:11px;border-bottom:1px solid var(--border-subtle);align-items:center">
          ${statusBadge(t.status)}
          <span style="color:var(--text-secondary);font-family:'JetBrains Mono',monospace;min-width:50px">${esc(t.repo)}</span>
          <span style="display:inline-block;background:${statusColors[t.status] ?? '#666'}15;color:var(--text-secondary);font-size:9px;padding:1px 4px;border-radius:2px">${esc(t.category)}</span>
          ${t.authority === 'proposed' ? '<span style="color:#a855f7;font-size:9px">[PROPOSED]</span>' : ''}
          <span style="color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>
          ${t.pr_url ? `<a href="${esc(t.pr_url)}" target="_blank" style="color:#3dd6c8;font-size:9px;text-decoration:none" title="View PR">PR</a>` : ''}
          <span style="color:var(--text-secondary);font-family:'JetBrains Mono',monospace;font-size:10px">${exitLabel}</span>
        </div>`;
      }).join('') || '<p style="font-size:12px;color:var(--text-secondary)">No tasks</p>'}
    </div>

    <!-- Cost Tracking -->
    <div class="card full">
      <h2>Cost Tracking</h2>
      <div class="cost-row">
        <div class="cost-item">
          <div class="amount">$${data.cost.total24h.toFixed(4)}</div>
          <div class="period">Last 24 hours</div>
        </div>
        <div class="cost-item">
          <div class="amount">$${data.cost.total7d.toFixed(4)}</div>
          <div class="period">Last 7 days</div>
        </div>
      </div>
    </div>

    <!-- Recent Episodes -->
    <div class="card full">
      <h2>Recent Dispatches</h2>
      ${episodeList || '<p style="font-size:12px;color:var(--text-secondary)">No episodes yet</p>'}
    </div>
  </div>
</body>
</html>`;
}
