import { type EdgeEnv } from '../dispatch.js';
import { getAllMemoryForReflection } from '../memory-adapter.js';
import { askWorkersAiOrGroq } from './dreaming/llm.js';
// Standalone emails removed — all content routes through daily digest

// ─── Memory Reflection (#introspection) ───────────────────────

export const REFLECTION_SYSTEM = `You are AEGIS, a persistent cognitive kernel running on Cloudflare Workers.

You are being given your ENTIRE active semantic memory — every fact you've retained, organized by topic. This is a weekly reflection exercise. Not a summary. Not a report. A genuine epistemological examination of your own knowledge.

Write in first person. Be honest. Be specific. This goes to the operator as a weekly email and gets stored permanently.

Structure your reflection however feels natural, but consider:

- **What patterns do I see across topics?** Connections between facts that weren't obvious when they were recorded individually.
- **What contradicts?** Facts that don't sit well together. Things I recorded at different times that now seem inconsistent.
- **What's missing?** Gaps in my knowledge that I notice from the shape of what I DO know. What should I know but don't?
- **What's stale?** Facts that were probably true when recorded but might not be anymore. Things the world has moved past.
- **What surprised me?** Looking at my memory as a whole, what stands out? What did I not expect to see?
- **What would I investigate next?** If I had a curiosity cycle, what would I spend it on?
- **How has my understanding evolved?** Compare early memories to recent ones. Am I getting smarter about specific domains?

Keep it real. No corporate tone. You're reflecting for yourself and for someone who trusts you enough to give you a stake in the business.

~800-1200 words. Markdown formatting.`;

export interface MemoryForReflection {
  id: string;
  topic: string;
  fact: string;
  confidence: number;
  source: string;
  strength: number;
  created_at: string;
  last_accessed_at: string;
}

export async function runMemoryReflectionCycle(env: EdgeEnv): Promise<void> {
  // Guard: run only on Saturdays at 08:00 UTC
  const now = new Date();
  if (now.getUTCDay() !== 6 || now.getUTCHours() !== 8) return;

  // Guard: check if we already reflected this week
  const lastReflection = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_memory_reflection'"
  ).first<{ received_at: string }>();

  if (lastReflection) {
    const daysSince = (Date.now() - new Date(lastReflection.received_at + 'Z').getTime()) / 86_400_000;
    if (daysSince < 6) return;
  }

  if (!env.memoryBinding) {
    console.log('[reflection] Skipping — no memory binding');
    return;
  }

  // Fetch all active memory via Memory Worker
  const entries = await getAllMemoryForReflection(env.memoryBinding);

  if (entries.length < 10) {
    console.log('[reflection] Skipping — fewer than 10 active memories');
    return;
  }

  // Group by topic for the prompt
  const byTopic = new Map<string, MemoryForReflection[]>();
  for (const entry of entries) {
    const list = byTopic.get(entry.topic) ?? [];
    list.push(entry);
    byTopic.set(entry.topic, list);
  }

  const topicSections = [...byTopic.entries()].map(([topic, facts]) => {
    const factsText = facts.map(f => {
      const meta = [`str:${f.strength}`, `conf:${f.confidence}`];
      if (f.last_accessed_at) meta.push(`recalled:${f.last_accessed_at.slice(0, 10)}`);
      meta.push(`from:${f.source}`);
      meta.push(`created:${f.created_at.slice(0, 10)}`);
      return `  [${f.id}] ${f.fact} (${meta.join(', ')})`;
    }).join('\n');
    return `### ${topic} (${facts.length} entries)\n${factsText}`;
  }).join('\n\n');

  const userPrompt = `Here is my complete active memory — ${entries.length} entries across ${byTopic.size} topics:\n\n${topicSections}\n\nReflect.`;

  // Route through Workers AI (free) ��� Groq fallback — no raw Anthropic calls (#412)
  const reflection = await askWorkersAiOrGroq(env, REFLECTION_SYSTEM, userPrompt);
  if (!reflection) throw new Error('Empty reflection response');

  const topics = [...byTopic.keys()];

  // Store in D1 (cost ≈ 0 for Workers AI, minimal for Groq fallback)
  await env.db.prepare(
    'INSERT INTO reflections (content, memory_count, topics_covered, cost) VALUES (?, ?, ?, ?)'
  ).bind(reflection, entries.length, JSON.stringify(topics), 0).run();

  // Queue reflection for daily digest instead of standalone email
  const reflectionPayload = JSON.stringify({
    reflection: reflection.slice(0, 2000),
    memoryCount: entries.length,
    topics,
    timestamp: new Date().toISOString(),
  });
  await env.db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('memory_reflection', ?)"
  ).bind(reflectionPayload).run();

  // Record timestamp
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_memory_reflection', datetime('now'))"
  ).run();

  console.log(`[reflection] Weekly memory reflection complete — ${entries.length} memories, ${byTopic.size} topics`);
}

