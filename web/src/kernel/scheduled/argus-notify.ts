// ARGUS Phase 2: Event notification processor
// Reads unnotified events from the events table, classifies priority,
// and routes to immediate email (critical) or daily digest (high/medium).
// Runs every hour as a scheduled task.

import { type EdgeEnv } from '../dispatch.js';
import { resolveEmailProfile } from '../../email.js';
import { operatorConfig } from '../../operator/index.js';

// ─── Priority Classification ────────────────────────────────

type Priority = 'critical' | 'high' | 'medium' | 'low';

interface ClassifiedEvent {
  id: string;
  source: string;
  event_type: string;
  payload: Record<string, unknown>;
  ts: string;
  priority: Priority;
  summary: string;
}

// Events that warrant immediate email
const CRITICAL_EVENTS: Record<string, Set<string>> = {
  stripe: new Set([
    'charge.failed',
    'customer.subscription.deleted',
    'invoice.payment_failed',
    'payment_intent.payment_failed',
  ]),
  github: new Set([
    'check_run.completed', // only if conclusion=failure, refined below
  ]),
};

// Events worth tracking in digest
const HIGH_EVENTS: Record<string, Set<string>> = {
  stripe: new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'invoice.paid',
    'payment_intent.succeeded',
  ]),
  github: new Set([
    'pull_request.merged',
    'pull_request.opened',
    'issues.opened',
    'release.published',
  ]),
};

// Events to log but not notify
const MEDIUM_EVENTS: Record<string, Set<string>> = {
  github: new Set([
    'pull_request.closed',
    'issues.closed',
    'push',
    'create', // branch/tag creation
  ]),
};

export function classifyEvent(source: string, event_type: string, payload: Record<string, unknown>): { priority: Priority; summary: string } {
  // GitHub push to auto/* branches with 0 commits = taskrunner branch cleanup noise
  if (source === 'github' && event_type === 'push') {
    const ref = (payload.ref as string) ?? '';
    const commits = payload.commits as unknown[] | undefined;
    if (ref.startsWith('refs/heads/auto/') && (!commits || commits.length === 0)) {
      return { priority: 'low', summary: 'Auto-branch push (0 commits, filtered)' };
    }
  }

  // GitHub check_run failures are critical, successes are low
  if (source === 'github' && event_type === 'check_run.completed') {
    const conclusion = (payload.check_run as Record<string, unknown>)?.conclusion as string;
    if (conclusion === 'failure') {
      const name = (payload.check_run as Record<string, unknown>)?.name ?? 'CI';
      const repo = (payload.repository as Record<string, unknown>)?.full_name ?? 'unknown';
      return { priority: 'critical', summary: `CI failure: ${name} in ${repo}` };
    }
    return { priority: 'low', summary: 'CI check passed' };
  }

  // Critical events
  if (CRITICAL_EVENTS[source]?.has(event_type)) {
    return { priority: 'critical', summary: summarizeEvent(source, event_type, payload) };
  }

  // High events
  if (HIGH_EVENTS[source]?.has(event_type)) {
    return { priority: 'high', summary: summarizeEvent(source, event_type, payload) };
  }

  // Medium events
  if (MEDIUM_EVENTS[source]?.has(event_type)) {
    return { priority: 'medium', summary: summarizeEvent(source, event_type, payload) };
  }

  return { priority: 'low', summary: summarizeEvent(source, event_type, payload) };
}

function summarizeEvent(source: string, event_type: string, payload: Record<string, unknown>): string {
  if (source === 'github') {
    const repo = (payload.repository as Record<string, unknown>)?.full_name ?? '';
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const issue = payload.issue as Record<string, unknown> | undefined;

    if (pr) return `${event_type}: ${pr.title} (#${pr.number}) in ${repo}`;
    if (issue) return `${event_type}: ${issue.title} (#${issue.number}) in ${repo}`;
    if (event_type === 'push') {
      const ref = (payload.ref as string)?.replace('refs/heads/', '') ?? '';
      const commits = (payload.commits as unknown[])?.length ?? 0;
      return `push: ${commits} commit(s) to ${ref} in ${repo}`;
    }
    return `${event_type} in ${repo}`;
  }

  if (source === 'stripe') {
    const obj = payload.data as Record<string, unknown> | undefined;
    const inner = obj?.object as Record<string, unknown> | undefined;
    const amount = inner?.amount as number | undefined;
    const currency = (inner?.currency as string)?.toUpperCase() ?? '';
    if (amount !== undefined) {
      return `${event_type}: ${(amount / 100).toFixed(2)} ${currency}`;
    }
    return event_type;
  }

  return `${source}/${event_type}`;
}

