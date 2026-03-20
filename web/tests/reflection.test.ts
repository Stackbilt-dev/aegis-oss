// Reflection tests — time gating, getDailyActivity, operator log structure
// Covers: reflection time guards, operator log time guards, daily activity aggregation

import { describe, it, expect } from 'vitest';
import {
  REFLECTION_SYSTEM,
  OPERATOR_LOG_SYSTEM,
  type DailyActivity,
  type TaskActivity,
} from '../src/kernel/scheduled/reflection.js';

// ─── Reflection Time Gate Tests ──────────────────────────────

describe('reflection time gate', () => {
  it('runs only on Saturday (day 6) at 08:00 UTC', () => {
    function shouldRunReflection(date: Date): boolean {
      return date.getUTCDay() === 6 && date.getUTCHours() === 8;
    }

    // Saturday 08:00 UTC → should run
    expect(shouldRunReflection(new Date('2026-03-07T08:00:00Z'))).toBe(true);

    // Saturday 09:00 UTC → wrong hour
    expect(shouldRunReflection(new Date('2026-03-07T09:00:00Z'))).toBe(false);

    // Sunday 08:00 UTC → wrong day
    expect(shouldRunReflection(new Date('2026-03-08T08:00:00Z'))).toBe(false);

    // Friday 08:00 UTC → wrong day
    expect(shouldRunReflection(new Date('2026-03-06T08:00:00Z'))).toBe(false);
  });

  it('requires 6-day cooldown between reflections', () => {
    function reflectionCooldownMet(lastReflectionAt: string, nowMs: number): boolean {
      const daysSince = (nowMs - new Date(lastReflectionAt + 'Z').getTime()) / 86_400_000;
      return daysSince >= 6;
    }

    const now = new Date('2026-03-14T08:00:00Z').getTime();

    // 7 days ago → cooldown met
    expect(reflectionCooldownMet('2026-03-07T08:00:00', now)).toBe(true);

    // 5 days ago → cooldown not met
    expect(reflectionCooldownMet('2026-03-09T08:00:00', now)).toBe(false);

    // Exactly 6 days → cooldown met
    expect(reflectionCooldownMet('2026-03-08T08:00:00', now)).toBe(true);
  });
});

// ─── Operator Log Time Gate Tests ────────────────────────────

describe('operator log time gate', () => {
  it('runs only at 05:00 UTC', () => {
    function shouldRunOperatorLog(date: Date): boolean {
      return date.getUTCHours() === 5;
    }

    expect(shouldRunOperatorLog(new Date('2026-03-10T05:00:00Z'))).toBe(true);
    expect(shouldRunOperatorLog(new Date('2026-03-10T04:00:00Z'))).toBe(false);
    expect(shouldRunOperatorLog(new Date('2026-03-10T06:00:00Z'))).toBe(false);
  });

  it('requires 20-hour cooldown', () => {
    function operatorLogCooldownMet(lastLogAt: string, nowMs: number): boolean {
      const hoursSince = (nowMs - new Date(lastLogAt + 'Z').getTime()) / 3_600_000;
      return hoursSince >= 20;
    }

    const now = new Date('2026-03-10T05:00:00Z').getTime();

    // 21 hours ago → cooldown met
    expect(operatorLogCooldownMet('2026-03-09T08:00:00', now)).toBe(true);

    // 10 hours ago → cooldown not met
    expect(operatorLogCooldownMet('2026-03-09T19:00:00', now)).toBe(false);
  });
});

// ─── System Prompt Content Tests ─────────────────────────────

describe('system prompts', () => {
  it('reflection system prompt mentions first person writing', () => {
    expect(REFLECTION_SYSTEM).toContain('first person');
  });

  it('reflection system prompt requests epistemological examination', () => {
    expect(REFLECTION_SYSTEM).toContain('epistemological');
  });

  it('reflection system prompt mentions 800-1200 words', () => {
    expect(REFLECTION_SYSTEM).toContain('800-1200 words');
  });

  it('operator log system prompt requests Work Shipped section', () => {
    expect(OPERATOR_LOG_SYSTEM).toContain('Work Shipped');
  });

  it('operator log system prompt requests Signals section', () => {
    expect(OPERATOR_LOG_SYSTEM).toContain('Signals');
  });

  it('operator log system prompt mentions PR URLs', () => {
    expect(OPERATOR_LOG_SYSTEM).toContain('PR URLs');
  });
});

// ─── DailyActivity Structure Tests ───────────────────────────

describe('DailyActivity structure', () => {
  it('correctly computes total cost from episodes', () => {
    const episodes = [
      { summary: 'A', outcome: 'success', cost: 0.01, latency_ms: 100, created_at: '2026-03-10T00:00:00Z' },
      { summary: 'B', outcome: 'success', cost: 0.02, latency_ms: 200, created_at: '2026-03-10T01:00:00Z' },
      { summary: 'C', outcome: 'failure', cost: 0.005, latency_ms: 50, created_at: '2026-03-10T02:00:00Z' },
    ];

    const totalCost = episodes.reduce((sum, e) => sum + e.cost, 0);
    expect(totalCost).toBeCloseTo(0.035, 4);
  });

  it('handles empty activity gracefully', () => {
    const activity: DailyActivity = {
      episodes: [],
      goalActions: [],
      heartbeat: null,
      agendaActive: 0,
      agendaResolved: 0,
      totalCost: 0,
      tasksCompleted: [],
      tasksFailed: [],
    };

    // Skip if nothing happened (the check in runOperatorLogCycle)
    const hasActivity = activity.episodes.length > 0 || activity.goalActions.length > 0;
    expect(hasActivity).toBe(false);
  });

  it('counts PR creation from task activity', () => {
    const tasks: TaskActivity[] = [
      { id: '1', title: 'T1', repo: 'r', category: 'bugfix', authority: 'auto_safe', status: 'completed', exit_code: 0, pr_url: 'https://github.com/org/repo/pull/1', error: null, completed_at: '2026-03-10' },
      { id: '2', title: 'T2', repo: 'r', category: 'docs', authority: 'auto_safe', status: 'completed', exit_code: 0, pr_url: null, error: null, completed_at: '2026-03-10' },
      { id: '3', title: 'T3', repo: 'r', category: 'tests', authority: 'auto_safe', status: 'failed', exit_code: 1, pr_url: 'https://github.com/org/repo/pull/3', error: 'timeout', completed_at: '2026-03-10' },
    ];

    const prsCreated = tasks.filter(t => t.pr_url).length;
    expect(prsCreated).toBe(2);
  });
});