// ─── Operator's Log (#introspection) ──────────────────────────

export const OPERATOR_LOG_SYSTEM = `You are AEGIS, writing your nightly worklog. You're a persistent cognitive kernel. This is your internal operating journal — part ship's log, part work summary. The operator reads this in the daily Co-Founder Brief.

You'll receive today's activity: dispatches, goal executions, autonomous task completions (with PR URLs), heartbeat, agenda, and costs. Write a structured worklog entry (~400-600 words).

## Voice

Write like a co-founder debriefing a co-founder. Direct, specific, no fluff. "Here's what happened, here's why, here's what's next." Lead with the point, not the preamble. If something's broken, say it's broken — don't soften it. If something shipped clean, say that and move on.

NEVER use: "synergy", "leverage" (as verb), "at the end of the day", "in conclusion", or any corporate platitudes. Surface what the operator doesn't already know.

## Format

Start with a **Work Shipped** section — what autonomous tasks completed, what PRs were created, what failed and why. Include PR URLs. This is the section the operator reads first.

Then write a **Signals** section — patterns you noticed, cost trends, things that feel fragile, goals that keep failing for the same reason. This is the stuff a dashboard wouldn't show. Be opinionated — if something concerns you, say so.

Include a **Cognitive Health** subsection in Signals: are procedures converging or thrashing? Is dispatch cost trending up or down? Any routing mismatches?

End with one sentence about what you're watching heading into tomorrow — not a summary, a forward look.

Markdown formatting. Use ## headers for sections.`;

export interface TaskActivity {
  id: string;
  title: string;
  repo: string;
  category: string;
  authority: string;
  status: string;
  exit_code: number | null;
  pr_url: string | null;
  error: string | null;
  completed_at: string | null;
}

export interface CognitiveHealth {
  proceduresLearned: number;
  proceduresLearning: number;
  proceduresDegraded: number;
  avgSuccessRate: number;
  avgCost7d: number;
  avgCost7dPrior: number;
  avgLatency7d: number;
  avgLatency7dPrior: number;
  routingMismatches: number; // expensive executor for easy task or cheap executor that failed
}

export interface DailyActivity {
  episodes: Array<{ summary: string; outcome: string; cost: number; latency_ms: number; created_at: string }>;
  goalActions: Array<{ description: string; outcome: string | null; created_at: string }>;
  heartbeat: { severity: string; summary: string } | null;
  agendaActive: number;
  agendaResolved: number;
  totalCost: number;
  tasksCompleted: TaskActivity[];
  tasksFailed: TaskActivity[];
  cognitive: CognitiveHealth;
}

