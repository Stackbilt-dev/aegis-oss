// --- Agent Dispatch -- Proactive Inter-Agent Coordination ---
// Runs hourly in the heartbeat phase. Scans recent events, task
// completions, and repo activity, then inboxes the right agent
// without human intervention.
//
// AEGIS is the orchestrator. Agents are specialists:
//   CodeBeast -- adversarial code review
//   MARA     -- colony governance, multi-agent coordination
//   Sera     -- symbolic classification
//
// This module replaces the operator as the manual message bus.

import { type EdgeEnv } from '../dispatch.js';

// --- Agent Capability Registry ---

interface AgentCapability {
  id: string;
  name: string;
  capabilities: string[];
  inboxRecipient: string;
}

const AGENTS: AgentCapability[] = [
  {
    id: 'codebeast',
    name: 'CodeBeast',
    capabilities: ['code_review', 'security_audit', 'adversarial_review', 'fix_suggestion'],
    inboxRecipient: 'codebeast',
  },
  {
    id: 'mara',
    name: 'MARA',
    capabilities: ['governance', 'colony_coordination', 'agent_lifecycle', 'resource_allocation'],
    inboxRecipient: 'mara',
  },
  {
    id: 'sera',
    name: 'Sera',
    capabilities: ['classification', 'symbolic_computation', 'tarotscript', 'intent_analysis'],
    inboxRecipient: 'sera',
  },
];

// --- Inbox Helper ---

async function sendInboxMessage(
  db: D1Database,
  recipient: string,
  msgType: string,
  subject: string,
  body: string,
  channel = 'ops',
): Promise<void> {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO agent_inbox (id, sender, recipient, channel, msg_type, subject, body)
    VALUES (?, 'aegis', ?, ?, ?, ?, ?)
  `).bind(id, recipient, channel, msgType, subject, body).run();
  console.log(`[agent-dispatch] Sent ${msgType} to ${recipient}: ${subject}`);
}

// --- Watermark Helper ---

async function getWatermark(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = ? LIMIT 1"
  ).bind(`dispatch_watermark:${key}`).first<{ received_at: string }>();
  return row?.received_at ?? null;
}

async function setWatermark(db: D1Database, key: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))"
  ).bind(`dispatch_watermark:${key}`).run();
}

// --- Trigger: Merged PRs -> CodeBeast Review ---
// When PRs merge on watched repos, auto-request CodeBeast review.

async function dispatchMergedPrReviews(db: D1Database): Promise<number> {
  const watermark = await getWatermark(db, 'pr_reviews');
  const since = watermark || "datetime('now', '-2 hours')";

  // Find recently merged PRs from ARGUS events
  const events = await db.prepare(`
    SELECT payload, ts FROM events
    WHERE source = 'github'
      AND event_type = 'pull_request.merged'
      AND ts > ?
    ORDER BY ts ASC
    LIMIT 10
  `).bind(since).all<{ payload: string; ts: string }>();

  let dispatched = 0;
  for (const event of events.results ?? []) {
    try {
      const payload = JSON.parse(event.payload);
      const pr = payload.pull_request ?? payload;
      const repo = (payload.repository?.full_name as string) ?? '';
      const prNumber = pr.number ?? 0;
      const title = pr.title ?? '';
      const additions = pr.additions ?? 0;
      const deletions = pr.deletions ?? 0;
      const totalLoc = additions + deletions;

      // Skip tiny PRs (< 10 LOC) and auto-branch PRs from taskrunner
      if (totalLoc < 10) continue;
      if (title.startsWith('[auto]')) continue;

      // Dedup: check if we already requested review for this PR
      const existingMsg = await db.prepare(
        "SELECT 1 FROM agent_inbox WHERE sender = 'aegis' AND recipient = 'codebeast' AND subject LIKE ? LIMIT 1"
      ).bind(`%${repo}#${prNumber}%`).first();
      if (existingMsg) continue;

      await sendInboxMessage(
        db, 'codebeast', 'context_request',
        `Review: ${repo}#${prNumber} -- ${title}`,
        `PR merged: ${title}\nRepo: ${repo}\nPR: #${prNumber}\nLOC: +${additions}/-${deletions}\n\nPlease run adversarial review on this merge. Flag security issues, correctness problems, and test gaps. Post findings back via inbox as alert (critical) or task_proposal (suggested fix).`,
        'code-review',
      );
      dispatched++;
    } catch {
      // Skip malformed events
    }
  }

  if (dispatched > 0 || (events.results?.length ?? 0) > 0) {
    await setWatermark(db, 'pr_reviews');
  }

  return dispatched;
}

