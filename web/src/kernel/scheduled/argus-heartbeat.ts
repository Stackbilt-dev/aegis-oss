// ARGUS Phase 3: Ambient event heartbeat
// Sweeps the events table for temporal patterns that point-in-time checks miss.
// Runs every 3 hours. No LLM calls — pure D1 queries and threshold logic.
//
// Patterns detected:
// 1. CI failure cluster — N+ failures in a rolling window
// 2. Payment anomaly — charge failures without recent successes
// 3. Event drought — expected source goes silent for too long
// 4. Velocity spike — unusual burst of events from a single source
//
// Findings route through the same notification infrastructure as Phase 2:
// critical → immediate email, high/medium → digest_sections.

import { type EdgeEnv } from '../dispatch.js';
import { resolveEmailProfile } from '../../email.js';
import { operatorConfig } from '../../operator/index.js';

// TODO: Wire correlation analysis into heartbeat pattern detection
import type { CorrelationResult, IncidentCluster, ArgusDiagnosis } from '../argus-correlation.js';

// ─── Configuration ───────────────────────────────────────────

const RUN_CADENCE_HOURS = 3;
const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h cooldown per pattern alert

// Pattern thresholds
const CI_FAILURE_WINDOW_HOURS = 6;
const CI_FAILURE_THRESHOLD = 3;

const PAYMENT_FAILURE_WINDOW_HOURS = 24;

const EVENT_DROUGHT_HOURS: Record<string, number> = {
  github: 72,   // no github events in 3 days = unusual
  stripe: 168,  // no stripe events in 7 days = check billing
};

const VELOCITY_WINDOW_HOURS = 1;
const VELOCITY_THRESHOLD = 50; // 50+ events in 1 hour from single source

// ─── Pattern Detectors ──────────────────────────────────────

interface PatternFinding {
  pattern: string;     // unique key for cooldown dedup
  severity: 'critical' | 'high' | 'medium';
  summary: string;
  detail: string;
}

async function detectCiFailureCluster(db: D1Database): Promise<PatternFinding | null> {
  const result = await db.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE source = 'github'
      AND event_type = 'check_run.completed'
      AND ts > datetime('now', '-${CI_FAILURE_WINDOW_HOURS} hours')
      AND json_extract(payload, '$.check_run.conclusion') = 'failure'
  `).first<{ cnt: number }>();

  const count = result?.cnt ?? 0;
  if (count < CI_FAILURE_THRESHOLD) return null;

  // Get the repos involved
  const repos = await db.prepare(`
    SELECT DISTINCT json_extract(payload, '$.repository.full_name') as repo FROM events
    WHERE source = 'github'
      AND event_type = 'check_run.completed'
      AND ts > datetime('now', '-${CI_FAILURE_WINDOW_HOURS} hours')
      AND json_extract(payload, '$.check_run.conclusion') = 'failure'
    LIMIT 5
  `).all<{ repo: string }>();

  const repoList = repos.results.map(r => r.repo).filter(Boolean).join(', ');

  return {
    pattern: 'ci_failure_cluster',
    severity: count >= 5 ? 'critical' : 'high',
    summary: `${count} CI failures in ${CI_FAILURE_WINDOW_HOURS}h`,
    detail: `${count} check_run failures detected across: ${repoList || 'unknown repos'}. Possible systemic issue — review CI configurations.`,
  };
}

async function detectPaymentAnomaly(db: D1Database): Promise<PatternFinding | null> {
  const failures = await db.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE source = 'stripe'
      AND event_type IN ('charge.failed', 'invoice.payment_failed', 'payment_intent.payment_failed')
      AND ts > datetime('now', '-${PAYMENT_FAILURE_WINDOW_HOURS} hours')
  `).first<{ cnt: number }>();

  if (!failures?.cnt || failures.cnt === 0) return null;

  // Check if there were any successes in the same window
  const successes = await db.prepare(`
    SELECT COUNT(*) as cnt FROM events
    WHERE source = 'stripe'
      AND event_type IN ('charge.succeeded', 'invoice.paid', 'payment_intent.succeeded', 'checkout.session.completed')
      AND ts > datetime('now', '-${PAYMENT_FAILURE_WINDOW_HOURS} hours')
  `).first<{ cnt: number }>();

  // Failures without any successes = likely payment system issue
  if ((successes?.cnt ?? 0) === 0 && failures.cnt >= 2) {
    return {
      pattern: 'payment_anomaly',
      severity: 'critical',
      summary: `${failures.cnt} payment failures, 0 successes in ${PAYMENT_FAILURE_WINDOW_HOURS}h`,
      detail: `All payment attempts are failing with no successful charges. Check Stripe dashboard for account issues, API key validity, or upstream payment processor problems.`,
    };
  }

  // High failure ratio
  const total = failures.cnt + (successes?.cnt ?? 0);
  const failRate = failures.cnt / total;
  if (failRate > 0.5 && failures.cnt >= 3) {
    return {
      pattern: 'payment_high_failure_rate',
      severity: 'high',
      summary: `${Math.round(failRate * 100)}% payment failure rate (${failures.cnt}/${total})`,
      detail: `Payment failure rate above 50% in the last ${PAYMENT_FAILURE_WINDOW_HOURS}h. Not a total outage but warrants investigation.`,
    };
  }

  return null;
}

