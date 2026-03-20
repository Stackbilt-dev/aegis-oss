/**
 * Health status page — visual system dashboard at /health
 * Returns HTML when Accept header prefers it, JSON otherwise.
 * Designed to look impressive without leaking sensitive info.
 */

export interface HealthData {
  version: string;
  kernel: { learned: number; learning: number; degraded: number; broken: number };
  tasks: Array<{ task_name: string; runs: number; ok: number; errors: number; last_run: string }>;
  memoryCount: number;
  agendaCount: number;
  goalCount: number;
  uptimeHours: number;
  docsSyncStatus?: { lastSyncAge: number | null; status: 'ok' | 'warn' | 'alert' };
}

export function healthPage(data: HealthData): string {
  const totalRuns = data.tasks.reduce((s, t) => s + t.runs, 0);
  const totalErrors = data.tasks.reduce((s, t) => s + t.errors, 0);
  const successRate = totalRuns > 0 ? ((totalRuns - totalErrors) / totalRuns * 100).toFixed(1) : '100.0';
  const kernelTotal = data.kernel.learned + data.kernel.learning + data.kernel.degraded + data.kernel.broken;
  const healthScore = kernelTotal > 0
    ? Math.round((data.kernel.learned / kernelTotal) * 100)
    : 100;

  const statusClass = totalErrors === 0 ? 'nominal' : totalErrors <= 2 ? 'degraded' : 'alert';
  const statusText = totalErrors === 0 ? 'ALL SYSTEMS NOMINAL' : totalErrors <= 2 ? 'MINOR DEGRADATION' : 'ATTENTION REQUIRED';

  const taskRows = data.tasks.map(t => {
    const status = t.errors === 0 ? 'ok' : 'err';
    const lastRun = t.last_run ? new Date(t.last_run + 'Z').toISOString().replace('T', ' ').slice(0, 19) : '—';
    return `
      <tr class="task-row ${status}">
        <td class="task-status"><span class="dot dot-${status}"></span></td>
        <td class="task-name">${esc(t.task_name)}</td>
        <td class="task-runs">${t.runs}</td>
        <td class="task-ok">${t.ok}</td>
        <td class="task-err">${t.errors}</td>
        <td class="task-last">${lastRun}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AEGIS — System Health</title>
  <meta name="description" content="Live system health dashboard for AEGIS, a persistent autonomous AI agent running on Cloudflare's edge.">
  <meta name="theme-color" content="#04040a">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #04040a;
      --bg-card: #080812;
      --border: rgba(123, 123, 223, 0.08);
      --border-bright: rgba(123, 123, 223, 0.15);
      --accent: #7b7bdf;
      --accent-glow: #8b8bff;
      --teal: #3dd6c8;
      --green: #2dd4a0;
      --amber: #f5a623;
      --red: #ef4444;
      --text: #c8c8d8;
      --text-dim: #5a5a70;
      --text-muted: #2e2e3e;
      --mono: 'JetBrains Mono', monospace;
      --display: 'Syne', sans-serif;
    }

    html { -webkit-font-smoothing: antialiased; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.6;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Noise overlay */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      opacity: 0.02;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 256px 256px;
      pointer-events: none;
      z-index: 1;
    }

    /* Ambient glow */
    .ambient {
      position: fixed;
      top: -40%;
      left: 50%;
      transform: translateX(-50%);
      width: 140%;
      height: 70%;
      background: radial-gradient(ellipse at center, rgba(123,123,223,0.04) 0%, transparent 65%);
      pointer-events: none;
      z-index: 0;
      animation: breathe 10s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* Scan line */
    .scan {
      position: fixed;
      left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent 5%, rgba(123,123,223,0.06) 50%, transparent 95%);
      pointer-events: none;
      z-index: 50;
      animation: scan-move 6s linear infinite;
    }

    @keyframes scan-move {
      0% { top: -1px; }
      100% { top: 100vh; }
    }

    .wrap {
      position: relative;
      z-index: 2;
      max-width: 960px;
      margin: 0 auto;
      padding: 2rem 1.5rem 4rem;
    }

    /* ── Header ──────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 2rem;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo-mark {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(123,123,223,0.15), rgba(61,214,200,0.1));
      border: 1px solid var(--border-bright);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--display);
      font-weight: 800;
      font-size: 14px;
      color: var(--accent-glow);
    }

    .header-title {
      display: flex;
      flex-direction: column;
    }

    .header-title h1 {
      font-family: var(--display);
      font-size: 18px;
      font-weight: 800;
      color: var(--text);
      letter-spacing: -0.02em;
    }

    .header-title span {
      font-size: 11px;
      color: var(--text-dim);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .version-tag {
      font-size: 11px;
      padding: 0.25rem 0.65rem;
      border-radius: 4px;
      background: rgba(123,123,223,0.08);
      border: 1px solid var(--border-bright);
      color: var(--accent);
      font-weight: 500;
    }

    /* ── Status Banner ───────────────────── */
    .status-banner {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.85rem 1.25rem;
      border-radius: 8px;
      margin-bottom: 2rem;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .status-banner.nominal {
      background: rgba(45, 212, 160, 0.06);
      border: 1px solid rgba(45, 212, 160, 0.15);
      color: var(--green);
    }

    .status-banner.degraded {
      background: rgba(245, 166, 35, 0.06);
      border: 1px solid rgba(245, 166, 35, 0.15);
      color: var(--amber);
    }

    .status-banner.alert {
      background: rgba(239, 68, 68, 0.06);
      border: 1px solid rgba(239, 68, 68, 0.15);
      color: var(--red);
    }

    .status-pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }

    .nominal .status-pulse { background: var(--green); box-shadow: 0 0 8px rgba(45,212,160,0.5); }
    .degraded .status-pulse { background: var(--amber); box-shadow: 0 0 8px rgba(245,166,35,0.5); }
    .alert .status-pulse { background: var(--red); box-shadow: 0 0 8px rgba(239,68,68,0.5); }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }

    /* ── Metrics Grid ────────────────────── */
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .metric {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      transition: border-color 0.2s;
    }

    .metric:hover {
      border-color: var(--border-bright);
    }

    .metric-label {
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 0.5rem;
    }

    .metric-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--accent-glow);
      line-height: 1;
    }

    .metric-value.teal { color: var(--teal); }
    .metric-value.green { color: var(--green); }
    .metric-value.amber { color: var(--amber); }
    .metric-value.red { color: var(--red); }

    .metric-sub {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 0.35rem;
    }

    /* ── Kernel Bar ──────────────────────── */
    .kernel-section {
      margin-bottom: 2rem;
    }

    .section-label {
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.75rem;
    }

    .kernel-bar-wrap {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
    }

    .kernel-bar {
      display: flex;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 0.75rem;
      background: rgba(255,255,255,0.02);
    }

    .kernel-bar .seg-learned { background: var(--green); }
    .kernel-bar .seg-learning { background: var(--teal); }
    .kernel-bar .seg-degraded { background: var(--amber); }
    .kernel-bar .seg-broken { background: var(--red); }

    .kernel-legend {
      display: flex;
      gap: 1.5rem;
      flex-wrap: wrap;
    }

    .kernel-legend-item {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 11px;
      color: var(--text-dim);
    }

    .legend-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .legend-dot.learned { background: var(--green); }
    .legend-dot.learning { background: var(--teal); }
    .legend-dot.degraded { background: var(--amber); }
    .legend-dot.broken { background: var(--red); }

    .kernel-legend-item strong {
      color: var(--text);
      font-weight: 500;
    }

    /* ── Task Table ──────────────────────── */
    .task-section {
      margin-bottom: 2rem;
    }

    .task-table-wrap {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      font-size: 10px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      text-align: left;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      font-weight: 400;
    }

    thead th:nth-child(n+3) { text-align: right; }

    .task-row td {
      padding: 0.6rem 1rem;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      font-size: 12px;
    }

    .task-row:last-child td { border-bottom: none; }

    .task-row:hover { background: rgba(123,123,223,0.03); }

    .task-status { width: 24px; }
    .dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }
    .dot-ok { background: var(--green); box-shadow: 0 0 4px rgba(45,212,160,0.4); }
    .dot-err { background: var(--red); box-shadow: 0 0 4px rgba(239,68,68,0.4); }

    .task-name { color: var(--text); font-weight: 500; }
    .task-runs, .task-ok, .task-err, .task-last { text-align: right; color: var(--text-dim); }
    .task-row.err .task-err { color: var(--red); font-weight: 500; }
    .task-row.ok .task-ok { color: var(--green); }

    /* ── Footer ──────────────────────────── */
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 2rem;
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
    }

    .footer a {
      color: var(--text-dim);
      text-decoration: none;
      transition: color 0.2s;
    }

    .footer a:hover { color: var(--accent); }

    .json-link {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.7rem;
      border-radius: 4px;
      background: rgba(123,123,223,0.06);
      border: 1px solid var(--border);
      color: var(--text-dim);
      text-decoration: none;
      font-size: 11px;
      transition: all 0.2s;
    }

    .json-link:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* ── Responsive ──────────────────────── */
    @media (max-width: 640px) {
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .metric-value { font-size: 22px; }
      .header { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    }

    /* ── Timestamp Animation ─────────────── */
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    .ts-blink {
      animation: blink 1.5s step-end infinite;
    }
  </style>
</head>
<body>
  <div class="ambient"></div>
  <div class="scan"></div>

  <div class="wrap">
    <header class="header">
      <div class="header-left">
        <div class="logo-mark">A</div>
        <div class="header-title">
          <h1>AEGIS</h1>
          <span>System Health Monitor</span>
        </div>
      </div>
      <span class="version-tag">v${esc(data.version)}</span>
    </header>

    <div class="status-banner ${statusClass}">
      <span class="status-pulse"></span>
      ${statusText}
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="metric-label">Task Runs (24h)</div>
        <div class="metric-value">${totalRuns}</div>
        <div class="metric-sub">${data.tasks.length} scheduled tasks</div>
      </div>
      <div class="metric">
        <div class="metric-label">Success Rate</div>
        <div class="metric-value green">${successRate}%</div>
        <div class="metric-sub">${totalErrors} error${totalErrors === 1 ? '' : 's'} in 24h</div>
      </div>
      <div class="metric">
        <div class="metric-label">Kernel Health</div>
        <div class="metric-value teal">${healthScore}%</div>
        <div class="metric-sub">${kernelTotal} procedures tracked</div>
      </div>
      <div class="metric">
        <div class="metric-label">Cognitive State</div>
        <div class="metric-value">${data.memoryCount}</div>
        <div class="metric-sub">${data.goalCount} goals / ${data.agendaCount} agenda</div>
      </div>
      <div class="metric">
        <div class="metric-label">Docs Sync</div>
        <div class="metric-value ${data.docsSyncStatus?.status === 'ok' ? 'green' : data.docsSyncStatus?.status === 'alert' ? 'red' : 'amber'}">${data.docsSyncStatus?.lastSyncAge != null ? (data.docsSyncStatus.lastSyncAge < 24 ? data.docsSyncStatus.lastSyncAge + 'h' : Math.round(data.docsSyncStatus.lastSyncAge / 24) + 'd') : '—'}</div>
        <div class="metric-sub">${data.docsSyncStatus?.status === 'ok' ? 'in sync' : data.docsSyncStatus?.lastSyncAge != null ? 'drift detected' : 'no watermark'}</div>
      </div>
    </div>

    <div class="kernel-section">
      <div class="section-label">Procedural Memory Kernel</div>
      <div class="kernel-bar-wrap">
        <div class="kernel-bar">
          ${kernelTotal > 0 ? `
          <div class="seg-learned" style="width:${(data.kernel.learned / kernelTotal * 100).toFixed(1)}%"></div>
          <div class="seg-learning" style="width:${(data.kernel.learning / kernelTotal * 100).toFixed(1)}%"></div>
          <div class="seg-degraded" style="width:${(data.kernel.degraded / kernelTotal * 100).toFixed(1)}%"></div>
          <div class="seg-broken" style="width:${(data.kernel.broken / kernelTotal * 100).toFixed(1)}%"></div>
          ` : '<div class="seg-learned" style="width:100%"></div>'}
        </div>
        <div class="kernel-legend">
          <div class="kernel-legend-item"><span class="legend-dot learned"></span> Learned <strong>${data.kernel.learned}</strong></div>
          <div class="kernel-legend-item"><span class="legend-dot learning"></span> Learning <strong>${data.kernel.learning}</strong></div>
          <div class="kernel-legend-item"><span class="legend-dot degraded"></span> Degraded <strong>${data.kernel.degraded}</strong></div>
          <div class="kernel-legend-item"><span class="legend-dot broken"></span> Broken <strong>${data.kernel.broken}</strong></div>
        </div>
      </div>
    </div>

    <div class="task-section">
      <div class="section-label">Task Pipeline (Last 24h)</div>
      <div class="task-table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Task</th>
              <th>Runs</th>
              <th>OK</th>
              <th>Errors</th>
              <th>Last Run (UTC)</th>
            </tr>
          </thead>
          <tbody>
            ${taskRows}
          </tbody>
        </table>
      </div>
    </div>

    <footer class="footer">
      <span>AEGIS v${esc(data.version)} &middot; edge-native &middot; <span class="ts-blink">&#9679;</span> ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</span>
      <div style="display:flex;gap:1rem;align-items:center">
        <a href="/pulse" class="json-link">Neural Pulse</a>
        <a href="/" class="json-link">Landing</a>
        <a href="/health?format=json" class="json-link">{} JSON</a>
      </div>
    </footer>
  </div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
