// ─── Autonomous Goals (#14) ──────────────────────────────────

import {
  ACTION_OUTCOMES, isValidEnum,
  type GoalStatus, type AuthorityLevel, type ActionType, type ActionOutcome,
} from '../../schema-enums.js';

export interface AgentGoal {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  authority_level: AuthorityLevel;
  schedule_hours: number;
  created_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  completed_at: string | null;
  run_count: number;
  context_json: string | null;
}

export interface AgentAction {
  id: string;
  goal_id: string | null;
  action_type: ActionType;
  description: string;
  tool_called: string | null;
  tool_args_json: string | null;
  tool_result_json: string | null;
  outcome: ActionOutcome | null;
  auto_executed: number; // 0 or 1 (SQLite boolean)
  authority_level: string;
  created_at: string;
}

export async function getActiveGoals(db: D1Database): Promise<AgentGoal[]> {
  const result = await db.prepare(
    "SELECT * FROM agent_goals WHERE status = 'active' ORDER BY created_at ASC"
  ).all();
  return result.results as unknown as AgentGoal[];
}

export async function addGoal(
  db: D1Database,
  title: string,
  description?: string,
  scheduleHours = 6,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.prepare(
    'INSERT INTO agent_goals (id, title, description, schedule_hours) VALUES (?, ?, ?, ?)'
  ).bind(id, title, description ?? null, scheduleHours).run();
  return id;
}

export async function updateGoalStatus(
  db: D1Database,
  id: string,
  status: AgentGoal['status'],
): Promise<void> {
  const completedAt = status === 'completed' || status === 'failed'
    ? "datetime('now')"
    : 'NULL';
  await db.prepare(
    `UPDATE agent_goals SET status = ?, completed_at = ${completedAt} WHERE id = ?`
  ).bind(status, id).run();
}

export async function touchGoal(db: D1Database, id: string, scheduleHours: number): Promise<void> {
  await db.prepare(`
    UPDATE agent_goals SET
      last_run_at = datetime('now'),
      next_run_at = datetime('now', '+' || ? || ' hours'),
      run_count = run_count + 1
    WHERE id = ?
  `).bind(scheduleHours, id).run();
}

// ─── Outcome Sanitization ───────────────────────────────────
// D1 CHECK: outcome IN ('success', 'failure', 'pending')
// Guard at the DB boundary so rogue values (partial_failure, error, blocked, "") never reach SQLite.

/** Map any outcome to a valid agent_actions value. */
export function sanitizeActionOutcome(raw: string | null | undefined): ActionOutcome | null {
  if (raw === null || raw === undefined) return null;
  if (isValidEnum(ACTION_OUTCOMES, raw)) return raw;
  // partial_failure, error, blocked, empty string → failure
  return 'failure';
}

export async function recordGoalAction(
  db: D1Database,
  goalId: string | null,
  actionType: AgentAction['action_type'],
  description: string,
  outcome: AgentAction['outcome'] = 'success',
  opts?: {
    autoExecuted?: boolean;
    authorityLevel?: string;
    toolCalled?: string;
    toolArgsJson?: string;
    toolResultJson?: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const safeOutcome = sanitizeActionOutcome(outcome);
  await db.prepare(
    'INSERT INTO agent_actions (id, goal_id, action_type, description, outcome, auto_executed, authority_level, tool_called, tool_args_json, tool_result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    id, goalId, actionType, description, safeOutcome,
    (opts?.autoExecuted ?? false) ? 1 : 0,
    opts?.authorityLevel ?? 'propose',
    opts?.toolCalled ?? null,
    opts?.toolArgsJson ?? null,
    opts?.toolResultJson ?? null,
  ).run();
}

export async function downgradeGoalAuthority(
  db: D1Database,
  goalId: string,
  reason: string,
): Promise<void> {
  await db.prepare(
    "UPDATE agent_goals SET authority_level = 'propose' WHERE id = ?"
  ).bind(goalId).run();
  console.warn(`[goals] Downgraded goal ${goalId} to propose: ${reason}`);
}

export async function getGoalActions(
  db: D1Database,
  goalId?: string,
  limit = 20,
): Promise<AgentAction[]> {
  const result = goalId
    ? await db.prepare(
        'SELECT * FROM agent_actions WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?'
      ).bind(goalId, limit).all()
    : await db.prepare(
        'SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all();
  return result.results as unknown as AgentAction[];
}
