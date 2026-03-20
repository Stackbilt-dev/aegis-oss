import { createIntent, dispatch, type EdgeEnv } from '../dispatch.js';
import { getActiveAgendaItems, getRecentHeartbeats, PROPOSED_ACTION_PREFIX } from '../memory/index.js';
import { type StaleHighItem } from './escalation.js';

export const ALERT_SEVERITIES = new Set(['medium', 'high', 'critical']);

/** Hours between heartbeat runs (directive: reduce from 1h to 6h) */
const HEARTBEAT_CADENCE_HOURS = 6;

/** Consecutive medium runs before severity decays to LOW (directive: 10+ → downgrade) */
const CHRONIC_MEDIUM_THRESHOLD = 10;

/** Once decayed to LOW, only re-surface weekly (runs at 6h cadence = 28 runs/week) */
const LOW_RESURFACE_INTERVAL = 28;

export type CheckStatus = 'ok' | 'warn' | 'alert';
export interface HeartbeatCheck { name: string; status: CheckStatus; detail: string }

export async function runHeartbeat(env: EdgeEnv, staleHighItems: StaleHighItem[] = []): Promise<void> {
  // Cadence gate: only run every 6 hours (0, 6, 12, 18 UTC)
  // Skip at 12 UTC — daily digest covers that slot
  const hour = new Date().getUTCHours();
  if (hour % HEARTBEAT_CADENCE_HOURS !== 0 || hour === 12) return;

  // Load prior heartbeat history for trend context (#6)
  const priorRuns = await getRecentHeartbeats(env.db, 12);
  const priorChecksMap = new Map<string, CheckStatus[]>();
  for (const run of priorRuns) {
    const checks = JSON.parse(run.checks_json) as HeartbeatCheck[];
    for (const c of checks) {
      const history = priorChecksMap.get(c.name) ?? [];
      history.push(c.status);
      priorChecksMap.set(c.name, history);
    }
  }

  const intent = createIntent('scheduled', 'heartbeat check', {
    source: { channel: 'internal', threadId: 'scheduled' },
    classified: 'heartbeat',
    costCeiling: 'free',
  });
  const result = await dispatch(intent, env);
  const meta = result.meta as { actionable?: boolean; severity?: string; checks?: unknown[] } | undefined;

  const actionable = meta?.actionable ?? false;
  const severity = meta?.severity ?? 'none';
  const checks = (meta?.checks ?? []) as HeartbeatCheck[];

  const checksJson = JSON.stringify(checks);

  await env.db.prepare(
    'INSERT INTO heartbeat_results (actionable, severity, summary, checks_json) VALUES (?, ?, ?, ?)'
  ).bind(
    actionable ? 1 : 0,
    severity,
    result.text.slice(0, 500),
    checksJson,
  ).run();

  // Payload dedup: if checks are identical to the last run, suppress all email/digest writes.
  // Only recording the result above (for trend history) and agenda sync still proceed.
  const lastRun = priorRuns[0];
  if (lastRun && lastRun.checks_json === checksJson) {
    console.log('[heartbeat] Payload identical to previous run — suppressing email/digest');
    return;
  }

  // Classify each check as new / persisting / escalated / resolved (#6)
  // emailableChecks: new + escalated (triggers alert email)
  // agendaChecks: new + escalated + persisting (synced to agenda, but no re-email for persisters)
  const { emailableChecks, agendaChecks, resolved } = classifyCheckDeltas(checks, priorChecksMap);

  // Per-check email cooldown (24h) — prevents re-alerting when checks flap due to
  // transient BizOps timeouts or data fluctuations resetting the history window
  const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const dedupedEmailChecks: HeartbeatCheck[] = [];
  for (const check of emailableChecks) {
    const eventKey = `heartbeat_alert_${check.name}`;
    const lastAlert = await env.db.prepare(
      "SELECT received_at FROM web_events WHERE event_id = ?"
    ).bind(eventKey).first<{ received_at: string }>();
    if (lastAlert && (Date.now() - new Date(lastAlert.received_at + 'Z').getTime()) < ALERT_COOLDOWN_MS) {
      continue; // already alerted within 24h
    }
    dedupedEmailChecks.push(check);
  }

  await syncChecksToAgenda(env.db, agendaChecks);

  // Auto-resolve agenda items for checks that cleared
  await resolveAgendaForChecks(env.db, resolved);

  // Inject stale escalation items as heartbeat checks so they appear in the same email
  if (staleHighItems.length > 0) {
    for (const s of staleHighItems) {
      const alreadyTracked = dedupedEmailChecks.some(c => c.name === `stale_agenda_${s.id}`);
      if (!alreadyTracked) {
        dedupedEmailChecks.push({
          name: `stale_agenda_${s.id}`,
          status: 'warn',
          detail: `${s.item.slice(0, 120)} (${Math.floor(s.ageDays)}d stale)`,
        });
      }
    }
  }

  // Ensure severity covers escalation items even if LLM heartbeat was clean
  const effectiveSeverity = dedupedEmailChecks.length > 0 && !ALERT_SEVERITIES.has(severity)
    ? 'medium'
    : severity;

  // All heartbeat alerts — write to digest_sections for daily digest consolidation.
  // No standalone emails. Critical ARGUS events (CI failures, payment issues) handle
  // real-time alerting; heartbeat checks are not time-sensitive enough for inbox spam.
  if (dedupedEmailChecks.length > 0 && ALERT_SEVERITIES.has(effectiveSeverity)) {
    const payload = JSON.stringify({
      severity: effectiveSeverity,
      checks: dedupedEmailChecks,
      timestamp: new Date().toISOString(),
    });
    await env.db.prepare(
      "INSERT INTO digest_sections (section, payload) VALUES ('health_check', ?)"
    ).bind(payload).run();
    // Record per-check cooldown timestamps
    for (const check of dedupedEmailChecks) {
      const eventKey = `heartbeat_alert_${check.name}`;
      await env.db.prepare(
        "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
      ).bind(eventKey).run();
    }
  }
}

