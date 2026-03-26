// ─── ARGUS Phase 3: Event-Driven Actions ─────────────────────
// Fires autonomous actions in response to webhook events at
// ingestion time (not on the hourly cron). Responses are near-instant.
//
// Action rules are declarative: { event pattern → action + guardrails }.
// All actions are logged to D1 for audit. Rate-limited per action type.
//
// Authority model:
//   READ_ONLY  — label, comment, create agenda item (auto)
//   MUTATION   — close issue, merge PR (requires operator approval)

import { commentOnIssue, addLabelsToIssue, resolveRepoName } from '../github.js';
import {
  ensureOnBoard,
  moveBoardItemLocal,
} from './board.js';

// ─── Types ────────────────────────────────────────────────────

interface ActionContext {
  githubToken: string;
  db: D1Database;
}

interface WebhookEnvelope {
  source: string;
  event_type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface ActionResult {
  action: string;
  target: string;
  success: boolean;
  detail?: string;
}

// ─── Rate Limiting ────────────────────────────────────────────

const MAX_ACTIONS_PER_HOUR = 10;
const RATE_LIMIT_KEY = 'argus_action_count';

async function checkRateLimit(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = ?"
  ).bind(RATE_LIMIT_KEY).first<{ received_at: string }>();

  if (!row) return true; // No record = first action

  // Parse stored value: "count:timestamp"
  const [countStr, tsStr] = row.received_at.split('|');
  const count = parseInt(countStr, 10) || 0;
  const ts = new Date(tsStr).getTime();

  // Reset if older than 1 hour
  if (Date.now() - ts > 60 * 60 * 1000) return true;

  return count < MAX_ACTIONS_PER_HOUR;
}

async function incrementRateLimit(db: D1Database): Promise<void> {
  const row = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = ?"
  ).bind(RATE_LIMIT_KEY).first<{ received_at: string }>();

  let count = 1;
  let ts = new Date().toISOString();

  if (row) {
    const [countStr, tsStr] = row.received_at.split('|');
    const oldTs = new Date(tsStr).getTime();
    if (Date.now() - oldTs < 60 * 60 * 1000) {
      count = (parseInt(countStr, 10) || 0) + 1;
      ts = tsStr; // Keep original window start
    }
  }

  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, ?)"
  ).bind(RATE_LIMIT_KEY, `${count}|${ts}`).run();
}

// ─── Action Log ───────────────────────────────────────────────