// ─── Notification Routing ────────────────────────────────────

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h cooldown per event type

async function shouldNotify(db: D1Database, source: string, event_type: string): Promise<boolean> {
  const cooldownKey = `argus_alert_${source}_${event_type}`;
  const last = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = ?"
  ).bind(cooldownKey).first<{ received_at: string }>();

  if (last) {
    const elapsed = Date.now() - new Date(last.received_at + 'Z').getTime();
    if (elapsed < ALERT_COOLDOWN_MS) return false;
  }
  return true;
}

async function recordCooldown(db: D1Database, source: string, event_type: string): Promise<void> {
  const cooldownKey = `argus_alert_${source}_${event_type}`;
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
  ).bind(cooldownKey).run();
}

async function sendCriticalAlert(env: EdgeEnv, events: ClassifiedEvent[]): Promise<void> {
  if (!env.resendApiKey || !env.notifyEmail) return;

  const sender = resolveEmailProfile(operatorConfig.integrations.email.defaultProfile, {
    resendApiKey: env.resendApiKey,
    resendApiKeyPersonal: env.resendApiKeyPersonal,
  });

  const eventRows = events.map(e => `
    <tr>
      <td style="padding:6px 12px;font-size:11px;color:#888;border-bottom:1px solid #1a1a2e">${e.source}</td>
      <td style="padding:6px 12px;font-size:12px;color:#e0e0e0;border-bottom:1px solid #1a1a2e">${escapeHtml(e.event_type)}</td>
      <td style="padding:6px 12px;font-size:12px;color:#ccc;border-bottom:1px solid #1a1a2e">${escapeHtml(e.summary)}</td>
      <td style="padding:6px 12px;font-size:11px;color:#666;border-bottom:1px solid #1a1a2e">${e.ts.slice(0, 19)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;margin:0;padding:24px">
<div style="max-width:640px;margin:0 auto">
  <div style="background:#1a1a2e;border:1px solid #333;border-left:4px solid #ef4444;border-radius:4px;padding:16px 20px;margin-bottom:20px">
    <p style="margin:0 0 2px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">ARGUS Alert</p>
    <p style="margin:0;font-size:16px;font-weight:600;color:#ef4444">${events.length} Critical Event${events.length > 1 ? 's' : ''}</p>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222;border-radius:6px">
    <thead><tr>
      <th style="padding:8px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase;border-bottom:1px solid #333">Source</th>
      <th style="padding:8px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase;border-bottom:1px solid #333">Event</th>
      <th style="padding:8px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase;border-bottom:1px solid #333">Summary</th>
      <th style="padding:8px 12px;font-size:10px;color:#666;text-align:left;text-transform:uppercase;border-bottom:1px solid #333">Time</th>
    </tr></thead>
    <tbody>${eventRows}</tbody>
  </table>
  <p style="margin:16px 0 0;font-size:11px;color:#444">aegis · argus · ${new Date().toISOString()}</p>
</div></body></html>`;

  const subject = events.length === 1
    ? `[ARGUS] ${events[0].summary}`
    : `[ARGUS] ${events.length} critical events — ${events[0].summary}`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sender.apiKey}` },
    body: JSON.stringify({ from: sender.from, to: [env.notifyEmail], subject, html }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function queueForDigest(db: D1Database, events: ClassifiedEvent[]): Promise<void> {
  if (events.length === 0) return;

  const payload = JSON.stringify({
    type: 'argus_events',
    events: events.map(e => ({
      source: e.source,
      event_type: e.event_type,
      summary: e.summary,
      priority: e.priority,
      ts: e.ts,
    })),
    timestamp: new Date().toISOString(),
  });

  await db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('event_notification', ?)"
  ).bind(payload).run();
}

// ─── Main Processor ──────────────────────────────────────────

export async function runArgusNotifications(env: EdgeEnv): Promise<void> {
  // Fetch unprocessed events (batch of 50)
  const result = await env.db.prepare(
    "SELECT id, source, event_type, payload, ts FROM events WHERE notified = 0 ORDER BY ts ASC LIMIT 50"
  ).all<{ id: string; source: string; event_type: string; payload: string; ts: string }>();

  const rows = result.results;
  if (rows.length === 0) return;

  // Classify all events. Stripe test-mode events are dropped pre-classification so
  // they never land in digest_sections — real MRR is livemode=true only. Rows still
  // get marked notified=1 below so we don't re-scan them on the next run.
  const classified: ClassifiedEvent[] = rows.flatMap(row => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload); } catch { /* use empty */ }
    if (row.source === 'stripe' && payload.livemode === false) {
      return [];
    }
    const { priority, summary } = classifyEvent(row.source, row.event_type, payload);
    return [{ id: row.id, source: row.source, event_type: row.event_type, payload, ts: row.ts, priority, summary }];
  });

  // Split by priority
  const critical: ClassifiedEvent[] = [];
  const digestable: ClassifiedEvent[] = [];

  for (const event of classified) {
    if (event.priority === 'critical') {
      const canNotify = await shouldNotify(env.db, event.source, event.event_type);
      if (canNotify) critical.push(event);
    } else if (event.priority === 'high' || event.priority === 'medium') {
      digestable.push(event);
    }
    // low priority: skip notification entirely, just mark as notified
  }

  // Send critical alerts immediately
  if (critical.length > 0) {
    try {
      await sendCriticalAlert(env, critical);
      for (const e of critical) {
        await recordCooldown(env.db, e.source, e.event_type);
      }
      console.log(`[argus] Sent critical alert for ${critical.length} event(s)`);
    } catch (err) {
      console.error('[argus] Critical alert send failed:', err instanceof Error ? err.message : err);
    }
  }

  // Queue high/medium for daily digest
  if (digestable.length > 0) {
    try {
      await queueForDigest(env.db, digestable);
      console.log(`[argus] Queued ${digestable.length} event(s) for daily digest`);
    } catch (err) {
      console.error('[argus] Digest queue failed:', err instanceof Error ? err.message : err);
    }
  }

  // Mark all events as notified (including low-priority ones)
  const ids = rows.map(r => r.id);
  // D1 doesn't support IN with bind params easily — batch update
  for (const id of ids) {
    await env.db.prepare("UPDATE events SET notified = 1 WHERE id = ?").bind(id).run();
  }

  const summary = [
    critical.length > 0 ? `${critical.length} critical` : null,
    digestable.length > 0 ? `${digestable.length} digest` : null,
    `${ids.length - critical.length - digestable.length} suppressed`,
  ].filter(Boolean).join(', ');
  console.log(`[argus] Processed ${ids.length} events: ${summary}`);

  // ── Prune old events (daily, piggybacks on hourly run) ──
  await pruneOldEvents(env.db);
}

// ─── Event Pruning ───────────────────────────────────────────
// Deletes notified events older than 30 days. Runs at most once per 24h.

const RETENTION_DAYS = 30;
const PRUNE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function pruneOldEvents(db: D1Database): Promise<void> {
  const lastPrune = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'argus_prune'"
  ).first<{ received_at: string }>();

  if (lastPrune) {
    const elapsed = Date.now() - new Date(lastPrune.received_at + 'Z').getTime();
    if (elapsed < PRUNE_COOLDOWN_MS) return;
  }

  const result = await db.prepare(
    `DELETE FROM events WHERE notified = 1 AND ts < datetime('now', '-${RETENTION_DAYS} days')`
  ).run();

  const pruned = result.meta?.changes ?? 0;
  if (pruned > 0) {
    console.log(`[argus] Pruned ${pruned} events older than ${RETENTION_DAYS}d`);
  }

  // Also prune consumed digest_sections older than 7 days
  await db.prepare(
    "DELETE FROM digest_sections WHERE consumed = 1 AND created_at < datetime('now', '-7 days')"
  ).run();

  // Also prune stale ARGUS cooldown entries from web_events (older than 30d)
  await db.prepare(
    "DELETE FROM web_events WHERE event_id LIKE 'argus_%' AND received_at < datetime('now', '-30 days')"
  ).run();

  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('argus_prune', datetime('now'))"
  ).run();
}

// ─── Helpers ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