async function detectEventDrought(db: D1Database): Promise<PatternFinding[]> {
  const findings: PatternFinding[] = [];

  for (const [source, thresholdHours] of Object.entries(EVENT_DROUGHT_HOURS)) {
    // Only check drought if we've ever received events from this source
    const hasHistory = await db.prepare(
      "SELECT id FROM events WHERE source = ? LIMIT 1"
    ).bind(source).first();

    if (!hasHistory) continue;

    const recent = await db.prepare(`
      SELECT COUNT(*) as cnt FROM events
      WHERE source = ? AND ts > datetime('now', '-${thresholdHours} hours')
    `).bind(source).first<{ cnt: number }>();

    if (recent?.cnt === 0) {
      findings.push({
        pattern: `drought_${source}`,
        severity: 'medium',
        summary: `No ${source} events in ${thresholdHours}h`,
        detail: `Expected ${source} webhook events but received none in ${thresholdHours} hours. Check if the webhook is still configured and delivering.`,
      });
    }
  }

  return findings;
}

async function detectVelocitySpike(db: D1Database): Promise<PatternFinding | null> {
  const result = await db.prepare(`
    SELECT source, COUNT(*) as cnt FROM events
    WHERE ts > datetime('now', '-${VELOCITY_WINDOW_HOURS} hours')
    GROUP BY source
    HAVING cnt > ${VELOCITY_THRESHOLD}
    ORDER BY cnt DESC
    LIMIT 1
  `).first<{ source: string; cnt: number }>();

  if (!result) return null;

  return {
    pattern: `velocity_spike_${result.source}`,
    severity: 'high',
    summary: `${result.cnt} ${result.source} events in ${VELOCITY_WINDOW_HOURS}h`,
    detail: `Unusual event velocity from ${result.source} — ${result.cnt} events in the last hour. This could indicate a deploy storm, automated bot activity, or webhook replay.`,
  };
}

// ─── Cooldown ────────────────────────────────────────────────

async function isOnCooldown(db: D1Database, pattern: string): Promise<boolean> {
  const key = `argus_pattern_${pattern}`;
  const last = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = ?"
  ).bind(key).first<{ received_at: string }>();

  if (!last) return false;
  return (Date.now() - new Date(last.received_at + 'Z').getTime()) < COOLDOWN_MS;
}

async function recordCooldown(db: D1Database, pattern: string): Promise<void> {
  const key = `argus_pattern_${pattern}`;
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
  ).bind(key).run();
}

// ─── Notification ────────────────────────────────────────────

