import { createIntent, dispatch, type EdgeEnv } from '../dispatch.js';
import { getActiveGoals, touchGoal, recordGoalAction, getGoalActions, downgradeGoalAuthority, type AgentGoal } from '../memory/index.js';

// ─── Autonomous Goal Loop (#14, #28) ─────────────────────────

// Standing Orders: structured context for goal execution.
// Stored in agent_goals.context_json. Defines scope, guardrails,
// and escalation rules so goals operate with clear boundaries.
export interface GoalContext {
  scope?: string[];          // What this goal IS authorized to do
  guardrails?: string[];     // What this goal must NOT do
  escalation?: string[];     // When to stop and flag for human attention
  triggers?: string[];       // Additional trigger conditions beyond schedule
  deadline?: string;         // ISO date — auto-complete goal after this date
}

function formatStandingOrders(ctx: GoalContext): string {
  const sections: string[] = [];

  if (ctx.scope?.length) {
    sections.push(`Scope (what you MAY do):\n${ctx.scope.map(s => `  - ${s}`).join('\n')}`);
  }
  if (ctx.guardrails?.length) {
    sections.push(`Guardrails (what you must NOT do):\n${ctx.guardrails.map(g => `  - ${g}`).join('\n')}`);
  }
  if (ctx.escalation?.length) {
    sections.push(`Escalation (stop and flag if):\n${ctx.escalation.map(e => `  - ${e}`).join('\n')}`);
  }
  if (ctx.triggers?.length) {
    sections.push(`Additional triggers:\n${ctx.triggers.map(t => `  - ${t}`).join('\n')}`);
  }

  return sections.length > 0
    ? `\nStanding Orders:\n${sections.join('\n')}`
    : '';
}

export const MAX_GOALS_PER_CYCLE = 3;

// Approved tools for auto_low execution — reversible, low-risk actions only
// NOTE: Only list tools that ACTUALLY EXIST. Phantom tools cause silent correctness failures
// where error messages pass the >50 char check and get recorded as "success".
export const AUTO_LOW_APPROVED_TOOLS: ReadonlySet<string> = new Set([
  'record_memory_entry',
  'resolve_agenda_item',
  'add_agenda_item',
]);

export const AUTO_LOW_MAX_ACTIONS_PER_RUN = 3;
export const AUTO_LOW_FAILURE_THRESHOLD = 2; // consecutive failures before downgrade

export async function runGoalLoop(env: EdgeEnv): Promise<void> {
  const goals = await getActiveGoals(env.db);
  if (goals.length === 0) return;

  const nowMs = Date.now();
  const seen = new Set<string | number>();
  // Parse next_run_at to Date for correct comparison — D1 stores 'YYYY-MM-DD HH:MM:SS'
  // while JS toISOString() uses 'YYYY-MM-DDTHH:MM:SS.sssZ'. Lexicographic comparison
  // breaks because space (ASCII 32) < T (ASCII 84), making every goal appear overdue.
  const due = goals.filter(g => {
      if (g.next_run_at === null) return true;
      const nextRunMs = new Date(g.next_run_at + 'Z').getTime();
      return nextRunMs <= nowMs;
    })
    .filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; })
    .sort((a, b) => {
      const aMs = a.next_run_at ? new Date(a.next_run_at + 'Z').getTime() : 0;
      const bMs = b.next_run_at ? new Date(b.next_run_at + 'Z').getTime() : 0;
      return aMs - bMs;
    })
    .slice(0, MAX_GOALS_PER_CYCLE);
  if (due.length === 0) return;

  console.log(`[goals] ${due.length} goal(s) due for execution (capped at ${MAX_GOALS_PER_CYCLE})`);
  for (const goal of due) {
    // Check consecutive failures for auto_low goals before running
    if (goal.authority_level === 'auto_low') {
      const recentActions = await getGoalActions(env.db, goal.id, AUTO_LOW_FAILURE_THRESHOLD);
      const consecutiveFailures = recentActions.filter(a => a.outcome === 'failure').length;
      if (consecutiveFailures >= AUTO_LOW_FAILURE_THRESHOLD) {
        await downgradeGoalAuthority(env.db, goal.id, `${consecutiveFailures} consecutive failures`);
        goal.authority_level = 'propose'; // reflect downgrade for this run
      }
    }
    await runSingleGoal(env, goal);
  }
}

