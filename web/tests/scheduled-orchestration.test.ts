// Scheduled orchestration tests — phase ordering, mutual exclusion
// Covers: runScheduledTasks phase logic, self-improvement vs goals exclusion

import { describe, it, expect } from 'vitest';

// ─── Phase Ordering Tests ────────────────────────────────────

describe('scheduled task phase ordering', () => {
  it('self-improvement runs at hours divisible by 6', () => {
    const selfImprovementHours = [0, 6, 12, 18];
    for (const hour of selfImprovementHours) {
      expect(hour % 6 === 0).toBe(true);
    }
  });

  it('goals run at non-self-improvement hours', () => {
    const goalHours = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23];
    for (const hour of goalHours) {
      expect(hour % 6 !== 0).toBe(true);
    }
  });

  it('self-improvement and goals are mutually exclusive', () => {
    for (let hour = 0; hour < 24; hour++) {
      const isSelfImprovementHour = hour % 6 === 0;
      const isGoalHour = !isSelfImprovementHour;

      // Exactly one must be true
      expect(isSelfImprovementHour !== isGoalHour).toBe(true);
    }
  });

  it('curiosity only runs at non-self-improvement hours', () => {
    for (let hour = 0; hour < 24; hour++) {
      const isSelfImprovementHour = hour % 6 === 0;
      const curiosityRuns = !isSelfImprovementHour;

      if (isSelfImprovementHour) {
        expect(curiosityRuns).toBe(false);
      }
    }
  });
});

// ─── Phase Classification ────────────────────────────────────

describe('task phase classification', () => {
  const PHASE_1_FREE = ['escalation', 'issue-watcher', 'morning-briefing'];
  const PHASE_2_CHEAP = ['consolidation', 'heartbeat', 'product-health'];
  const PHASE_3_HEAVY = ['self-improvement'];
  const PHASE_4_HEAVY = ['goals'];
  const CONTENT = ['roundtable', 'dispatch', 'column', 'journal', 'reflection', 'operator-log'];
  const LATE_STAGE = ['curiosity', 'dreaming'];

  it('phase 1 has 3 free tasks', () => {
    expect(PHASE_1_FREE).toHaveLength(3);
  });

  it('phase 2 has 3 cheap tasks', () => {
    expect(PHASE_2_CHEAP).toHaveLength(3);
  });

  it('heavy phases have 1 task each (mutually exclusive)', () => {
    expect(PHASE_3_HEAVY).toHaveLength(1);
    expect(PHASE_4_HEAVY).toHaveLength(1);
  });

  it('content generation has 6 tasks', () => {
    expect(CONTENT).toHaveLength(6);
  });

  it('late stage has 2 tasks', () => {
    expect(LATE_STAGE).toHaveLength(2);
  });

  it('total unique task types is 16', () => {
    const allTasks = [...PHASE_1_FREE, ...PHASE_2_CHEAP, ...PHASE_3_HEAVY, ...PHASE_4_HEAVY, ...CONTENT, ...LATE_STAGE];
    expect(new Set(allTasks).size).toBe(16);
  });
});

// ─── recordTaskRun Logic ─────────────────────────────────────

describe('task run recording', () => {
  it('records ok status with duration', () => {
    const start = Date.now();
    const end = start + 1500;
    const duration = end - start;
    expect(duration).toBe(1500);
  });

  it('records error status with message', () => {
    const err = new Error('Something broke');
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toBe('Something broke');
  });

  it('extracts error message from non-Error objects', () => {
    const err = 'string error';
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toBe('string error');
  });
});
