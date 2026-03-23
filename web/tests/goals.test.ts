// Goals tests — constants, authority logic, goal filtering
// Covers: MAX_GOALS_PER_CYCLE, AUTO_LOW_APPROVED_TOOLS, authority downgrade logic

import { describe, it, expect } from 'vitest';
import {
  MAX_GOALS_PER_CYCLE,
  AUTO_LOW_APPROVED_TOOLS,
  AUTO_LOW_MAX_ACTIONS_PER_RUN,
  AUTO_LOW_FAILURE_THRESHOLD,
} from '../src/kernel/scheduled/goals.js';

// ─── Constants Tests ─────────────────────────────────────────

describe('goal loop constants', () => {
  it('caps goals per cycle at 3', () => {
    expect(MAX_GOALS_PER_CYCLE).toBe(3);
  });

  it('limits auto_low actions per run to 3', () => {
    expect(AUTO_LOW_MAX_ACTIONS_PER_RUN).toBe(3);
  });

  it('downgrades after 2 consecutive failures', () => {
    expect(AUTO_LOW_FAILURE_THRESHOLD).toBe(2);
  });
});

// ─── AUTO_LOW_APPROVED_TOOLS Tests ───────────────────────────

describe('AUTO_LOW_APPROVED_TOOLS', () => {
  it('includes memory and agenda tools', () => {
    expect(AUTO_LOW_APPROVED_TOOLS.has('record_memory_entry')).toBe(true);
    expect(AUTO_LOW_APPROVED_TOOLS.has('resolve_agenda_item')).toBe(true);
    expect(AUTO_LOW_APPROVED_TOOLS.has('add_agenda_item')).toBe(true);
  });

  it('does not include BizOps tools (OSS build)', () => {
    // BizOps tools removed from AUTO_LOW in OSS — only memory/agenda tools allowed
    expect(AUTO_LOW_APPROVED_TOOLS.has('compliance_items')).toBe(false);
    expect(AUTO_LOW_APPROVED_TOOLS.has('compliance_status')).toBe(false);
    expect(AUTO_LOW_APPROVED_TOOLS.has('document_status')).toBe(false);
    expect(AUTO_LOW_APPROVED_TOOLS.has('dashboard_summary')).toBe(false);
  });

  it('does not include write BizOps tools', () => {
    expect(AUTO_LOW_APPROVED_TOOLS.has('update_compliance')).toBe(false);
    expect(AUTO_LOW_APPROVED_TOOLS.has('create_project')).toBe(false);
  });

  it('does not include dangerous tools', () => {
    expect(AUTO_LOW_APPROVED_TOOLS.has('create_improvement_pr')).toBe(false);
    expect(AUTO_LOW_APPROVED_TOOLS.has('create_improvement_issue')).toBe(false);
  });
});

// ─── Goal Filtering Logic ────────────────────────────────────

describe('goal filtering logic', () => {
  interface SimpleGoal {
    id: number;
    next_run_at: string | null;
    title: string;
  }

  function filterDueGoals(goals: SimpleGoal[], now: string, max: number): SimpleGoal[] {
    const seen = new Set<number>();
    return goals
      .filter(g => g.next_run_at === null || g.next_run_at <= now)
      .filter(g => { if (seen.has(g.id)) return false; seen.add(g.id); return true; })
      .sort((a, b) => (a.next_run_at ?? '').localeCompare(b.next_run_at ?? ''))
      .slice(0, max);
  }

  it('filters only due goals (next_run_at <= now)', () => {
    const goals: SimpleGoal[] = [
      { id: 1, next_run_at: '2026-03-10T00:00:00Z', title: 'Past due' },
      { id: 2, next_run_at: '2026-03-15T00:00:00Z', title: 'Future' },
      { id: 3, next_run_at: null, title: 'Never run' },
    ];

    const result = filterDueGoals(goals, '2026-03-10T12:00:00Z', MAX_GOALS_PER_CYCLE);

    expect(result).toHaveLength(2);
    expect(result.map(g => g.id)).toContain(1);
    expect(result.map(g => g.id)).toContain(3);
  });

  it('deduplicates goals by ID', () => {
    const goals: SimpleGoal[] = [
      { id: 1, next_run_at: null, title: 'Goal A' },
      { id: 1, next_run_at: null, title: 'Goal A dupe' },
      { id: 2, next_run_at: null, title: 'Goal B' },
    ];

    const result = filterDueGoals(goals, '2026-03-10T12:00:00Z', MAX_GOALS_PER_CYCLE);
    expect(result).toHaveLength(2);
  });

  it('caps at MAX_GOALS_PER_CYCLE', () => {
    const goals: SimpleGoal[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      next_run_at: null,
      title: `Goal ${i + 1}`,
    }));

    const result = filterDueGoals(goals, '2026-03-10T12:00:00Z', MAX_GOALS_PER_CYCLE);
    expect(result).toHaveLength(MAX_GOALS_PER_CYCLE);
  });

  it('sorts by next_run_at (null first since empty string sorts first)', () => {
    const goals: SimpleGoal[] = [
      { id: 1, next_run_at: '2026-03-10T06:00:00Z', title: 'Later' },
      { id: 2, next_run_at: null, title: 'Never run' },
      { id: 3, next_run_at: '2026-03-10T01:00:00Z', title: 'Earlier' },
    ];

    const result = filterDueGoals(goals, '2026-03-10T12:00:00Z', MAX_GOALS_PER_CYCLE);
    expect(result[0].id).toBe(2); // null sorts first (empty string)
    expect(result[1].id).toBe(3); // earlier time
    expect(result[2].id).toBe(1); // later time
  });

  it('returns empty when no goals are due', () => {
    const goals: SimpleGoal[] = [
      { id: 1, next_run_at: '2026-12-31T00:00:00Z', title: 'Far future' },
    ];

    const result = filterDueGoals(goals, '2026-03-10T12:00:00Z', MAX_GOALS_PER_CYCLE);
    expect(result).toHaveLength(0);
  });
});

// ─── Authority Downgrade Logic ───────────────────────────────

describe('authority downgrade logic', () => {
  it('triggers downgrade when consecutive failures >= threshold', () => {
    const recentActions = [
      { outcome: 'failure' },
      { outcome: 'failure' },
    ];
    const consecutiveFailures = recentActions.filter(a => a.outcome === 'failure').length;
    expect(consecutiveFailures >= AUTO_LOW_FAILURE_THRESHOLD).toBe(true);
  });

  it('does not trigger downgrade when failures < threshold', () => {
    const recentActions = [
      { outcome: 'failure' },
      { outcome: 'success' },
    ];
    const consecutiveFailures = recentActions.filter(a => a.outcome === 'failure').length;
    expect(consecutiveFailures >= AUTO_LOW_FAILURE_THRESHOLD).toBe(false);
  });

  it('does not trigger downgrade with no actions', () => {
    const recentActions: { outcome: string }[] = [];
    const consecutiveFailures = recentActions.filter(a => a.outcome === 'failure').length;
    expect(consecutiveFailures >= AUTO_LOW_FAILURE_THRESHOLD).toBe(false);
  });
});