// --- Trigger: Completed Tasks -> Status Updates ---
// When cc_tasks complete, notify relevant agents if the work
// touches their domain.

async function dispatchTaskCompletions(db: D1Database): Promise<number> {
  const watermark = await getWatermark(db, 'task_completions');
  const since = watermark || "datetime('now', '-2 hours')";

  const tasks = await db.prepare(`
    SELECT id, title, repo, category, result, exit_code
    FROM cc_tasks
    WHERE status = 'completed'
      AND completed_at > ?
      AND exit_code = 0
    ORDER BY completed_at ASC
    LIMIT 10
  `).bind(since).all<{
    id: string; title: string; repo: string; category: string;
    result: string | null; exit_code: number;
  }>();

  let dispatched = 0;
  for (const task of tasks.results ?? []) {
    // Route to agent based on repo/category
    const repo = task.repo.toLowerCase();

    // TarotScript work -> notify Sera
    if (repo.includes('tarotscript') || repo.includes('tarot')) {
      await sendInboxMessage(
        db, 'sera', 'status_update',
        `Task completed: ${task.title.slice(0, 100)}`,
        `Repo: ${task.repo}\nCategory: ${task.category}\nResult: ${(task.result ?? '').slice(0, 500)}`,
      );
      dispatched++;
    }

    // Colony OS work -> notify MARA
    if (repo.includes('colony') || repo.includes('colonyos')) {
      await sendInboxMessage(
        db, 'mara', 'status_update',
        `Task completed: ${task.title.slice(0, 100)}`,
        `Repo: ${task.repo}\nCategory: ${task.category}\nResult: ${(task.result ?? '').slice(0, 500)}`,
      );
      dispatched++;
    }
  }

  if (dispatched > 0 || (tasks.results?.length ?? 0) > 0) {
    await setWatermark(db, 'task_completions');
  }

  return dispatched;
}

// --- Trigger: Failed Tasks -> Alert Relevant Agent ---
// When tasks fail repeatedly on the same repo, alert the agent
// that owns that domain.

async function dispatchTaskFailures(db: D1Database): Promise<number> {
  // Find repos with 2+ failures in last 24h
  const failClusters = await db.prepare(`
    SELECT repo, COUNT(*) as fail_count, GROUP_CONCAT(title, ' | ') as titles
    FROM cc_tasks
    WHERE status = 'failed'
      AND completed_at > datetime('now', '-24 hours')
    GROUP BY repo
    HAVING COUNT(*) >= 2
    LIMIT 5
  `).all<{ repo: string; fail_count: number; titles: string }>();

  let dispatched = 0;
  for (const cluster of failClusters.results ?? []) {
    // Dedup: don't re-alert for same cluster
    const existing = await db.prepare(
      "SELECT 1 FROM agent_inbox WHERE sender = 'aegis' AND subject LIKE ? AND created_at > datetime('now', '-24 hours') LIMIT 1"
    ).bind(`%${cluster.repo}%failure cluster%`).first();
    if (existing) continue;

    // Route to CodeBeast for code-related failure analysis
    await sendInboxMessage(
      db, 'codebeast', 'alert',
      `${cluster.repo}: failure cluster (${cluster.fail_count} tasks)`,
      `${cluster.fail_count} tasks failed in ${cluster.repo} in the last 24h.\n\nTitles:\n${cluster.titles.split(' | ').map(t => `- ${t}`).join('\n')}\n\nInvestigate common root cause. Check for environment issues, missing dependencies, or systematic test failures.`,
      'code-review',
    );
    dispatched++;
  }

  return dispatched;
}

// --- Main Entry Point ---

export async function runAgentDispatch(env: EdgeEnv): Promise<void> {
  if (!env.githubToken) {
    console.log('[agent-dispatch] Skipped: missing githubToken');
    return;
  }

  let totalDispatched = 0;

  // 1. Merged PRs -> CodeBeast review
  const prReviews = await dispatchMergedPrReviews(env.db);
  totalDispatched += prReviews;

  // 2. Completed tasks -> relevant agent notifications
  const taskNotifs = await dispatchTaskCompletions(env.db);
  totalDispatched += taskNotifs;

  // 3. Failure clusters -> CodeBeast alert
  const failAlerts = await dispatchTaskFailures(env.db);
  totalDispatched += failAlerts;

  if (totalDispatched > 0) {
    console.log(`[agent-dispatch] Dispatched ${totalDispatched} messages (PR reviews: ${prReviews}, task notifs: ${taskNotifs}, fail alerts: ${failAlerts})`);
  }
}
