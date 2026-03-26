import { type EdgeEnv } from '../dispatch.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import {
  sendDailyDigest,
  type DigestTask,
  type DigestHealthCheck,
  type DigestEventNotification,
  type DigestAgendaItem,
  type DigestServiceAlert,
  type DigestSections,
} from '../../email.js';

// ─── Daily Digest ──────────────────────────────────────────────
// Consolidates operator notifications into one daily email at 09:00 UTC (4:00 AM CT).
// Reads accumulated digest_sections, cc_tasks, operator_log, and agenda.
// Operator log runs at 08:00 UTC to generate content before this fires.

export async function runDailyDigest(env: EdgeEnv): Promise<void> {
  // Time gate: fire at 09:00 UTC (4:00 AM CT)
  const now = new Date();
  if (now.getUTCHours() !== 9) return;

  // Cooldown: 22 hours since last digest
  const lastDigest = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'daily_digest'"
  ).first<{ received_at: string }>();

  if (lastDigest) {
    const elapsed = Date.now() - new Date(lastDigest.received_at + 'Z').getTime();
    if (elapsed < 22 * 60 * 60 * 1000) return;
  }

  if (!env.resendApiKey) {
    console.log('[digest] Skipping — no Resend API key');
    return;
  }

  // ── Gather data ──

  // 1. Accumulated health checks from digest_sections
  const healthRows = await env.db.prepare(
    "SELECT payload FROM digest_sections WHERE consumed = 0 AND section = 'health_check' ORDER BY created_at ASC"
  ).all<{ payload: string }>();

  const rawHealthChecks: DigestHealthCheck[] = healthRows.results.map(r => {
    try { return JSON.parse(r.payload) as DigestHealthCheck; }
    catch { return null; }
  }).filter((h): h is DigestHealthCheck => h !== null);

  // Deduplicate health checks by check name — keep only the latest entry (#309).
  // Multiple heartbeat runs can queue the same check (e.g. stale_agenda_151) across
  // different digest_sections rows. We flatten all checks, dedup by name (last wins
  // since rows are ordered ASC by created_at), then re-group by severity/timestamp.
  const healthChecks = deduplicateHealthChecks(rawHealthChecks);

  // 1b. ARGUS event notifications from digest_sections
  const eventRows = await env.db.prepare(
    "SELECT payload FROM digest_sections WHERE consumed = 0 AND section = 'event_notification' ORDER BY created_at ASC"
  ).all<{ payload: string }>();

  const eventNotifications: DigestEventNotification[] = eventRows.results.flatMap(r => {
    try {
      const parsed = JSON.parse(r.payload);
      // Phase 2 queues { type: 'argus_events', events: [...] }
      if (parsed.events) return parsed.events as DigestEventNotification[];
      // Phase 3 queues { type: 'argus_patterns', patterns: [...] }
      if (parsed.patterns) return (parsed.patterns as Array<{ pattern: string; severity: string; summary: string; detail: string }>).map(p => ({
        source: 'argus',
        event_type: p.pattern,
        summary: p.summary,
        priority: p.severity,
        ts: parsed.timestamp ?? new Date().toISOString(),
      }));
      return [];
    } catch { return []; }
  });

  // 1c. Memory reflections from digest_sections (weekly, queued by reflection.ts)
  const reflectionRows = await env.db.prepare(
    "SELECT payload FROM digest_sections WHERE consumed = 0 AND section = 'memory_reflection' ORDER BY created_at DESC LIMIT 1"
  ).all<{ payload: string }>();

  let memoryReflection: string | null = null;
  if (reflectionRows.results.length > 0) {
    try {
      const parsed = JSON.parse(reflectionRows.results[0].payload);
      memoryReflection = parsed.reflection ?? null;
    } catch { /* skip */ }
  }

  // 1d. Cognitive metrics from digest_sections (daily, queued by cognitive-metrics.ts)
  const metricsRows = await env.db.prepare(
    "SELECT payload FROM digest_sections WHERE consumed = 0 AND section = 'cognitive_metrics' ORDER BY created_at DESC LIMIT 1"
  ).all<{ payload: string }>();

  let cognitiveMetrics: {
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
  } | null = null;

  if (metricsRows.results.length > 0) {
    try {
      cognitiveMetrics = JSON.parse(metricsRows.results[0].payload);
    } catch { /* skip */ }
  }

  // 1e. Analytics from digest_sections (daily, queued by argus-analytics.ts)
  const analyticsRows = await env.db.prepare(
    "SELECT payload FROM digest_sections WHERE consumed = 0 AND section = 'analytics' ORDER BY created_at DESC LIMIT 1"
  ).all<{ payload: string }>();

  let analytics: {
    sessions_7d: number;
    sessions_prior_7d: number;
    users_7d: number;
    bounce_rate_7d: number;
    top_pages: Array<{ path: string; sessions: number; bounce_rate: number }>;
    top_sources: Array<{ source: string; medium: string; sessions: number }>;
    insights: string[];
  } | null = null;

  if (analyticsRows.results.length > 0) {
    try { analytics = JSON.parse(analyticsRows.results[0].payload); } catch { /* skip */ }
  }

  // 1f. Developer activity from digest_sections (daily, queued by dev-activity.ts)
  const devActivityRows = await env.db.prepare(
    "SELECT payload FROM digest_sections WHERE consumed = 0 AND section = 'dev_activity' ORDER BY created_at DESC LIMIT 1"
  ).all<{ payload: string }>();

  let devActivity: DigestSections['devActivity'] = null;
  if (devActivityRows.results.length > 0) {
    try { devActivity = JSON.parse(devActivityRows.results[0].payload); } catch { /* skip */ }
  }

  // 1g. Service alerts from digest_sections (visual_qa, codebeast, etc.)
  const serviceAlertRows = await env.db.prepare(
    "SELECT section, payload FROM digest_sections WHERE consumed = 0 AND section NOT IN ('health_check', 'event_notification', 'memory_reflection', 'cognitive_metrics', 'analytics') ORDER BY created_at ASC"
  ).all<{ section: string; payload: string }>();

  const serviceAlerts: DigestServiceAlert[] = serviceAlertRows.results.flatMap(r => {
    try {
      const parsed = JSON.parse(r.payload);
      return [{ source: parsed.source ?? r.section, severity: parsed.severity ?? 'medium', summary: parsed.summary ?? '', detail: parsed.detail ?? '', findingsCount: parsed.findings?.length ?? 0 }];
    } catch { return []; }
  });

  // 2. Completed/failed/proposed tasks since last digest (24h)
  const since = lastDigest?.received_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [completedResult, failedResult, proposedResult] = await Promise.all([
    env.db.prepare(
      "SELECT id, title, repo, status, authority, category, exit_code, error, result, pr_url, completed_at FROM cc_tasks WHERE status = 'completed' AND completed_at > ? ORDER BY completed_at DESC"
    ).bind(since).all<DigestTask>(),
    env.db.prepare(
      "SELECT id, title, repo, status, authority, category, exit_code, error, result, pr_url, completed_at FROM cc_tasks WHERE status = 'failed' AND completed_at > ? ORDER BY completed_at DESC"
    ).bind(since).all<DigestTask>(),
    env.db.prepare(
      "SELECT id, title, repo, status, authority, category, exit_code, error, result, pr_url, completed_at FROM cc_tasks WHERE authority = 'proposed' AND status = 'pending' ORDER BY created_at ASC"
    ).all<DigestTask>(),
  ]);

  // 3. Latest operator log entry (generated at 08:00 UTC)
  const logEntry = await env.db.prepare(
    "SELECT content FROM operator_log ORDER BY created_at DESC LIMIT 1"
  ).first<{ content: string }>();

  // Only include if it was generated in the last 24h
  let operatorLog: string | null = null;
  if (logEntry) {
    const logRow = await env.db.prepare(
      "SELECT content FROM operator_log WHERE created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 1"
    ).first<{ content: string }>();
    operatorLog = logRow?.content ?? null;
  }

  // 4. Active agenda items (include created_at for proposal expiry countdown)
  const agendaResult = await env.db.prepare(
    "SELECT id, item, priority, context, created_at FROM agent_agenda WHERE status = 'active' ORDER BY priority ASC"
  ).all<DigestAgendaItem>();

  // 5. BizOps open interactions (non-fatal)
  let bizopsInteractions: number | null = null;
  try {
    if (env.bizopsToken && env.bizopsFetcher) {
      const client = new McpClient({
        url: operatorConfig.integrations.bizops.fallbackUrl,
        token: env.bizopsToken,
        prefix: 'bizops',
        fetcher: env.bizopsFetcher,
        rpcPath: '/rpc',
      });
      const dashResult = await Promise.race([
        client.callTool('dashboard_summary', {}),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      if (dashResult && typeof dashResult === 'object') {
        const content = (dashResult as { content?: Array<{ text?: string }> }).content;
        if (content?.[0]?.text) {
          const parsed = JSON.parse(content[0].text);
          bizopsInteractions = parsed.open_interactions ?? parsed.openInteractions ?? null;
        }
      }
    }
  } catch {
    // Non-fatal — skip BizOps data
  }

  const sections: DigestSections = {
    completedTasks: completedResult.results,
    failedTasks: failedResult.results,
    proposedTasks: proposedResult.results,
    operatorLog,
    healthChecks,
    eventNotifications,
    memoryReflection,
    cognitiveMetrics,
    analytics,
    devActivity,
    serviceAlerts,
    agendaItems: agendaResult.results,
    bizopsInteractions,
  };

  // Check if there's anything to report
  const hasContent =
    sections.eventNotifications.length > 0 ||
    sections.serviceAlerts.length > 0 ||
    sections.completedTasks.length > 0 ||
    sections.failedTasks.length > 0 ||
    sections.proposedTasks.length > 0 ||
    sections.operatorLog !== null ||
    sections.healthChecks.length > 0 ||
    sections.agendaItems.some(a => a.priority === 'high');

  if (!hasContent) {
    console.log('[digest] Skipping — no content to report');
    // Still update watermark so we don't re-check immediately
    await env.db.prepare(
      "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('daily_digest', datetime('now'))"
    ).run();
    return;
  }

  // ── Send digest email ──
  await sendDailyDigest(
    { resendApiKey: env.resendApiKey, resendApiKeyPersonal: env.resendApiKeyPersonal },
    sections,
    env.notifyEmail,
  );

  // Mark digest_sections as consumed
  await env.db.prepare(
    "UPDATE digest_sections SET consumed = 1 WHERE consumed = 0"
  ).run();

  // Update watermark
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('daily_digest', datetime('now'))"
  ).run();

  console.log(`[digest] Daily digest sent: ${sections.completedTasks.length} completed, ${sections.failedTasks.length} failed, ${sections.proposedTasks.length} proposed, ${sections.healthChecks.length} health checks`);
}