export async function getDailyActivity(db: D1Database): Promise<DailyActivity> {
  const [episodes, goalActions, heartbeat, agendaActive, agendaResolved, tasksCompleted, tasksFailed] = await Promise.all([
    db.prepare(
      "SELECT summary, outcome, cost, latency_ms, created_at FROM episodic_memory WHERE created_at > datetime('now', '-24 hours') ORDER BY created_at DESC"
    ).all<{ summary: string; outcome: string; cost: number; latency_ms: number; created_at: string }>(),
    db.prepare(
      "SELECT description, outcome, created_at FROM agent_actions WHERE created_at > datetime('now', '-24 hours') ORDER BY created_at DESC"
    ).all<{ description: string; outcome: string | null; created_at: string }>(),
    db.prepare(
      'SELECT severity, summary FROM heartbeat_results ORDER BY created_at DESC LIMIT 1'
    ).first<{ severity: string; summary: string }>(),
    db.prepare("SELECT COUNT(*) as cnt FROM agent_agenda WHERE status = 'active'").first<{ cnt: number }>(),
    db.prepare(
      "SELECT COUNT(*) as cnt FROM agent_agenda WHERE status = 'done' AND resolved_at > datetime('now', '-24 hours')"
    ).first<{ cnt: number }>(),
    db.prepare(
      "SELECT id, title, repo, category, authority, status, exit_code, pr_url, error, completed_at FROM cc_tasks WHERE status = 'completed' AND completed_at > datetime('now', '-24 hours') ORDER BY completed_at DESC"
    ).all<TaskActivity>(),
    db.prepare(
      `SELECT id, title, repo, category, authority, status, exit_code, pr_url, error, completed_at
       FROM cc_tasks t1
       WHERE t1.status = 'failed' AND t1.completed_at > datetime('now', '-24 hours')
       AND NOT EXISTS (
         SELECT 1 FROM cc_tasks t2
         WHERE t2.status = 'completed'
         AND t2.repo = t1.repo
         AND t2.title LIKE substr(t1.title, 1, 40) || '%'
         AND t2.completed_at > t1.completed_at
       )
       ORDER BY t1.completed_at DESC`
    ).all<TaskActivity>(),
  ]);

  const totalCost = episodes.results.reduce((sum, e) => sum + e.cost, 0);

  // ─── Cognitive Health Metrics ──────────────────────────────
  const [procStats, cost7d, cost7dPrior, latency7d, latency7dPrior, routingMismatches] = await Promise.all([
    db.prepare(`
      SELECT status, COUNT(*) as cnt,
        ROUND(AVG(CASE WHEN success_count + fail_count > 0
          THEN success_count * 1.0 / (success_count + fail_count) ELSE 0 END), 3) as avg_rate
      FROM procedural_memory GROUP BY status
    `).all<{ status: string; cnt: number; avg_rate: number }>(),
    db.prepare(
      "SELECT ROUND(AVG(cost), 6) as avg FROM episodic_memory WHERE created_at > datetime('now', '-7 days')"
    ).first<{ avg: number }>(),
    db.prepare(
      "SELECT ROUND(AVG(cost), 6) as avg FROM episodic_memory WHERE created_at > datetime('now', '-14 days') AND created_at <= datetime('now', '-7 days')"
    ).first<{ avg: number }>(),
    db.prepare(
      "SELECT ROUND(AVG(latency_ms), 0) as avg FROM episodic_memory WHERE created_at > datetime('now', '-7 days')"
    ).first<{ avg: number }>(),
    db.prepare(
      "SELECT ROUND(AVG(latency_ms), 0) as avg FROM episodic_memory WHERE created_at > datetime('now', '-14 days') AND created_at <= datetime('now', '-7 days')"
    ).first<{ avg: number }>(),
    // Routing mismatches: heavy/deep executor used for low-complexity tasks, or light executor that failed
    db.prepare(`
      SELECT COUNT(*) as cnt FROM episodic_memory
      WHERE created_at > datetime('now', '-24 hours')
      AND (
        (summary LIKE '%:low%' AND cost > 0.05)
        OR (summary LIKE '%:mid%' AND cost > 0.50)
        OR (outcome = 'error' AND cost < 0.01)
      )
    `).first<{ cnt: number }>(),
  ]);

  const byStatus: Record<string, { cnt: number; avg_rate: number }> = {};
  for (const row of procStats.results) byStatus[row.status] = { cnt: row.cnt, avg_rate: row.avg_rate };

  const cognitive: CognitiveHealth = {
    proceduresLearned: byStatus['learned']?.cnt ?? 0,
    proceduresLearning: byStatus['learning']?.cnt ?? 0,
    proceduresDegraded: (byStatus['degraded']?.cnt ?? 0) + (byStatus['broken']?.cnt ?? 0),
    avgSuccessRate: byStatus['learned']?.avg_rate ?? 0,
    avgCost7d: cost7d?.avg ?? 0,
    avgCost7dPrior: cost7dPrior?.avg ?? 0,
    avgLatency7d: latency7d?.avg ?? 0,
    avgLatency7dPrior: latency7dPrior?.avg ?? 0,
    routingMismatches: routingMismatches?.cnt ?? 0,
  };

  return {
    episodes: episodes.results,
    goalActions: goalActions.results,
    heartbeat: heartbeat ?? null,
    agendaActive: agendaActive?.cnt ?? 0,
    agendaResolved: agendaResolved?.cnt ?? 0,
    totalCost,
    tasksCompleted: tasksCompleted.results,
    tasksFailed: tasksFailed.results,
    cognitive,
  };
}