export async function runSingleGoal(env: EdgeEnv, goal: AgentGoal): Promise<void> {
  // Parse standing orders from context_json
  let goalContext: GoalContext | null = null;
  if (goal.context_json) {
    try {
      goalContext = JSON.parse(goal.context_json) as GoalContext;
    } catch {
      console.warn(`[goals] Failed to parse context_json for "${goal.title}"`);
    }
  }

  // Check deadline — auto-complete expired goals
  if (goalContext?.deadline) {
    const deadlineMs = new Date(goalContext.deadline).getTime();
    if (!isNaN(deadlineMs) && Date.now() > deadlineMs) {
      console.log(`[goals] Goal "${goal.title}" past deadline (${goalContext.deadline}), marking completed`);
      await env.db.prepare("UPDATE agent_goals SET status = 'completed', completed_at = datetime('now') WHERE id = ?").bind(goal.id).run();
      return;
    }
  }

  const isAutoLow = goal.authority_level === 'auto_low';

  const authorityInstructions = isAutoLow
    ? `Authority: auto_low — you may DIRECTLY execute these approved actions without human approval:
  - record_memory_entry (record observations)
  - resolve_agenda_item (close stale agenda items)
  - add_agenda_item (create new agenda items)
  - Read-only BizOps tools (compliance_items, compliance_status, document_status, dashboard_summary)

  For any action NOT in this list, create a [PROPOSED ACTION] agenda item instead.
  Maximum ${AUTO_LOW_MAX_ACTIONS_PER_RUN} autonomous actions per run.`
    : 'Authority: propose — create [PROPOSED ACTION] agenda items, do not execute autonomously.';

  const standingOrders = goalContext ? formatStandingOrders(goalContext) : '';

  const prompt = `You are running the autonomous goal loop. Evaluate the following goal and take appropriate action.

**Goal #${goal.id}: ${goal.title}**
${goal.description ? `Description: ${goal.description}` : ''}
${authorityInstructions}${standingOrders}
Run count: ${goal.run_count}

Procedure:
1. Use BizOps tools to check current state relevant to this goal
2. Determine if action is needed
3. ${isAutoLow
    ? 'If yes and action is in approved list: execute it directly. Otherwise: create [PROPOSED ACTION] agenda item.'
    : 'If yes: call add_agenda_item with "[PROPOSED ACTION]" prefix and full reasoning in the context field'}
4. If no: call record_memory_entry noting what was checked and that no action is needed
5. ${isAutoLow ? `Maximum ${AUTO_LOW_MAX_ACTIONS_PER_RUN} actions per run.` : 'One proposed action max per run unless multiple urgent issues exist'}

Be concise. This is a scheduled check, not a full analysis.`;

  try {
    const intent = createIntent(`goal-${goal.id}`, prompt, {
      source: { channel: 'internal', threadId: `goal-${goal.id}` },
      classified: 'goal_execution',
      costCeiling: 'expensive',
      raw: prompt,
    });

    const result = await dispatch(intent, env);
    const partialMeta = result.meta as { partialFailure?: boolean; failedSubtasks?: number; subtasksPlanned?: number } | undefined;
    const isPartial = partialMeta?.partialFailure;
    // Partial failure is only a true failure if ALL subtasks failed or the response is empty.
    // If some subtasks succeeded and returned data, treat as success (the data is usable).
    // BUT: error messages are NOT usable data — check for known failure patterns.
    const errorPatterns = ['Tool unavailable', 'Method not found', 'MCP RPC error', 'Unknown tool', 'Memory Worker binding unavailable', 'Memory write failed', 'Cannot read properties of undefined'];
    const looksLikeError = errorPatterns.some(p => result.text.includes(p));
    // Clean result patterns indicate the goal achieved its purpose even if subtasks errored
    const cleanPatterns = ['no overdue', 'all clear', 'compliance posture is clean', 'no deadlines within', 'no action needed', 'recording the check', 'recording clean'];
    const looksClean = cleanPatterns.some(p => result.text.toLowerCase().includes(p));
    const hasUsableData = result.text.length > 50 && (!looksLikeError || looksClean);
    const allFailed = isPartial && (partialMeta?.failedSubtasks ?? 0) >= (partialMeta?.subtasksPlanned ?? 1);
    // A clean result overrides partial failure — the goal loop got the answer it needed
    const goalOutcome = (!looksClean && (allFailed || !hasUsableData)) ? 'failure' : 'success';
    const desc = isPartial
      ? `${result.text.slice(0, 400)} [partial: ${partialMeta.failedSubtasks} subtask(s) failed]`
      : result.text.slice(0, 500);
    await recordGoalAction(env.db, goal.id, 'executed', desc, goalOutcome, {
      autoExecuted: isAutoLow,
      authorityLevel: goal.authority_level,
    });
    console.log(`[goals] goal "${goal.title}" ${goalOutcome} (${goal.authority_level}) — ${result.text.slice(0, 100)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await recordGoalAction(env.db, goal.id, 'skipped', `Error: ${msg}`, 'failure', {
        autoExecuted: false,
        authorityLevel: goal.authority_level,
      });
    } catch { /* don't let recording failure prevent touchGoal */ }
    console.error(`[goals] goal "${goal.title}" failed:`, msg);

    // Failure downgrade: auto_low goal that fails reverts to propose
    if (isAutoLow) {
      await downgradeGoalAuthority(env.db, goal.id, `Execution failure: ${msg.slice(0, 200)}`);
    }
  } finally {
    // Always advance schedule — prevents runaway re-execution on persistent errors (#83)
    await touchGoal(env.db, goal.id, goal.schedule_hours).catch(err =>
      console.error(`[goals] touchGoal failed for "${goal.title}":`, err instanceof Error ? err.message : String(err))
    );
  }
}
