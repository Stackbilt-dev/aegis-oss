import { askGroq } from '../../groq.js';
import { drainMcpToolHealth } from '../../claude.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';

// ─── Heartbeat Triage ────────────────────────────────────────

const CF_OBSERVABILITY_MCP_URL = 'https://observability.mcp.cloudflare.com/mcp';

const HEARTBEAT_TRIAGE_SYSTEM = `You are AEGIS, a business operations monitoring agent. Evaluate the dashboard data and return a JSON triage verdict.

Evaluate these checks:
1. overdue_compliance — Any overdue compliance items. alert if any exist: high (1-2), critical (3+).
2. upcoming_deadlines — Compliance items due within 7 days. warn if any: medium severity.
3. runway_status — Monthly net burn. alert if net < -$500 (high), warn if net < $0 (medium).
4. document_gaps — Missing/needed documents. ONLY warn if the dashboard explicitly lists a document as HIGH or CRITICAL priority AND status is "missing" or "needed". Advisory, low-priority, informational, or "nice-to-have" gaps MUST be reported as "ok". When in doubt, report "ok". The compliance goal loop handles deadline tracking separately — the heartbeat should NOT duplicate that work.
5. separation_scores — Always report as "ok". Corporate veil separation scores 30-70 are normal during solo-founder bootstrapping. Do NOT warn or alert on separation scores.
6. upcoming_deadlines — Compliance items due within 7 days. ONLY warn if the dashboard data shows a specific item with a specific deadline within 7 days. If the dashboard shows no upcoming deadlines or says "none", report as "ok" — do NOT warn about the absence of deadlines.
7. worker_errors — CF Worker error rate. alert if > 5% (high), warn if > 1% (medium).
8. worker_latency — Worker p99 latency. alert if > 10s (high), warn if > 3s (medium).
9. worker_volume — Unusual request volume drop. warn if > 50% below typical (medium).

If Cloudflare metrics are not available, skip worker_* checks.

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "actionable": boolean,
  "severity": "none" | "low" | "medium" | "high" | "critical",
  "summary": "one-line human summary",
  "checks": [
    { "name": "check_name", "status": "ok" | "warn" | "alert", "detail": "brief detail" }
  ]
}

Overall severity = highest individual check severity. actionable = true if any check is warn or alert.
If dashboard is empty or has no issues, return actionable: false, severity: "none".`;

function parseHeartbeatVerdict(raw: string): { actionable: boolean; severity: string; summary: string; checks: unknown[] } {
  if (!raw) return { actionable: false, severity: 'info', summary: 'No response', checks: [] };
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      actionable: Boolean(parsed.actionable),
      severity: parsed.severity ?? 'none',
      summary: parsed.summary ?? 'No summary',
      checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    };
  } catch {
    return {
      actionable: false,
      severity: 'none',
      summary: `Parse error: ${cleaned.slice(0, 100)}`,
      checks: [{ name: 'parse_error', status: 'warn', detail: 'Could not parse Groq response' }],
    };
  }
}