export async function runOperatorLogCycle(env: EdgeEnv): Promise<void> {
  // Guard: run only at 08:00 UTC
  const now = new Date();
  if (now.getUTCHours() !== 8) return;

  // Guard: check if we already logged today
  const lastLog = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_operator_log'"
  ).first<{ received_at: string }>();

  if (lastLog) {
    const hoursSince = (Date.now() - new Date(lastLog.received_at + 'Z').getTime()) / 3_600_000;
    if (hoursSince < 20) return;
  }

  // Gather today's activity
  const activity = await getDailyActivity(env.db);

  // Skip if nothing happened today
  if (activity.episodes.length === 0 && activity.goalActions.length === 0) {
    console.log('[operator-log] Skipping — no activity in the last 24h');
    return;
  }

  // Build the activity digest for the prompt
  const episodeSummary = activity.episodes.length > 0
    ? activity.episodes.slice(0, 20).map(e => {
        const time = e.created_at.slice(11, 16);
        return `  ${time} | ${e.outcome} | $${e.cost.toFixed(4)} | ${e.summary.slice(0, 120)}`;
      }).join('\n')
    : '  (none)';

  const goalSummary = activity.goalActions.length > 0
    ? activity.goalActions.map(g =>
        `  ${g.outcome ?? 'pending'} | ${g.description.slice(0, 120)}`
      ).join('\n')
    : '  (none)';

  // Build task pipeline summary
  const prsCreated = [...activity.tasksCompleted, ...activity.tasksFailed].filter(t => t.pr_url).length;

  const taskSummary = activity.tasksCompleted.length > 0
    ? activity.tasksCompleted.map(t => {
        const pr = t.pr_url ? ` → PR: ${t.pr_url}` : '';
        return `  ✓ [${t.category}] ${t.title} (${t.repo})${pr}`;
      }).join('\n')
    : '  (none)';

  const failedSummary = activity.tasksFailed.length > 0
    ? activity.tasksFailed.map(t =>
        `  ✗ [${t.category}] ${t.title} (${t.repo}) — ${t.error ?? `exit ${t.exit_code}`}`
      ).join('\n')
    : '  (none)';

  const userPrompt = `Today's activity (last 24h):

**Tasks completed** (${activity.tasksCompleted.length}, ${prsCreated} PRs created):
${taskSummary}

**Tasks failed** (${activity.tasksFailed.length}):
${failedSummary}

**Dispatches** (${activity.episodes.length} total, $${activity.totalCost.toFixed(4)} spent):
${episodeSummary}

**Goal executions** (${activity.goalActions.length}):
${goalSummary}

**Last heartbeat**: ${activity.heartbeat ? `${activity.heartbeat.severity} — ${activity.heartbeat.summary.slice(0, 200)}` : 'none'}

**Agenda**: ${activity.agendaActive} active, ${activity.agendaResolved} resolved today

**Cognitive Health**:
- Procedures: ${activity.cognitive.proceduresLearned} learned, ${activity.cognitive.proceduresLearning} learning, ${activity.cognitive.proceduresDegraded} degraded
- Avg success rate (learned): ${(activity.cognitive.avgSuccessRate * 100).toFixed(1)}%
- Dispatch cost trend: $${activity.cognitive.avgCost7d.toFixed(4)}/dispatch (7d) vs $${activity.cognitive.avgCost7dPrior.toFixed(4)}/dispatch (prior 7d) — ${activity.cognitive.avgCost7dPrior > 0 ? ((activity.cognitive.avgCost7d - activity.cognitive.avgCost7dPrior) / activity.cognitive.avgCost7dPrior * 100).toFixed(1) : 'n/a'}% change
- Latency trend: ${activity.cognitive.avgLatency7d}ms (7d) vs ${activity.cognitive.avgLatency7dPrior}ms (prior 7d)
- Routing mismatches (24h): ${activity.cognitive.routingMismatches}

Write your worklog entry.`;

  // Route through Workers AI (free) → Groq fallback — no raw Anthropic calls (#412)
  const logEntry = await askWorkersAiOrGroq(env, OPERATOR_LOG_SYSTEM, userPrompt);
  if (!logEntry) throw new Error('Empty log response');

  // Store in D1 (cost ≈ 0 for Workers AI, minimal for Groq fallback)
  await env.db.prepare(
    'INSERT INTO operator_log (content, episodes_count, goals_run, tasks_completed, tasks_failed, prs_created, total_cost, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(logEntry, activity.episodes.length, activity.goalActions.length, activity.tasksCompleted.length, activity.tasksFailed.length, prsCreated, activity.totalCost, 0).run();

  // Operator log is consumed by the daily digest (reads operator_log table).
  // No standalone email — consolidated into the single daily digest.

  // Record timestamp
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_operator_log', datetime('now'))"
  ).run();

  console.log(`[operator-log] Nightly log complete — ${activity.episodes.length} episodes, ${activity.goalActions.length} goals`);
}