export function classifyCheckDeltas(
  current: HeartbeatCheck[],
  priorMap: Map<string, CheckStatus[]>,
): { emailableChecks: HeartbeatCheck[]; agendaChecks: HeartbeatCheck[]; resolved: string[] } {
  const emailableChecks: HeartbeatCheck[] = []; // new + escalated → triggers email
  const agendaChecks: HeartbeatCheck[] = [];    // new + escalated + persisting → agenda sync
  const resolved: string[] = [];

  for (const check of current) {
    const prior = priorMap.get(check.name) ?? [];
    const lastStatus = prior[0]; // most recent prior run

    if (check.status === 'ok') {
      // Was previously warn/alert → now ok = resolved
      if (lastStatus && lastStatus !== 'ok') resolved.push(check.name);
      continue;
    }

    if (!lastStatus || lastStatus === 'ok') {
      // New issue — email + agenda
      emailableChecks.push(check);
      agendaChecks.push(check);
    } else if (check.status === 'alert' && lastStatus === 'warn') {
      // Escalated warn→alert — email + agenda
      emailableChecks.push(check);
      agendaChecks.push(check);
    } else {
      // Persisting — check for chronic medium decay before deciding re-surface cadence
      const allPrior = [lastStatus, ...prior.slice(1)];
      const consecutivePersist = allPrior.filter(s => s !== 'ok').length;

      // Severity decay: medium items persisting 10+ runs are accepted risks.
      // Downgrade to LOW and only re-surface weekly (~28 runs at 6h cadence).
      if (check.status === 'warn' && consecutivePersist >= CHRONIC_MEDIUM_THRESHOLD) {
        if (consecutivePersist > 0 && consecutivePersist % LOW_RESURFACE_INTERVAL === 0) {
          agendaChecks.push({ ...check, detail: `${check.detail} (known risk, weekly check-in — ${consecutivePersist + 1} runs)` });
        }
        // Otherwise fully suppress — operator is aware
      } else if (consecutivePersist > 0 && consecutivePersist % 12 === 0) {
        // Normal persisting items re-surface every 12 runs (~3 days at 6h cadence)
        agendaChecks.push({ ...check, detail: `${check.detail} (persisting ${consecutivePersist + 1} runs)` });
      }
      // Otherwise suppress entirely — already on agenda
    }
  }

  return { emailableChecks, agendaChecks, resolved };
}

export async function syncChecksToAgenda(db: D1Database, checks: HeartbeatCheck[]): Promise<void> {
  for (const check of checks) {
    const existing = await db.prepare(
      "SELECT id FROM agent_agenda WHERE status = 'active' AND item LIKE ?"
    ).bind(`%${check.name}%`).first();
    if (existing) continue;

    // Respect dismissed items — don't re-create if dismissed within the last 7 days.
    // This prevents agenda churn where a known structural condition (e.g. low separation
    // scores) gets re-created every heartbeat cycle after the operator dismisses it.
    const recentlyDismissed = await db.prepare(
      "SELECT id FROM agent_agenda WHERE status = 'dismissed' AND item LIKE ? AND resolved_at > datetime('now', '-7 days')"
    ).bind(`%${check.name}%`).first();
    if (recentlyDismissed) continue;

    // Alert-level checks become proposed actions — AEGIS has a specific recommended step.
    // Warn-level checks are regular agenda items (flag only, no clear action yet).
    const isProposed = check.status === 'alert';
    const item = isProposed
      ? `${PROPOSED_ACTION_PREFIX} ${check.name}: ${check.detail}`
      : `${check.name}: ${check.detail}`;
    const context = isProposed
      ? `Auto-detected by heartbeat. Review in BizOps and resolve the underlying issue, then mark this item done.`
      : 'Auto-detected by heartbeat';

    await db.prepare(
      'INSERT INTO agent_agenda (item, context, priority) VALUES (?, ?, ?)'
    ).bind(item, context, isProposed ? 'high' : 'medium').run();
  }
}

export async function resolveAgendaForChecks(db: D1Database, checkNames: string[]): Promise<void> {
  for (const name of checkNames) {
    await db.prepare(
      "UPDATE agent_agenda SET status = 'done', resolved_at = datetime('now') WHERE status = 'active' AND item LIKE ?"
    ).bind(`%${name}%`).run();
  }
}