// ─── Health Check Deduplication (#309) ──────────────────────
// Each DigestHealthCheck has { severity, checks: [{name, status, detail}], timestamp }.
// Multiple heartbeat runs can produce entries with the same check name (e.g. stale_agenda_151).
// Flatten all individual checks, keep only the latest per name, then re-group into a single
// DigestHealthCheck entry so the email renders each issue exactly once.

function deduplicateHealthChecks(raw: DigestHealthCheck[]): DigestHealthCheck[] {
  if (raw.length === 0) return [];

  // Flatten: attach parent severity/timestamp to each individual check
  const seen = new Map<string, { name: string; status: string; detail: string; severity: string; timestamp: string }>();
  for (const group of raw) {
    for (const check of group.checks) {
      // Later entries overwrite earlier ones (rows are ASC by created_at)
      seen.set(check.name, {
        ...check,
        severity: group.severity,
        timestamp: group.timestamp,
      });
    }
  }

  if (seen.size === 0) return [];

  // Re-group deduped checks into a single DigestHealthCheck.
  // Use the highest severity and latest timestamp from the surviving checks.
  const dedupedChecks = Array.from(seen.values());
  const severityOrder: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  const maxSeverity = dedupedChecks.reduce((best, c) =>
    (severityOrder[c.severity] ?? 0) > (severityOrder[best] ?? 0) ? c.severity : best,
    'low',
  );
  const latestTs = dedupedChecks.reduce((latest, c) =>
    c.timestamp > latest ? c.timestamp : latest,
    dedupedChecks[0].timestamp,
  );

  return [{
    severity: maxSeverity,
    checks: dedupedChecks.map(c => ({ name: c.name, status: c.status, detail: c.detail })),
    timestamp: latestTs,
  }];
}