async function sendPatternAlert(env: EdgeEnv, findings: PatternFinding[]): Promise<void> {
  if (!env.resendApiKey || !env.notifyEmail) return;

  const sender = resolveEmailProfile(operatorConfig.integrations.email.defaultProfile, {
    resendApiKey: env.resendApiKey,
    resendApiKeyPersonal: env.resendApiKeyPersonal,
  });

  const rows = findings.map(f => `
    <tr>
      <td style="padding:8px 12px;font-size:11px;color:${f.severity === 'critical' ? '#ef4444' : '#f5a623'};border-bottom:1px solid #1a1a2e;text-transform:uppercase">${f.severity}</td>
      <td style="padding:8px 12px;font-size:12px;color:#e0e0e0;border-bottom:1px solid #1a1a2e;font-weight:500">${escapeHtml(f.summary)}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:4px 12px 12px;font-size:11px;color:#888;border-bottom:1px solid #222">${escapeHtml(f.detail)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="background:#0a0a0f;color:#e0e0e0;font-family:system-ui,sans-serif;margin:0;padding:24px">
<div style="max-width:640px;margin:0 auto">
  <div style="background:#1a1a2e;border:1px solid #333;border-left:4px solid #f5a623;border-radius:4px;padding:16px 20px;margin-bottom:20px">
    <p style="margin:0 0 2px;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">ARGUS Pattern Detection</p>
    <p style="margin:0;font-size:16px;font-weight:600;color:#f5a623">${findings.length} Pattern${findings.length > 1 ? 's' : ''} Detected</p>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#111;border:1px solid #222;border-radius:6px">
    <tbody>${rows}</tbody>
  </table>
  <p style="margin:16px 0 0;font-size:11px;color:#444">aegis · argus heartbeat · ${new Date().toISOString()}</p>
</div></body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sender.apiKey}` },
    body: JSON.stringify({
      from: sender.from,
      to: [env.notifyEmail],
      subject: `[ARGUS] ${findings[0].summary}`,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

// ─── Main ────────────────────────────────────────────────────

export async function runArgusHeartbeat(env: EdgeEnv): Promise<void> {
  // Cadence gate: every 3 hours
  const hour = new Date().getUTCHours();
  if (hour % RUN_CADENCE_HOURS !== 0) return;

  // Check if events table has any data yet — skip if empty (no webhooks configured)
  const hasEvents = await env.db.prepare("SELECT id FROM events LIMIT 1").first();
  if (!hasEvents) return;

  // Run all pattern detectors
  const findings: PatternFinding[] = [];

  const ciCluster = await detectCiFailureCluster(env.db);
  if (ciCluster) findings.push(ciCluster);

  const paymentAnomaly = await detectPaymentAnomaly(env.db);
  if (paymentAnomaly) findings.push(paymentAnomaly);

  const droughts = await detectEventDrought(env.db);
  findings.push(...droughts);

  const velocitySpike = await detectVelocitySpike(env.db);
  if (velocitySpike) findings.push(velocitySpike);

  if (findings.length === 0) return;

  // Filter by cooldown
  const actionable: PatternFinding[] = [];
  for (const f of findings) {
    if (!(await isOnCooldown(env.db, f.pattern))) {
      actionable.push(f);
    }
  }

  if (actionable.length === 0) {
    console.log(`[argus-heartbeat] ${findings.length} pattern(s) detected but all on cooldown`);
    return;
  }

  // Split: critical gets immediate email, rest goes to digest
  const critical = actionable.filter(f => f.severity === 'critical');
  const digestable = actionable.filter(f => f.severity !== 'critical');

  if (critical.length > 0) {
    try {
      await sendPatternAlert(env, critical);
      console.log(`[argus-heartbeat] Sent critical alert for ${critical.length} pattern(s)`);
    } catch (err) {
      console.error('[argus-heartbeat] Alert send failed:', err instanceof Error ? err.message : err);
    }
  }

  if (digestable.length > 0) {
    const payload = JSON.stringify({
      type: 'argus_patterns',
      patterns: digestable.map(f => ({
        pattern: f.pattern,
        severity: f.severity,
        summary: f.summary,
        detail: f.detail,
      })),
      timestamp: new Date().toISOString(),
    });
    await env.db.prepare(
      "INSERT INTO digest_sections (section, payload) VALUES ('event_notification', ?)"
    ).bind(payload).run();
  }

  // Record cooldowns for all actioned findings
  for (const f of actionable) {
    await recordCooldown(env.db, f.pattern);
  }

  console.log(`[argus-heartbeat] ${actionable.length} pattern(s) actioned: ${actionable.map(f => f.pattern).join(', ')}`);
}

// ─── Helpers ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
