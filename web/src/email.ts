// Resend email client — fetch-based, no SDK dependency

import { operatorConfig } from './operator/index.js';

// ─── Email profile resolution ───────────────────────────────
// Maps profile names to { apiKey, from } using operator config + env keys.

export type EmailProfile = 'default' | 'personal' | 'stackbilt'; // 'stackbilt' kept for backward compat

interface ResolvedSender { apiKey: string; from: string; defaultTo: string }

export function resolveEmailProfile(
  profile: EmailProfile,
  apiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
): ResolvedSender {
  const cfg = operatorConfig.integrations.email.profiles[profile];
  if (!cfg) throw new Error(`Unknown email profile: ${profile}`);
  const keyMap: Record<string, string> = {
    resendApiKey: apiKeys.resendApiKey,
    resendApiKeyPersonal: apiKeys.resendApiKeyPersonal,
  };
  const apiKey = keyMap[cfg.keyEnvField];
  if (!apiKey) throw new Error(`Missing API key for email profile "${profile}" (${cfg.keyEnvField})`);
  return { apiKey, from: cfg.from, defaultTo: cfg.defaultTo };
}

function getDefaultSender(apiKeys: { resendApiKey: string; resendApiKeyPersonal: string }): ResolvedSender {
  return resolveEmailProfile(operatorConfig.integrations.email.defaultProfile as EmailProfile, apiKeys);
}

interface HeartbeatCheck {
  name: string;
  status: 'ok' | 'warn' | 'alert';
  detail: string;
}

interface AgendaItem {
  id: number;
  item: string;
  priority: string;
  context: string | null;
}

async function resendPost(apiKey: string, from: string, to: string, subject: string, html: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [to], subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('Resend API request timed out after 10s');
    }
    throw err;
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

