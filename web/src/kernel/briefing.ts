// Re-entry Briefing: "Last time on the operator's dashboard"
// Generates a concise situational briefing when the operator starts a session.
// What happened, what needs attention, what's AEGIS working on.
// No fluff, no preamble. Answer before the question is asked.

import type { EdgeEnv } from './dispatch.js';

export interface Briefing {
  // What happened while you were away
  shipped: string[];       // tasks completed, PRs merged
  failed: string[];        // tasks that need attention
  // What needs you right now
  decisions: string[];     // proposed actions, stale agenda, approvals needed
  // What AEGIS is working on
  active: string[];        // running tasks, pending queue
  // Signals
  alerts: string[];        // ARGUS events, health issues
  // One-liner state
  cognitiveScore: number | null;
  eventCount24h: number;
}

export async function generateBriefing(env: EdgeEnv): Promise<Briefing> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // All queries in parallel — fast
  const [
    completedTasks,
    failedTasks,
    pendingProposed,
    runningTasks,
    pendingTasks,
    staleAgenda,
    recentEvents,
    healthAlerts,
    cogMetrics,
  ] = await Promise.all([
    // Shipped in last 24h
    env.db.prepare(
      "SELECT title, repo, pr_url FROM cc_tasks WHERE status = 'completed' AND completed_at > ? ORDER BY completed_at DESC LIMIT 5"
    ).bind(since).all<{ title: string; repo: string; pr_url: string | null }>(),

    // Failed in last 24h
    env.db.prepare(
      "SELECT title, repo, error FROM cc_tasks WHERE status = 'failed' AND completed_at > ? ORDER BY completed_at DESC LIMIT 3"
    ).bind(since).all<{ title: string; repo: string; error: string | null }>(),

    // Proposed tasks awaiting approval
    env.db.prepare(
      "SELECT title, repo FROM cc_tasks WHERE authority = 'proposed' AND status = 'pending' ORDER BY created_at ASC LIMIT 5"
    ).all<{ title: string; repo: string }>(),

    // Currently running
    env.db.prepare(
      "SELECT title, repo FROM cc_tasks WHERE status = 'running' LIMIT 3"
    ).all<{ title: string; repo: string }>(),

    // Pending queue depth
    env.db.prepare(
      "SELECT COUNT(*) as cnt FROM cc_tasks WHERE status = 'pending'"
    ).first<{ cnt: number }>(),

    // High-priority agenda items older than 3 days (stale = needs attention)
    env.db.prepare(
      "SELECT item FROM agent_agenda WHERE status = 'active' AND priority = 'high' AND created_at < datetime('now', '-3 days') ORDER BY created_at ASC LIMIT 3"
    ).all<{ item: string }>(),

    // ARGUS events in last 24h
    env.db.prepare(
      "SELECT COUNT(*) as cnt FROM events WHERE ts > ?"
    ).bind(since).first<{ cnt: number }>(),

    // Recent health alerts (non-ok heartbeats in last 24h)
    env.db.prepare(
      "SELECT severity, summary FROM heartbeat_results WHERE severity IN ('high', 'critical') AND created_at > ? ORDER BY created_at DESC LIMIT 2"
    ).bind(since).all<{ severity: string; summary: string }>(),

    // Latest cognitive score
    env.db.prepare(
      "SELECT payload FROM digest_sections WHERE section = 'cognitive_metrics' ORDER BY created_at DESC LIMIT 1"
    ).first<{ payload: string }>(),
  ]);

  // Parse cognitive score
  let cognitiveScore: number | null = null;
  if (cogMetrics?.payload) {
    try {
      const parsed = JSON.parse(cogMetrics.payload);
      cognitiveScore = parsed.cognitive_score ?? null;
    } catch { /* skip */ }
  }

  // Build briefing
  const shipped = completedTasks.results.map(t =>
    t.pr_url ? `${t.title} (${t.repo}) — PR: ${t.pr_url}` : `${t.title} (${t.repo})`
  );

  const failed = failedTasks.results.map(t =>
    `${t.title} (${t.repo})${t.error ? ` — ${t.error.slice(0, 80)}` : ''}`
  );

  const decisions: string[] = [];
  if (pendingProposed.results.length > 0) {
    decisions.push(`${pendingProposed.results.length} proposed task${pendingProposed.results.length > 1 ? 's' : ''} awaiting approval: ${pendingProposed.results.map(t => t.title.slice(0, 50)).join(', ')}`);
  }
  for (const item of staleAgenda.results) {
    decisions.push(item.item.slice(0, 100));
  }

  const active: string[] = [];
  for (const t of runningTasks.results) {
    active.push(`Running: ${t.title} (${t.repo})`);
  }
  const queueDepth = pendingTasks?.cnt ?? 0;
  if (queueDepth > 0) {
    active.push(`${queueDepth} task${queueDepth > 1 ? 's' : ''} in queue`);
  }

  const alerts: string[] = [];
  for (const h of healthAlerts.results) {
    alerts.push(`[${h.severity.toUpperCase()}] ${h.summary.slice(0, 100)}`);
  }

  return {
    shipped,
    failed,
    decisions,
    active,
    alerts,
    cognitiveScore,
    eventCount24h: recentEvents?.cnt ?? 0,
  };
}

// Format briefing as concise text for injection into greeting response
export function formatBriefing(b: Briefing): string {
  const sections: string[] = [];

  // Header
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[now.getUTCDay()];
  const scoreStr = b.cognitiveScore !== null ? ` | Cognitive: ${b.cognitiveScore}/100` : '';
  sections.push(`**${day}** — ${b.eventCount24h} events in last 24h${scoreStr}`);

  // What needs you (decisions first — this is what the operator looks for)
  if (b.decisions.length > 0) {
    sections.push(`\n**Needs you:**\n${b.decisions.map(d => `- ${d}`).join('\n')}`);
  }

  // What shipped
  if (b.shipped.length > 0) {
    sections.push(`\n**Shipped (24h):**\n${b.shipped.map(s => `- ${s}`).join('\n')}`);
  }

  // What failed
  if (b.failed.length > 0) {
    sections.push(`\n**Failed:**\n${b.failed.map(f => `- ${f}`).join('\n')}`);
  }

  // Alerts
  if (b.alerts.length > 0) {
    sections.push(`\n**Alerts:**\n${b.alerts.map(a => `- ${a}`).join('\n')}`);
  }

  // What I'm working on
  if (b.active.length > 0) {
    sections.push(`\n**Active:**\n${b.active.map(a => `- ${a}`).join('\n')}`);
  }

  // Nothing happening
  if (b.shipped.length === 0 && b.failed.length === 0 && b.decisions.length === 0 && b.alerts.length === 0) {
    sections.push('\nQuiet 24h. Nothing on fire, nothing shipped. What do you want to work on?');
  }

  return sections.join('\n');
}
