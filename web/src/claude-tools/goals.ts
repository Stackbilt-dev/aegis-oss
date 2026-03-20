// Goal management in-process tool definitions + handlers
// Extracted from claude-tools.ts for LOC governance

import { addGoal, getActiveGoals, updateGoalStatus, getGoalActions } from '../kernel/memory/index.js';

// ─── Tool definitions ────────────────────────────────────────

const ADD_GOAL_TOOL = {
  name: 'add_goal',
  description: 'Create a persistent autonomous goal. AEGIS will evaluate this goal every N hours on a schedule, check BizOps state, and create [PROPOSED ACTION] agenda items when action is needed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short goal title (e.g. "Monitor BOI deadline")' },
      description: { type: 'string', description: 'What to check and what to do if action is needed' },
      schedule_hours: { type: 'number', description: 'How often to run in hours (default: 6)' },
    },
    required: ['title'],
  },
};

const LIST_GOALS_TOOL = {
  name: 'list_goals',
  description: 'List all active autonomous goals.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const UPDATE_GOAL_STATUS_TOOL = {
  name: 'update_goal_status',
  description: 'Pause, complete, or mark a goal as failed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Goal ID' },
      status: { type: 'string', enum: ['paused', 'completed', 'failed'], description: 'New status' },
    },
    required: ['id', 'status'],
  },
};

const LIST_GOAL_ACTIONS_TOOL = {
  name: 'list_goal_actions',
  description: 'Show what AEGIS did autonomously overnight — proposed actions, executed steps, and skipped runs.',
  input_schema: {
    type: 'object' as const,
    properties: {
      goal_id: { type: 'string', description: 'Filter by goal ID (optional — omit for all goals)' },
      limit: { type: 'number', description: 'Max results (default: 20)' },
    },
    required: [],
  },
};

const UPGRADE_GOAL_AUTHORITY_TOOL = {
  name: 'upgrade_goal_authority',
  description: 'Upgrade a goal\'s authority level. Use "auto_low" to allow safe autonomous execution of approved low-risk actions (memory, agenda, read-only BizOps). Requires explicit operator approval.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Goal ID' },
      authority_level: { type: 'string', enum: ['propose', 'auto_low'], description: 'New authority level' },
    },
    required: ['id', 'authority_level'],
  },
};

export const GOAL_TOOLS = [ADD_GOAL_TOOL, LIST_GOALS_TOOL, UPDATE_GOAL_STATUS_TOOL, LIST_GOAL_ACTIONS_TOOL, UPGRADE_GOAL_AUTHORITY_TOOL];

// ─── Handler ─────────────────────────────────────────────────

export async function handleGoalTool(
  db: D1Database,
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name === 'add_goal') {
    const i = input as { title: string; description?: string; schedule_hours?: number };
    const id = await addGoal(db, i.title, i.description, i.schedule_hours ?? 6);
    return `Created goal "${i.title}" (ID: ${id}, every ${i.schedule_hours ?? 6}h)`;
  }

  if (name === 'list_goals') {
    const goals = await getActiveGoals(db);
    if (goals.length === 0) return 'No active goals.';
    return goals.map(g =>
      `[${g.id}] ${g.title} — every ${g.schedule_hours}h, run ${g.run_count}x` +
      (g.next_run_at ? `, next: ${g.next_run_at.slice(0, 16)}` : '') +
      (g.description ? `\n  ${g.description}` : '')
    ).join('\n');
  }

  if (name === 'update_goal_status') {
    const i = input as { id: string; status: 'paused' | 'completed' | 'failed' };
    await updateGoalStatus(db, i.id, i.status);
    return `Goal ${i.id} marked as ${i.status}`;
  }

  if (name === 'list_goal_actions') {
    const i = input as { goal_id?: string; limit?: number };
    const actions = await getGoalActions(db, i.goal_id, i.limit ?? 20);
    if (actions.length === 0) return 'No goal actions recorded yet.';
    return actions.map(a =>
      `[${a.created_at.slice(0, 16)}] ${a.action_type.toUpperCase()}${a.auto_executed ? ' [AUTO]' : ''} (goal: ${a.goal_id ?? 'none'}) — ${a.description.slice(0, 120)}`
    ).join('\n');
  }

  if (name === 'upgrade_goal_authority') {
    const i = input as { id: string; authority_level: 'propose' | 'auto_low' };
    await db.prepare(
      'UPDATE agent_goals SET authority_level = ? WHERE id = ?'
    ).bind(i.authority_level, i.id).run();
    return `Goal ${i.id} authority set to ${i.authority_level}`;
  }

  return null;
}