export async function sendHeartbeatAlert(
  apiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
  severity: string,
  summary: string,
  checks: HeartbeatCheck[],
  agendaItems: AgendaItem[] = [],
  notifyEmail?: string,
  profile?: EmailProfile,
): Promise<void> {
  const sender = profile ? resolveEmailProfile(profile, apiKeys) : getDefaultSender(apiKeys);
  const severityLabel = severity.toUpperCase();
  const alertChecks = checks.filter(c => c.status !== 'ok');

  const checksHtml = alertChecks.map(c => {
    const isInfra = c.name.startsWith('worker_');
    const badge = isInfra ? '<span style="display:inline-block;background:#2dd4bf;color:#0a0a0f;font-size:9px;font-weight:700;padding:1px 4px;border-radius:2px;margin-right:6px;vertical-align:middle">INFRA</span>' : '';
    return `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #222;font-family:monospace;color:${c.status === 'alert' ? '#ff6b6b' : '#ffd93d'}">${badge}${c.name}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #222;color:#ccc">${c.detail}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto">
    <div style="background:#1a1a2e;border:1px solid #333;border-left:4px solid ${severity === 'critical' ? '#ff4444' : severity === 'high' ? '#ff6b6b' : '#ffd93d'};border-radius:4px;padding:20px 24px;margin-bottom:20px">
      <p style="margin:0 0 4px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">AEGIS Heartbeat · ${severityLabel}</p>
      <p style="margin:0;font-size:18px;font-weight:600;color:#fff">${summary}</p>
    </div>
    ${alertChecks.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222;border-radius:4px;overflow:hidden">
      <thead>
        <tr style="background:#1a1a2e">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Check</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Detail</th>
        </tr>
      </thead>
      <tbody>${checksHtml}</tbody>
    </table>` : ''}
    ${agendaItems.length > 0 ? `
    <div style="margin-top:20px">
      <p style="margin:0 0 8px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Open Agenda</p>
      ${agendaItems.map(a => `
      <div style="background:#111;border:1px solid #222;border-left:3px solid ${a.priority === 'high' ? '#ff6b6b' : a.priority === 'medium' ? '#ffd93d' : '#555'};border-radius:4px;padding:8px 12px;margin-bottom:6px">
        <span style="font-size:11px;color:#888;font-family:monospace">#${a.id} · ${a.priority}</span>
        <p style="margin:4px 0 0;font-size:13px;color:#ccc">${a.item}</p>
        ${a.context ? `<p style="margin:2px 0 0;font-size:11px;color:#666">${a.context}</p>` : ''}
      </div>`).join('')}
    </div>` : ''}
    <p style="margin:20px 0 0;font-size:12px;color:#555">aegis-web · ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

  await resendPost(sender.apiKey, sender.from, notifyEmail || sender.defaultTo, `[AEGIS] ${severityLabel}: ${summary}`, html);
}

// ─── Weekly memory reflection ────────────────────────────────

export async function sendMemoryReflection(
  apiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
  notifyEmail: string,
  reflection: string,
  memoryCount: number,
  topics: string[],
  date: string,
  profile?: EmailProfile,
): Promise<void> {
  const sender = profile ? resolveEmailProfile(profile, apiKeys) : getDefaultSender(apiKeys);
  // Convert markdown-ish reflection to simple HTML paragraphs
  const contentHtml = reflection
    .split('\n\n')
    .filter(p => p.trim())
    .map(p => {
      // Headers
      if (p.startsWith('## ')) return `<h2 style="margin:20px 0 8px;font-size:16px;font-weight:600;color:#8b8bff;font-family:'Segoe UI',system-ui,sans-serif">${p.slice(3)}</h2>`;
      if (p.startsWith('### ')) return `<h3 style="margin:16px 0 6px;font-size:14px;font-weight:600;color:#3dd6c8;font-family:'Segoe UI',system-ui,sans-serif">${p.slice(4)}</h3>`;
      // Bold emphasis
      const formatted = p.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e0e0e0">$1</strong>');
      return `<p style="margin:0 0 12px;font-size:14px;line-height:1.7;color:#b0b0c0">${formatted}</p>`;
    })
    .join('');

  const topicPills = topics.slice(0, 12).map(t =>
    `<span style="display:inline-block;background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:2px 10px;font-size:11px;color:#888;margin:2px 4px 2px 0">${t}</span>`
  ).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;margin:0;padding:24px">
  <div style="max-width:640px;margin:0 auto">
    <div style="background:#1a1a2e;border:1px solid #333;border-left:4px solid #8b8bff;border-radius:4px;padding:16px 20px;margin-bottom:24px">
      <p style="margin:0 0 2px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">AEGIS Memory Reflection · ${date}</p>
      <p style="margin:0;font-size:18px;font-weight:600;color:#fff">${memoryCount} memories examined</p>
    </div>
    <div style="margin-bottom:20px">${topicPills}</div>
    <div style="background:#111;border:1px solid #222;border-radius:6px;padding:24px 28px">
      ${contentHtml}
    </div>
    <p style="margin:20px 0 0;font-size:11px;color:#444">aegis-web · weekly reflection · ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

  await resendPost(sender.apiKey, sender.from, notifyEmail, `AEGIS — Weekly Reflection [${date}]`, html);
}

// ─── Daily Digest ──────────────────────────────────────────────
// Consolidates operator notifications into one daily email.

export interface DigestTask {
  id: string;
  title: string;
  repo: string;
  status: string;
  authority: string;
  category: string;
  exit_code: number | null;
  error: string | null;
  result: string | null;
  pr_url: string | null;
  completed_at: string | null;
}

export interface DigestHealthCheck {
  severity: string;
  checks: Array<{ name: string; status: string; detail: string }>;
  timestamp: string;
}

export interface DigestAgendaItem {
  id: number;
  item: string;
  priority: string;
  context: string | null;
  created_at?: string;
}

export interface DigestEventNotification {
  source: string;
  event_type: string;
  summary: string;
  priority: string;
  ts: string;
}

export interface DigestServiceAlert {
  source: string;
  severity: string;
  summary: string;
  detail: string;
  findingsCount: number;
}

export interface DigestSections {
  completedTasks: DigestTask[];
  failedTasks: DigestTask[];
  proposedTasks: DigestTask[];
  operatorLog: string | null;
  healthChecks: DigestHealthCheck[];
  eventNotifications: DigestEventNotification[];
  memoryReflection: string | null;
  cognitiveMetrics: {
    cognitive_score: number;
    score_delta: number;
    dispatch_success_rate_7d: number;
    procedure_convergence_rate: number;
    task_success_rate_7d: number;
    tasks_completed_7d: number;
    tasks_failed_7d: number;
    avg_cost_7d: number;
    avg_cost_prior_7d: number;
    memory_count: number;
    top_failure_kind: string | null;
  } | null;
  analytics: {
    sessions_7d: number;
    sessions_prior_7d: number;
    users_7d: number;
    bounce_rate_7d: number;
    top_pages: Array<{ path: string; sessions: number; bounce_rate: number }>;
    top_sources: Array<{ source: string; medium: string; sessions: number }>;
    insights: string[];
  } | null;
  serviceAlerts: DigestServiceAlert[];
  agendaItems: DigestAgendaItem[];
  bizopsInteractions: number | null;
}

export async function sendDailyDigest(
  apiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
  sections: DigestSections,
  notifyEmail?: string,
  profile?: EmailProfile,
): Promise<void> {
  const sender = profile ? resolveEmailProfile(profile, apiKeys) : getDefaultSender(apiKeys);
  const date = new Date().toISOString().slice(0, 10);

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = { completed: '#2dd4bf', failed: '#ff6b6b', pending: '#ffd93d' };
    return `<span style="display:inline-block;background:${colors[s] ?? '#555'};color:#0a0a0f;font-size:9px;font-weight:700;padding:1px 4px;border-radius:2px;margin-right:4px">${s.toUpperCase()}</span>`;
  };

  // ── Section 1: WORK SHIPPED ──
  let workShippedHtml = '';
  if (sections.failedTasks.length > 0 || sections.completedTasks.length > 0) {
    const taskRow = (t: DigestTask) => {
      const pr = t.pr_url ? ` <a href="${t.pr_url}" style="color:#8b8bff;text-decoration:none;font-size:11px">PR →</a>` : '';
      const errorSnippet = t.error ? `<p style="margin:2px 0 0;font-size:11px;color:#ff6b6b">${t.error.slice(0, 100)}</p>` : '';
      return `
      <div style="background:#111;border:1px solid #222;border-left:3px solid ${t.status === 'completed' ? '#2dd4bf' : '#ff6b6b'};border-radius:4px;padding:8px 12px;margin-bottom:6px">
        <div>${statusBadge(t.status)}<span style="font-size:11px;color:#888;font-family:monospace">${t.repo} · ${t.category}</span>${pr}</div>
        <p style="margin:4px 0 0;font-size:13px;color:#ccc">${t.title}</p>
        ${errorSnippet}
      </div>`;
    };

    workShippedHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#2dd4bf;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Work Shipped</p>
      ${sections.failedTasks.map(taskRow).join('')}
      ${sections.completedTasks.map(taskRow).join('')}
      <p style="margin:8px 0 0;font-size:12px;color:#666">${sections.completedTasks.length} completed · ${sections.failedTasks.length} failed</p>
    </div>`;
  }

  // ── Section 2: OPERATOR'S LOG ──
  let operatorLogHtml = '';
  if (sections.operatorLog) {
    const contentHtml = sections.operatorLog
      .split('\n\n')
      .filter(p => p.trim())
      .map(p => {
        if (p.startsWith('## ')) return `<h2 style="margin:16px 0 6px;font-size:15px;font-weight:600;color:#8b8bff">${p.slice(3)}</h2>`;
        if (p.startsWith('### ')) return `<h3 style="margin:12px 0 4px;font-size:13px;font-weight:600;color:#3dd6c8">${p.slice(4)}</h3>`;
        const formatted = p.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e0e0e0">$1</strong>');
        return `<p style="margin:0 0 10px;font-size:13px;line-height:1.65;color:#b0b0c0">${formatted}</p>`;
      })
      .join('');

    operatorLogHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#3dd6c8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Operator's Log</p>
      <div style="background:#111;border:1px solid #222;border-radius:6px;padding:16px 20px">
        ${contentHtml}
      </div>
    </div>`;
  }

  // ── Section 3: SYSTEM HEALTH ──
  let healthHtml = '';
  if (sections.healthChecks.length > 0) {
    const allChecks = sections.healthChecks.flatMap(h => h.checks.map(c => ({ ...c, severity: h.severity })));
    const checksRows = allChecks.map(c => {
      const color = c.status === 'alert' ? '#ff6b6b' : '#ffd93d';
      return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-family:monospace;color:${color}">${c.name}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #222;color:#ccc">${c.detail}</td>
      </tr>`;
    }).join('');

    healthHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#ffd93d;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">System Health</p>
      <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222;border-radius:4px;overflow:hidden">
        <thead>
          <tr style="background:#1a1a2e">
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Check</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Detail</th>
          </tr>
        </thead>
        <tbody>${checksRows}</tbody>
      </table>
    </div>`;
  }

  // ── Section 3b: ARGUS EVENTS ──
  let eventsHtml = '';
  if (sections.eventNotifications.length > 0) {
    const eventRows = sections.eventNotifications.map(e => {
      const color = e.priority === 'high' ? '#f5a623' : '#888';
      return `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-size:11px;color:#666">${e.source}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-family:monospace;color:${color};font-size:12px">${e.event_type}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #222;color:#ccc;font-size:12px">${e.summary}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-size:11px;color:#555">${e.ts.slice(0, 16)}</td>
      </tr>`;
    }).join('');

    eventsHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#7b7bdf;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">ARGUS Events (${sections.eventNotifications.length})</p>
      <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222;border-radius:4px;overflow:hidden">
        <thead>
          <tr style="background:#1a1a2e">
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Source</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Event</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Summary</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Time</th>
          </tr>
        </thead>
        <tbody>${eventRows}</tbody>
      </table>
    </div>`;
  }

  // ── Section 3c: COGNITIVE SCORECARD ──
  let metricsHtml = '';
  if (sections.cognitiveMetrics) {
    const m = sections.cognitiveMetrics;
    const arrow = m.score_delta > 0 ? '&#9650;' : m.score_delta < 0 ? '&#9660;' : '&#9644;';
    const arrowColor = m.score_delta > 0 ? '#2dd4a0' : m.score_delta < 0 ? '#ef4444' : '#888';
    const scoreColor = m.cognitive_score >= 75 ? '#2dd4a0' : m.cognitive_score >= 50 ? '#f5a623' : '#ef4444';
    const costDelta = m.avg_cost_prior_7d > 0
      ? ((m.avg_cost_7d - m.avg_cost_prior_7d) / m.avg_cost_prior_7d * 100).toFixed(0)
      : '0';
    const costArrow = Number(costDelta) <= 0 ? '#2dd4a0' : '#ef4444';

    metricsHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#f5a623;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Cognitive Scorecard</p>
      <div style="background:#111;border:1px solid #222;border-radius:6px;padding:16px 20px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:12px">
          <span style="font-size:36px;font-weight:700;color:${scoreColor};line-height:1">${m.cognitive_score}</span>
          <span style="font-size:14px;color:${arrowColor}">${arrow} ${Math.abs(m.score_delta)}</span>
          <span style="font-size:12px;color:#666">/100</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:3px 0;font-size:11px;color:#888">Dispatch success</td><td style="padding:3px 0;font-size:12px;color:#ccc;text-align:right">${Math.round(m.dispatch_success_rate_7d * 100)}%</td></tr>
          <tr><td style="padding:3px 0;font-size:11px;color:#888">Procedures learned</td><td style="padding:3px 0;font-size:12px;color:#ccc;text-align:right">${Math.round(m.procedure_convergence_rate * 100)}%</td></tr>
          <tr><td style="padding:3px 0;font-size:11px;color:#888">Tasks shipped (7d)</td><td style="padding:3px 0;font-size:12px;color:#ccc;text-align:right">${m.tasks_completed_7d} / ${m.tasks_completed_7d + m.tasks_failed_7d}</td></tr>
          <tr><td style="padding:3px 0;font-size:11px;color:#888">Avg cost/dispatch</td><td style="padding:3px 0;font-size:12px;color:${costArrow};text-align:right">$${m.avg_cost_7d.toFixed(4)} (${Number(costDelta) <= 0 ? '' : '+'}${costDelta}%)</td></tr>
          <tr><td style="padding:3px 0;font-size:11px;color:#888">Memory entries</td><td style="padding:3px 0;font-size:12px;color:#ccc;text-align:right">${m.memory_count}</td></tr>
          ${m.top_failure_kind ? `<tr><td style="padding:3px 0;font-size:11px;color:#888">Top failure mode</td><td style="padding:3px 0;font-size:12px;color:#ef4444;text-align:right">${m.top_failure_kind}</td></tr>` : ''}
        </table>
      </div>
    </div>`;
  }

  // ── Section 3c2: ANALYTICS ──
  let analyticsHtml = '';
  if (sections.analytics && sections.analytics.sessions_7d > 0) {
    const a = sections.analytics;
    const trafficDelta = a.sessions_prior_7d > 0
      ? Math.round((a.sessions_7d - a.sessions_prior_7d) / a.sessions_prior_7d * 100)
      : 0;
    const trafficArrow = trafficDelta > 0 ? '&#9650;' : trafficDelta < 0 ? '&#9660;' : '&#9644;';
    const trafficColor = trafficDelta > 0 ? '#2dd4a0' : trafficDelta < 0 ? '#ef4444' : '#888';

    const pagesRows = a.top_pages.slice(0, 5).map(p => `
      <tr>
        <td style="padding:4px 12px;font-size:12px;color:#ccc;border-bottom:1px solid #222;font-family:monospace">${p.path}</td>
        <td style="padding:4px 12px;font-size:12px;color:#ccc;border-bottom:1px solid #222;text-align:right">${p.sessions}</td>
        <td style="padding:4px 12px;font-size:12px;color:${p.bounce_rate > 0.85 ? '#ef4444' : '#888'};border-bottom:1px solid #222;text-align:right">${(p.bounce_rate * 100).toFixed(0)}%</td>
      </tr>`).join('');

    const sourcesRows = a.top_sources.slice(0, 5).map(s => `
      <tr>
        <td style="padding:4px 12px;font-size:12px;color:#ccc;border-bottom:1px solid #222">${s.source}</td>
        <td style="padding:4px 12px;font-size:12px;color:#888;border-bottom:1px solid #222">${s.medium}</td>
        <td style="padding:4px 12px;font-size:12px;color:#ccc;border-bottom:1px solid #222;text-align:right">${s.sessions}</td>
      </tr>`).join('');

    const insightsHtml = a.insights.length > 0
      ? `<div style="margin-top:12px;background:#0b1a1a;border:1px solid rgba(61,214,200,0.15);border-radius:4px;padding:10px 14px">
          <ul style="margin:0;padding-left:16px">${a.insights.map(i => `<li style="margin-bottom:4px;font-size:12px;color:#ccc">${i}</li>`).join('')}</ul>
        </div>`
      : '';

    analyticsHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#8b8bff;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Traffic (GA4)</p>
      <div style="background:#111;border:1px solid #222;border-radius:6px;padding:16px 20px">
        <div style="display:flex;gap:24px;margin-bottom:12px">
          <div><span style="font-size:24px;font-weight:700;color:#ccc">${a.sessions_7d}</span><span style="font-size:12px;color:#666"> sessions</span></div>
          <div><span style="font-size:24px;font-weight:700;color:#ccc">${a.users_7d}</span><span style="font-size:12px;color:#666"> users</span></div>
          <div><span style="font-size:14px;color:${trafficColor}">${trafficArrow} ${Math.abs(trafficDelta)}%</span><span style="font-size:12px;color:#666"> vs prior week</span></div>
        </div>
        ${pagesRows ? `<table style="width:100%;border-collapse:collapse;margin-bottom:8px">
          <thead><tr>
            <th style="padding:4px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase">Page</th>
            <th style="padding:4px 12px;font-size:10px;color:#666;text-align:right;text-transform:uppercase">Sessions</th>
            <th style="padding:4px 12px;font-size:10px;color:#666;text-align:right;text-transform:uppercase">Bounce</th>
          </tr></thead><tbody>${pagesRows}</tbody></table>` : ''}
        ${sourcesRows ? `<table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="padding:4px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase">Source</th>
            <th style="padding:4px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase">Medium</th>
            <th style="padding:4px 12px;font-size:10px;color:#666;text-align:right;text-transform:uppercase">Sessions</th>
          </tr></thead><tbody>${sourcesRows}</tbody></table>` : ''}
        ${insightsHtml}
      </div>
    </div>`;
  }

  // ── Section 3b2: SERVICE ALERTS ──
  let serviceAlertsHtml = '';
  if (sections.serviceAlerts.length > 0) {
    const sevColor = (s: string) => s === 'critical' ? '#ef4444' : s === 'high' ? '#f5a623' : s === 'medium' ? '#ffd93d' : '#888';
    const alertRows = sections.serviceAlerts.map(a => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-size:12px;color:${sevColor(a.severity)};font-weight:600">${a.severity.toUpperCase()}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-size:11px;color:#888;font-family:monospace">${a.source}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #222;font-size:12px;color:#ccc">${a.summary}${a.findingsCount > 0 ? ` <span style="color:#888">(${a.findingsCount} findings)</span>` : ''}</td>
      </tr>`).join('');

    serviceAlertsHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#f5a623;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Service Alerts (${sections.serviceAlerts.length})</p>
      <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222;border-radius:4px;overflow:hidden">
        <thead>
          <tr style="background:#1a1a2e">
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Severity</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Source</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#666;text-transform:uppercase">Summary</th>
          </tr>
        </thead>
        <tbody>${alertRows}</tbody>
      </table>
    </div>`;
  }

  // ── Section 3d: CO-FOUNDER'S TAKE ──
  // Opinionated synthesis: what matters, what's off track, what nobody's working on
  let cofounderHtml = '';
  {
    const takes: string[] = [];

    // Revenue signal
    const hasRevenue = sections.eventNotifications.some(e => e.event_type.includes('payment') || e.event_type.includes('checkout') || e.event_type.includes('invoice.paid'));
    const hasFailedPayment = sections.eventNotifications.some(e => e.event_type.includes('failed'));
    if (hasRevenue && !hasFailedPayment) {
      takes.push('Revenue is flowing. Keep shipping.');
    } else if (hasFailedPayment) {
      takes.push('Payment failures detected. Check Stripe dashboard before anything else today.');
    }

    // Task health
    const failRate = sections.failedTasks.length / Math.max(1, sections.completedTasks.length + sections.failedTasks.length);
    if (failRate > 0.4 && sections.failedTasks.length >= 3) {
      takes.push(`Task failure rate is ${Math.round(failRate * 100)}% — the taskrunner is burning cycles. Review failed tasks before queuing more.`);
    }

    // Stale proposals
    const staleProposals = sections.agendaItems.filter(a => {
      if (!a.item.startsWith('[PROPOSED ACTION]') || !a.created_at) return false;
      const ageDays = (Date.now() - new Date(a.created_at).getTime()) / 86_400_000;
      return ageDays > 4;
    });
    if (staleProposals.length > 0) {
      takes.push(`${staleProposals.length} proposed action${staleProposals.length > 1 ? 's' : ''} aging out. Approve or dismiss — stale proposals mean I'm doing work you're not reviewing.`);
    }

    // High-priority agenda items piling up
    const highItems = sections.agendaItems.filter(a => a.priority === 'high' && !a.item.startsWith('[PROPOSED'));
    if (highItems.length >= 4) {
      takes.push(`${highItems.length} high-priority agenda items. That's too many "high" items — either some aren't really high, or we need a focused triage session.`);
    }

    // Nothing shipped
    if (sections.completedTasks.length === 0 && sections.failedTasks.length === 0) {
      takes.push('No tasks ran in the last 24h. Is the taskrunner down, or is this intentional?');
    }

    // Health checks surfacing
    if (sections.healthChecks.length > 0) {
      const critChecks = sections.healthChecks.filter(h => h.severity === 'critical');
      if (critChecks.length > 0) {
        takes.push('Critical health checks in the system. This takes priority over feature work.');
      }
    }

    // Service alerts
    const critAlerts = sections.serviceAlerts.filter(a => a.severity === 'critical');
    if (critAlerts.length > 0) {
      takes.push(`${critAlerts.length} critical service alert${critAlerts.length > 1 ? 's' : ''} from ${[...new Set(critAlerts.map(a => a.source))].join(', ')}. Review immediately.`);
    }

    // Memory reflection available
    if (sections.memoryReflection) {
      takes.push('Weekly reflection attached below — worth a 2-minute read to see what I\'m learning.');
    }

    if (takes.length > 0) {
      const takesHtml = takes.map(t => `<li style="margin-bottom:6px;font-size:13px;line-height:1.5;color:#ccc">${t}</li>`).join('');
      cofounderHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#3dd6c8;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Co-Founder's Take</p>
      <div style="background:#0b1a1a;border:1px solid rgba(61,214,200,0.15);border-left:3px solid #3dd6c8;border-radius:4px;padding:12px 16px">
        <ul style="margin:0;padding-left:18px">${takesHtml}</ul>
      </div>
    </div>`;
    }
  }

  // ── Section 3d: MEMORY REFLECTION ──
  let reflectionHtml = '';
  if (sections.memoryReflection) {
    const formatted = sections.memoryReflection
      .split('\n\n')
      .filter(p => p.trim())
      .map(p => `<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#b0b0c0">${p.replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e0e0e0">$1</strong>')}</p>`)
      .join('');
    reflectionHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#a855f7;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Weekly Reflection</p>
      <div style="background:#111;border:1px solid #222;border-radius:6px;padding:16px 20px">${formatted}</div>
    </div>`;
  }

  // ── Section 4: AWAITING ACTION ──
  let awaitingHtml = '';
  // Split agenda into proposed actions vs regular high-priority items
  const proposedAgenda = sections.agendaItems.filter(a => a.item.startsWith('[PROPOSED ACTION]'));
  const highAgenda = sections.agendaItems.filter(a => a.priority === 'high' && !a.item.startsWith('[PROPOSED ACTION]'));
  if (sections.proposedTasks.length > 0 || proposedAgenda.length > 0 || highAgenda.length > 0) {
    const proposedTaskRows = sections.proposedTasks.map(t => `
      <div style="background:#111;border:1px solid #222;border-left:3px solid #a855f7;border-radius:4px;padding:8px 12px;margin-bottom:6px">
        <div>${statusBadge('pending')}<span style="font-size:11px;color:#888;font-family:monospace">${t.repo} · ${t.category}</span></div>
        <p style="margin:4px 0 0;font-size:13px;color:#ccc">${t.title}</p>
        <p style="margin:4px 0 0;font-size:11px;color:#a855f7">Awaiting approval · ID: ${t.id.slice(0, 8)}</p>
      </div>`).join('');

    // Proposed action agenda items with expiry countdown (auto-expire at 7d)
    const proposedAgendaRows = proposedAgenda.map(a => {
      const ageDays = Math.floor((Date.now() - new Date(a.created_at ?? Date.now()).getTime()) / 86_400_000);
      const daysLeft = Math.max(0, 7 - ageDays);
      const expiryNote = daysLeft <= 2 ? `<span style="color:#ff6b6b"> expires in ${daysLeft}d</span>` : `<span style="color:#888"> ${daysLeft}d until auto-expire</span>`;
      return `
      <div style="background:#111;border:1px solid #222;border-left:3px solid #a855f7;border-radius:4px;padding:8px 12px;margin-bottom:6px">
        <span style="font-size:11px;color:#888;font-family:monospace">#${a.id} · proposed${expiryNote}</span>
        <p style="margin:4px 0 0;font-size:13px;color:#ccc">${a.item.replace('[PROPOSED ACTION] ', '')}</p>
      </div>`;
    }).join('');

    const agendaRows = highAgenda.map(a => `
      <div style="background:#111;border:1px solid #222;border-left:3px solid #ff6b6b;border-radius:4px;padding:8px 12px;margin-bottom:6px">
        <span style="font-size:11px;color:#888;font-family:monospace">#${a.id} · ${a.priority}</span>
        <p style="margin:4px 0 0;font-size:13px;color:#ccc">${a.item}</p>
      </div>`).join('');

    // Review prompt only when proposals exist
    const reviewPrompt = proposedAgenda.length > 0
      ? `<p style="margin:8px 0 0;font-size:11px;color:#a855f7">${proposedAgenda.length} proposed action${proposedAgenda.length !== 1 ? 's' : ''} awaiting review. Unapproved proposals auto-expire after 7 days.</p>`
      : '';

    awaitingHtml = `
    <div style="margin-bottom:24px">
      <p style="margin:0 0 10px;font-size:11px;color:#a855f7;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #222;padding-bottom:6px">Awaiting Action</p>
      ${proposedTaskRows}
      ${proposedAgendaRows}
      ${agendaRows}
      ${reviewPrompt}
    </div>`;
  }

  // ── Section 5: STATS BAR ──
  const stats = [
    `${sections.completedTasks.length + sections.failedTasks.length} tasks`,
    `${sections.proposedTasks.length} proposed`,
    `${sections.agendaItems.length} agenda`,
    `${sections.healthChecks.length} health checks`,
  ];
  if (sections.eventNotifications.length > 0) stats.push(`${sections.eventNotifications.length} events`);
  if (sections.serviceAlerts.length > 0) stats.push(`${sections.serviceAlerts.length} alerts`);
  if (sections.bizopsInteractions !== null) stats.push(`${sections.bizopsInteractions} interactions`);

  const statsHtml = `<p style="margin:0;padding:12px 0;font-size:11px;color:#555;border-top:1px solid #222;text-align:center">${stats.join(' · ')}</p>`;

  const hasContent = metricsHtml || cofounderHtml || workShippedHtml || operatorLogHtml || healthHtml || eventsHtml || serviceAlertsHtml || analyticsHtml || reflectionHtml || awaitingHtml;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;margin:0;padding:24px">
  <div style="max-width:600px;margin:0 auto">
    <div style="background:#1a1a2e;border:1px solid #333;border-left:4px solid #3dd6c8;border-radius:4px;padding:16px 20px;margin-bottom:24px">
      <p style="margin:0 0 2px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">AEGIS — Co-Founder Brief</p>
      <p style="margin:0;font-size:18px;font-weight:600;color:#fff">${date}</p>
    </div>
    ${hasContent ? `${metricsHtml}${cofounderHtml}${workShippedHtml}${operatorLogHtml}${healthHtml}${eventsHtml}${serviceAlertsHtml}${analyticsHtml}${reflectionHtml}${awaitingHtml}` : '<p style="font-size:13px;color:#888;margin-bottom:20px">No significant activity in the last 24 hours.</p>'}
    ${statsHtml}
    <p style="margin:12px 0 0;font-size:11px;color:#444">aegis-web · daily digest · ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

  await resendPost(sender.apiKey, sender.from, notifyEmail || sender.defaultTo, `[AEGIS] Co-Founder Brief — ${date}`, html);
}

// ─── Operator's Log Email ───────────────────────────────────
// Standalone nightly worklog email at midnight CT (05:00 UTC).

export async function sendOperatorLog(
  apiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
  to: string,
  logContent: string,
  stats: { episodes: number; goals: number; tasksCompleted: number; tasksFailed: number; prs: number },
): Promise<void> {
  const sender = getDefaultSender(apiKeys);
  const date = new Date().toISOString().slice(0, 10);

  const taskLine = stats.tasksCompleted > 0 || stats.tasksFailed > 0
    ? ` | ${stats.tasksCompleted} shipped${stats.tasksFailed > 0 ? `, ${stats.tasksFailed} failed` : ''}${stats.prs > 0 ? `, ${stats.prs} PRs` : ''}`
    : '';
  const subject = `[AEGIS] Operator's Log — ${date}${taskLine}`;

  const contentHtml = logContent
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/## (.+)/g, '<h3 style="font-size:15px;color:#c8c8d8;margin:20px 0 8px;border-bottom:1px solid #222;padding-bottom:4px">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e0e0e0">$1</strong>')
    .replace(/✓/g, '<span style="color:#2dd4a0">✓</span>')
    .replace(/✗/g, '<span style="color:#ef4444">✗</span>')
    .replace(/\n/g, '<br>');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0a0a0f;margin:0;padding:32px 16px;font-family:'Courier New',monospace">
  <div style="max-width:640px;margin:0 auto">
    <div style="border-bottom:1px solid #222;padding-bottom:12px;margin-bottom:20px">
      <span style="font-size:11px;color:#7b7bdf;text-transform:uppercase;letter-spacing:0.1em">AEGIS Operator's Log</span>
      <span style="float:right;font-size:11px;color:#555">${date}</span>
    </div>
    <div style="font-size:13px;line-height:1.7;color:#a0a0b0">${contentHtml}</div>
    <div style="margin-top:24px;padding-top:12px;border-top:1px solid #222;font-size:11px;color:#444">
      ${stats.episodes} dispatches | ${stats.goals} goal runs | ${stats.tasksCompleted + stats.tasksFailed} tasks
    </div>
  </div>
</body></html>`;

  await resendPost(sender.apiKey, sender.from, to, subject, html);
}

// ─── Welcome Email ──────────────────────────────────────────
// Sent when a new user signs up via the platform.

export async function sendWelcomeEmail(
  apiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
  recipientEmail: string,
  recipientName?: string,
): Promise<void> {
  const sender = getDefaultSender(apiKeys);
  const displayName = recipientName || recipientEmail.split('@')[0];

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="background:#0a0a0f;margin:0;padding:32px 16px;font-family:system-ui,sans-serif">
  <div style="max-width:560px;margin:0 auto">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-size:28px;color:#c4956a;margin:0 0 4px;font-weight:400">Welcome</h1>
      <p style="font-size:13px;color:#666;margin:0">Your account is ready</p>
    </div>

    <!-- Body -->
    <div style="background:#111;border:1px solid #222;border-radius:8px;padding:32px">
      <h2 style="font-size:22px;color:#e0e0e0;margin:0 0 16px;font-weight:400">Welcome, ${displayName}</h2>

      <p style="font-size:15px;line-height:1.7;color:#b0b0c0;margin:0 0 20px">
        Your account is live. You can start using the platform right away.
      </p>

      <p style="font-size:14px;color:#b0b0c0;margin:0 0 8px">
        Your free tier includes <strong style="color:#e0e0e0">25 credits</strong> — enough to explore without a credit card.
      </p>

      <!-- CTA -->
      <div style="text-align:center;margin:28px 0 8px">
        <a href="https://example.com/dashboard" style="display:inline-block;background:#c4956a;color:#0a0a0f;font-family:system-ui,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:6px">Open Dashboard</a>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:28px;padding-top:20px;border-top:1px solid #1a1a1a">
      <p style="font-size:12px;color:#555;margin:0 0 4px">Your Organization</p>
      <p style="font-size:11px;color:#444;margin:0">
        <a href="https://example.com/unsubscribe?email=${encodeURIComponent(recipientEmail)}" style="color:#666;text-decoration:none">Unsubscribe</a>
      </p>
    </div>

  </div>
</body>
</html>`;

  await resendPost(sender.apiKey, sender.from, recipientEmail, 'Welcome', html);
}