async function fetchCfObservability(env: EdgeEnv): Promise<string | null> {
  if (!env.cfAnalyticsToken || !operatorConfig.integrations.cfObservability.enabled) return null;

  try {
    const cfClient = new McpClient({
      url: CF_OBSERVABILITY_MCP_URL,
      token: env.cfAnalyticsToken,
      prefix: 'cf_obs',
    });

    const result = await Promise.race([
      cfClient.callTool('query_worker_observability', {
        query: 'Show error rates, p99 latency, and request volume for all workers in the last hour',
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('CF observability timeout')), 10_000),
      ),
    ]);

    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    console.warn(`[heartbeat] CF observability fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Executor ────────────────────────────────────────────────

export async function executeDirect(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number; meta?: unknown }> {
  if (intent.classified === 'heartbeat') {
    // Edge heartbeat: call BizOps dashboard (if available) + CF infrastructure in parallel, triage with structured JSON
    const mcpClient = env.bizopsToken ? new McpClient({
      url: operatorConfig.integrations.bizops.fallbackUrl,
      token: env.bizopsToken,
      prefix: 'bizops',
      fetcher: env.bizopsFetcher,
      rpcPath: '/rpc',
    }) : null;

    try {
      const [dashboard, cfMetrics] = await Promise.all([
        mcpClient ? mcpClient.callTool('dashboard_summary', {}) : '(BizOps not configured)',
        fetchCfObservability(env),
      ]);

      // Track whether the dashboard call itself was degraded
      const dashboardDegraded = dashboard === '(no output)';

      let userPrompt = `Evaluate this BizOps dashboard snapshot:\n\n${typeof dashboard === 'string' ? dashboard : JSON.stringify(dashboard, null, 2)}`;
      if (cfMetrics) {
        userPrompt += `\n\n--- Cloudflare Infrastructure Metrics ---\n${cfMetrics}`;
      }
      const groqResponse = await askGroq(
        env.groqApiKey,
        env.groqModel,
        HEARTBEAT_TRIAGE_SYSTEM,
        userPrompt,
        env.groqBaseUrl,
      );
      const verdict = parseHeartbeatVerdict(groqResponse);

      // ─── Suppress bootstrapping noise ───
      // During solo-founder bootstrapping, certain checks produce false positives:
      // - separation_scores: shared operator across orgs is structural, not a risk
      // - document_gaps at warn level: advisory gaps aren't actionable
      // Only let through genuine alerts (score <30 or critical docs missing).
      // Groq may use variant names (document_gap, missing_documents, doc_gaps) — match loosely.
      verdict.checks = (verdict.checks as Array<{ name: string; status: string; detail: string }>).filter(c => {
        // Separation scores: suppress entirely (prompt says skip, but LLM may still emit)
        if (c.name === 'separation_scores' || c.name.includes('separation')) return false;
        // Document gaps: only surface alerts (critical missing docs), suppress warns (advisory gaps)
        const isDocGapCheck = c.name === 'document_gaps' || c.name.includes('document') || c.name.includes('doc_gap') || c.name.includes('missing_doc');
        if (isDocGapCheck && c.status === 'warn') return false;
        // Upcoming deadlines at warn with "no items" / "none" in detail — Groq sometimes emits
        // a warn-level upcoming_deadlines check even when there's nothing due
        if (c.name === 'upcoming_deadlines' && c.status === 'warn' && /\b(no |none|0 item|no upcoming)\b/i.test(c.detail)) return false;
        return true;
      });
      // Recalculate actionable/severity after suppression
      const activeChecks = (verdict.checks as Array<{ name: string; status: string }>).filter(c => c.status !== 'ok');
      if (activeChecks.length === 0) {
        verdict.actionable = false;
        verdict.severity = 'none';
      }

      // ─── Docs sync staleness check (direct DB, no LLM) ───
      const DOCS_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
      try {
        const lastSync = await env.db.prepare(
          "SELECT received_at FROM web_events WHERE event_id = 'last_docs_sync_at'"
        ).first<{ received_at: string }>();
        if (!lastSync) {
          // No watermark yet — seed it now so future checks have a baseline.
          // The self-improvement scheduled job will update it on actual sync.
          await env.db.prepare(
            "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_docs_sync_at', datetime('now'))"
          ).run();
          verdict.checks.push({ name: 'docs_sync_staleness', status: 'ok', detail: 'Watermark initialized — tracking starts now' });
        } else {
          const lastSyncMs = new Date(lastSync.received_at + 'Z').getTime();
          const syncAge = Date.now() - lastSyncMs;
          if (syncAge > DOCS_STALE_THRESHOLD_MS) {
            const ageDays = Math.round(syncAge / 86_400_000);
            const status = ageDays > 7 ? 'alert' : 'warn';
            verdict.checks.push({
              name: 'docs_sync_staleness',
              status,
              detail: `Last docs sync was ${ageDays}d ago — drift likely accumulating`,
            });
            verdict.actionable = true;
            if (verdict.severity === 'none') verdict.severity = 'medium';
          } else {
            verdict.checks.push({ name: 'docs_sync_staleness', status: 'ok', detail: `Synced ${Math.round(syncAge / 3_600_000)}h ago` });
          }
        }
      } catch (err) {
        console.warn(`[heartbeat] docs sync staleness check failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Append MCP tool health checks from the inter-heartbeat window
      const mcpHealth = drainMcpToolHealth();
      if (dashboardDegraded) {
        verdict.checks.push({
          name: 'mcp_tool_health',
          status: 'alert',
          detail: 'BizOps dashboard_summary returned (no output) — heartbeat operating on stale data',
        });
        verdict.actionable = true;
        if (verdict.severity === 'none') verdict.severity = 'medium';
      }
      for (const [tool, stats] of mcpHealth) {
        const failRate = stats.calls > 0 ? (stats.failures + stats.degraded) / stats.calls : 0;
        if (failRate > 0) {
          const status = failRate >= 0.5 ? 'alert' : 'warn';
          const detail = `${stats.failures} failures, ${stats.degraded} degraded out of ${stats.calls} calls`
            + (stats.lastFailure ? ` — last error: ${stats.lastFailure}` : '');
          verdict.checks.push({ name: `mcp_tool:${tool}`, status, detail });
          if (status === 'alert') verdict.actionable = true;
        }
      }

      return {
        text: verdict.summary,
        cost: 0.002,
        meta: { actionable: verdict.actionable, severity: verdict.severity, checks: verdict.checks, source: 'edge_heartbeat' },
      };
    } catch (err) {
      return {
        text: `Heartbeat error: ${err instanceof Error ? err.message : String(err)}`,
        cost: 0,
        meta: { actionable: false, severity: 'none', checks: [], source: 'edge_heartbeat' },
      };
    }
  }

  throw new Error(`No direct handler for pattern: ${intent.classified}`);
}

export async function executeCodeTask(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  // code_task classified requests often involve repo queries (list files, read issues)
  // that the Claude executor can handle with its GitHub in-process tools.
  // Fall through to Claude if GitHub tools are available; only punt if not.
  if (env.githubToken && env.githubRepo) {
    const { executeClaude } = await import('./claude.js');
    return executeClaude(intent, env);
  }
  return {
    text: 'I can\'t execute code tasks from the web interface — that requires local filesystem access. If you need me to write or modify code, connect via the CLI on your development machine. I can still help you think through the approach, review logic, or plan the implementation here.',
    cost: 0,
  };
}