async function logAction(db: D1Database, result: ActionResult, _envelope: WebhookEnvelope): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO web_events (event_id, received_at) VALUES (?, datetime('now'))`
    ).bind(`argus_action_${Date.now()}_${result.action}`).run();
    console.log(`[argus-actions] ${result.action} → ${result.target}: ${result.success ? 'ok' : 'failed'}${result.detail ? ` (${result.detail})` : ''}`);
  } catch {
    // Non-fatal
  }
}

// ─── Dedup ────────────────────────────────────────────────────
// Prevent duplicate actions on the same event (e.g., GitHub retries)

async function hasActed(db: D1Database, eventKey: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT event_id FROM web_events WHERE event_id = ?"
  ).bind(`argus_acted_${eventKey}`).first();
  return row !== null;
}

async function markActed(db: D1Database, eventKey: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
  ).bind(`argus_acted_${eventKey}`).run();
}

// ─── GitHub Actions ───────────────────────────────────────────

async function handleIssueOpened(ctx: ActionContext, payload: Record<string, unknown>): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const issue = payload.issue as Record<string, unknown> | undefined;
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string | undefined;
  if (!issue || !repo) return results;

  const number = issue.number as number;
  const title = (issue.title as string) ?? '';
  const body = (issue.body as string) ?? '';
  const author = (issue.user as Record<string, unknown>)?.login as string ?? '';
  const combined = `${title} ${body}`.toLowerCase();

  // Skip issues created by bots
  if (author.includes('[bot]')) return results;

  // Auto-label based on keywords
  const labels: string[] = [];
  if (combined.includes('bug') || combined.includes('error') || combined.includes('broken') || combined.includes('crash')) {
    labels.push('bug');
  }
  if (combined.includes('feature') || combined.includes('request') || combined.includes('enhancement')) {
    labels.push('enhancement');
  }
  if (combined.includes('question') || combined.includes('how do') || combined.includes('help')) {
    labels.push('question');
  }
  if (combined.includes('docs') || combined.includes('documentation') || combined.includes('readme')) {
    labels.push('documentation');
  }

  if (labels.length > 0) {
    try {
      await addLabelsToIssue(ctx.githubToken, repo, number, labels);
      results.push({ action: 'label', target: `${repo}#${number}`, success: true, detail: labels.join(', ') });
    } catch (err) {
      results.push({ action: 'label', target: `${repo}#${number}`, success: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // Auto-acknowledge external issues (not from the operator's bot)
  const ack = `Thanks for opening this issue! AEGIS has triaged it${labels.length > 0 ? ` and applied labels: ${labels.map(l => `\`${l}\``).join(', ')}` : ''}. A maintainer will review shortly.\n\n*[AEGIS] — automated triage*`;
  try {
    await commentOnIssue(ctx.githubToken, repo, number, ack);
    results.push({ action: 'acknowledge', target: `${repo}#${number}`, success: true });
  } catch (err) {
    results.push({ action: 'acknowledge', target: `${repo}#${number}`, success: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return results;
}

async function handlePrOpened(ctx: ActionContext, payload: Record<string, unknown>): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string | undefined;
  if (!pr || !repo) return results;

  const number = pr.number as number;
  const author = (pr.user as Record<string, unknown>)?.login as string ?? '';

  // Skip bot PRs and auto/ branches
  const head = (pr.head as Record<string, unknown>)?.ref as string ?? '';
  if (author.includes('[bot]') || head.startsWith('auto/') || head.startsWith('aegis/')) return results;

  // Acknowledge external PRs
  const ack = `Thanks for the PR! AEGIS will run initial checks. A maintainer will review shortly.\n\n*[AEGIS] — automated triage*`;
  try {
    await commentOnIssue(ctx.githubToken, repo, number, ack);
    results.push({ action: 'acknowledge_pr', target: `${repo}#${number}`, success: true });
  } catch (err) {
    results.push({ action: 'acknowledge_pr', target: `${repo}#${number}`, success: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return results;
}

async function handleCiFailure(ctx: ActionContext, payload: Record<string, unknown>): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const checkRun = payload.check_run as Record<string, unknown> | undefined;
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string | undefined;
  if (!checkRun || !repo) return results;

  const conclusion = checkRun.conclusion as string;
  if (conclusion !== 'failure') return results;

  // Find associated PRs
  const pullRequests = checkRun.pull_requests as Array<Record<string, unknown>> | undefined;
  if (!pullRequests || pullRequests.length === 0) return results;

  for (const pr of pullRequests) {
    const prNumber = pr.number as number;
    if (!prNumber) continue;

    const name = (checkRun.name as string) ?? 'CI';
    const comment = `CI check **${name}** failed on this PR. Please review the [check output](${(checkRun.html_url as string) ?? ''}).\n\n*[AEGIS] — CI watcher*`;
    try {
      await commentOnIssue(ctx.githubToken, repo, prNumber, comment);
      results.push({ action: 'ci_failure_comment', target: `${repo}#${prNumber}`, success: true, detail: name });
    } catch (err) {
      results.push({ action: 'ci_failure_comment', target: `${repo}#${prNumber}`, success: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}

// ─── Stripe Actions ───────────────────────────────────────────

async function handleStripeEvent(ctx: ActionContext, event_type: string, payload: Record<string, unknown>): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  // Create tracking entries for payment events (lightweight D1 writes)
  const data = payload.data as Record<string, unknown> | undefined;
  const obj = data?.object as Record<string, unknown> | undefined;

  if (event_type === 'customer.subscription.created') {
    const customerId = (obj?.customer as string) ?? 'unknown';
    await ctx.db.prepare(
      "INSERT INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
    ).bind(`argus_stripe_new_sub_${customerId}_${Date.now()}`).run();
    results.push({ action: 'track_new_subscription', target: customerId, success: true });
  }

  if (event_type === 'customer.subscription.deleted') {
    const customerId = (obj?.customer as string) ?? 'unknown';
    await ctx.db.prepare(
      "INSERT INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
    ).bind(`argus_stripe_churn_${customerId}_${Date.now()}`).run();
    results.push({ action: 'track_churn', target: customerId, success: true });
  }

  return results;
}

// ─── Board Transitions ───────────────────────────────────────

async function handleBoardTransition(ctx: ActionContext, envelope: WebhookEnvelope): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const payload = envelope.payload;
  const repo = (payload.repository as Record<string, unknown>)?.full_name as string | undefined;
  if (!repo) return results;

  try {
    const eventType = envelope.event_type;

    // ── Issue closed → mark shipped ──────────────────────
    if (eventType === 'issues.closed') {
      const issue = payload.issue as Record<string, unknown> | undefined;
      if (!issue) return results;
      const number = issue.number as number;
      try {
        await moveBoardItemLocal(ctx.db, repo, number, 'shipped');
        results.push({ action: 'board_move', target: `${repo}#${number}`, success: true, detail: 'shipped' });
      } catch {
        // Board not configured — non-fatal
      }
    }

    // ── Issue reopened → back to backlog ─────────────────
    if (eventType === 'issues.reopened') {
      const issue = payload.issue as Record<string, unknown> | undefined;
      if (!issue) return results;
      const number = issue.number as number;
      try {
        await moveBoardItemLocal(ctx.db, repo, number, 'backlog');
        results.push({ action: 'board_move', target: `${repo}#${number}`, success: true, detail: 'backlog' });
      } catch {
        // Board not configured — non-fatal
      }
    }

    // ── PR opened — move linked issue to in_progress ─────
    if (eventType === 'pull_request.opened' || eventType === 'pull_request.merged') {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (!pr) return results;
      const body = (pr.body as string) ?? '';
      const title = (pr.title as string) ?? '';
      const combined = `${title} ${body}`;

      // Extract issue references (#NNN)
      const issueRefs = [...combined.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));
      const targetStatus = eventType === 'pull_request.merged' ? 'shipped' as const : 'in_progress' as const;

      for (const issueNum of issueRefs) {
        try {
          await moveBoardItemLocal(ctx.db, repo, issueNum, targetStatus);
          results.push({ action: 'board_move', target: `${repo}#${issueNum}`, success: true, detail: targetStatus });
        } catch {
          // Board not configured — non-fatal
        }
      }
    }

    // ── PR closed (not merged) — move linked issues back ─
    if (eventType === 'pull_request.closed') {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      if (!pr) return results;
      const merged = pr.merged as boolean;
      if (merged) return results; // Handled above as pull_request.merged

      const body = (pr.body as string) ?? '';
      const title = (pr.title as string) ?? '';
      const issueRefs = [...`${title} ${body}`.matchAll(/#(\d+)/g)].map(m => parseInt(m[1], 10));

      for (const issueNum of issueRefs) {
        try {
          await moveBoardItemLocal(ctx.db, repo, issueNum, 'backlog');
          results.push({ action: 'board_move', target: `${repo}#${issueNum}`, success: true, detail: 'backlog' });
        } catch {
          // Board not configured — non-fatal
        }
      }
    }
  } catch (err) {
    console.warn(`[argus-actions] Board transition error: ${err instanceof Error ? err.message : String(err)}`);
    results.push({ action: 'board_transition', target: repo, success: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return results;
}

// ─── Main Dispatcher ──────────────────────────────────────────

export async function dispatchActions(
  envelope: WebhookEnvelope,
  githubToken: string | undefined,
  db: D1Database,
): Promise<void> {
  if (!githubToken) return;

  // Rate limit check
  if (!(await checkRateLimit(db))) {
    console.log('[argus-actions] Rate limit reached — skipping actions');
    return;
  }

  // Dedup check
  const eventKey = `${envelope.source}_${envelope.event_type}_${envelope.timestamp}`;
  if (await hasActed(db, eventKey)) return;

  const ctx: ActionContext = { githubToken, db };
  let results: ActionResult[] = [];

  try {
    // GitHub event routing
    if (envelope.source === 'github') {
      switch (envelope.event_type) {
        case 'issues.opened':
          results = await handleIssueOpened(ctx, envelope.payload);
          break;
        case 'pull_request.opened':
          results = await handlePrOpened(ctx, envelope.payload);
          break;
        case 'check_run.completed':
          results = await handleCiFailure(ctx, envelope.payload);
          break;
      }

      // Board transitions — runs for all GitHub events (issues + PRs)
      const boardResults = await handleBoardTransition(ctx, envelope);
      results = results.concat(boardResults);
    }

    // Stripe event routing
    if (envelope.source === 'stripe') {
      results = await handleStripeEvent(ctx, envelope.event_type, envelope.payload);
    }
  } catch (err) {
    console.error('[argus-actions] Dispatch error:', err instanceof Error ? err.message : String(err));
    return;
  }

  // Log results and update rate limit
  if (results.length > 0) {
    await markActed(db, eventKey);
    for (const result of results) {
      await logAction(db, result, envelope);
      if (result.success) {
        await incrementRateLimit(db);
      }
    }
  }
}
