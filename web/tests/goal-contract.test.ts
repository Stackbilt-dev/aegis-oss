// Contract-derived tests for the Goal bounded context.
// Fixtures are derived directly from GoalContract — no mocks.
// Source of truth: src/contracts/goal.contract.ts

import { describe, it, expect } from 'vitest';
import { GoalContract } from '../src/contracts/goal.contract.js';

// ─── Helpers derived from the contract ───────────────────────

const schema = GoalContract.schema;

/** Minimal valid entity built from the contract's defaults + required fields. */
function validGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'goal-1',
    title: 'Ship the thing',
    description: null,
    status: 'active',
    authorityLevel: 'propose',
    scheduleHours: 6,
    createdAt: '2026-06-24T00:00:00.000Z',
    lastRunAt: null,
    nextRunAt: null,
    completedAt: null,
    runCount: 0,
    contextJson: null,
    businessUnit: 'stackbilt',
    ...overrides,
  };
}

/** Resolve the target state for an operation given the current state, per the contract. */
function transitionTarget(from: string, operation: string): string | null | undefined {
  return GoalContract.states?.transitions[from]?.[operation];
}

const invariant = (name: string) =>
  GoalContract.invariants?.find((i) => i.name === name);

// ─── Schema validation ───────────────────────────────────────

describe('Goal schema', () => {
  it('accepts a fully-specified valid entity', () => {
    expect(schema.safeParse(validGoal()).success).toBe(true);
  });

  it('applies declared defaults for omitted optional fields', () => {
    const parsed = schema.parse({
      id: 'goal-1',
      title: 'Ship it',
      description: null,
      createdAt: '2026-06-24T00:00:00.000Z',
      lastRunAt: null,
      nextRunAt: null,
      completedAt: null,
      contextJson: null,
    });
    expect(parsed.status).toBe('active');
    expect(parsed.authorityLevel).toBe('propose');
    expect(parsed.scheduleHours).toBe(6);
    expect(parsed.runCount).toBe(0);
    expect(parsed.businessUnit).toBe('stackbilt');
  });

  it('rejects an empty id', () => {
    expect(schema.safeParse(validGoal({ id: '' })).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(schema.safeParse(validGoal({ title: '' })).success).toBe(false);
  });

  it('allows a null description but rejects a missing one', () => {
    expect(schema.safeParse(validGoal({ description: null })).success).toBe(true);
    const { description: _omit, ...withoutDescription } = validGoal();
    expect(schema.safeParse(withoutDescription).success).toBe(false);
  });

  describe('scheduleHours', () => {
    it('rejects zero (must be positive)', () => {
      expect(schema.safeParse(validGoal({ scheduleHours: 0 })).success).toBe(false);
    });
    it('rejects negative values', () => {
      expect(schema.safeParse(validGoal({ scheduleHours: -3 })).success).toBe(false);
    });
    it('rejects non-integer values', () => {
      expect(schema.safeParse(validGoal({ scheduleHours: 1.5 })).success).toBe(false);
    });
    it('accepts a positive integer', () => {
      expect(schema.safeParse(validGoal({ scheduleHours: 12 })).success).toBe(true);
    });
  });

  describe('runCount', () => {
    it('accepts zero (non-negative)', () => {
      expect(schema.safeParse(validGoal({ runCount: 0 })).success).toBe(true);
    });
    it('rejects negative values', () => {
      expect(schema.safeParse(validGoal({ runCount: -1 })).success).toBe(false);
    });
    it('rejects non-integer values', () => {
      expect(schema.safeParse(validGoal({ runCount: 2.5 })).success).toBe(false);
    });
  });

  describe('status enum', () => {
    for (const status of ['active', 'paused', 'completed', 'failed']) {
      it(`accepts "${status}"`, () => {
        expect(schema.safeParse(validGoal({ status })).success).toBe(true);
      });
    }
    it('rejects an unknown status', () => {
      expect(schema.safeParse(validGoal({ status: 'archived' })).success).toBe(false);
    });
  });

  describe('authorityLevel enum', () => {
    for (const level of ['propose', 'auto_low', 'auto_high']) {
      it(`accepts "${level}"`, () => {
        expect(schema.safeParse(validGoal({ authorityLevel: level })).success).toBe(true);
      });
    }
    it('rejects an unknown authority level', () => {
      expect(schema.safeParse(validGoal({ authorityLevel: 'auto_full' })).success).toBe(false);
    });
  });

  describe('datetime fields', () => {
    it('rejects a non-ISO createdAt', () => {
      expect(schema.safeParse(validGoal({ createdAt: '2026-06-24' })).success).toBe(false);
    });
    it('accepts a null completedAt', () => {
      expect(schema.safeParse(validGoal({ completedAt: null })).success).toBe(true);
    });
    it('rejects a non-ISO completedAt', () => {
      expect(schema.safeParse(validGoal({ completedAt: 'yesterday' })).success).toBe(false);
    });
  });

  it('rejects an empty businessUnit', () => {
    expect(schema.safeParse(validGoal({ businessUnit: '' })).success).toBe(false);
  });
});

// ─── Operation input schemas ─────────────────────────────────

describe('create operation input', () => {
  const input = GoalContract.operations.create.input;

  it('accepts minimal valid input (id + title)', () => {
    expect(input.safeParse({ id: 'g1', title: 'Do a thing' }).success).toBe(true);
  });

  it('rejects missing title', () => {
    expect(input.safeParse({ id: 'g1' }).success).toBe(false);
  });

  it('rejects empty id', () => {
    expect(input.safeParse({ id: '', title: 'x' }).success).toBe(false);
  });

  it('rejects a non-positive scheduleHours', () => {
    expect(input.safeParse({ id: 'g1', title: 'x', scheduleHours: 0 }).success).toBe(false);
  });

  it('rejects an invalid authorityLevel', () => {
    expect(input.safeParse({ id: 'g1', title: 'x', authorityLevel: 'nope' }).success).toBe(false);
  });
});

describe('lifecycle operation inputs require an id', () => {
  for (const op of ['pause', 'resume', 'complete', 'fail', 'recordRun']) {
    it(`${op} rejects empty id`, () => {
      expect(GoalContract.operations[op].input.safeParse({ id: '' }).success).toBe(false);
    });
    it(`${op} accepts a valid id`, () => {
      expect(GoalContract.operations[op].input.safeParse({ id: 'g1' }).success).toBe(true);
    });
  }

  it('recordRun accepts an optional nextRunAt', () => {
    const input = GoalContract.operations.recordRun.input;
    expect(input.safeParse({ id: 'g1', nextRunAt: '2026-06-24T06:00:00.000Z' }).success).toBe(true);
    expect(input.safeParse({ id: 'g1', nextRunAt: 'soon' }).success).toBe(false);
  });
});

// ─── State machine ───────────────────────────────────────────

describe('Goal state machine', () => {
  it('starts in the active state', () => {
    expect(GoalContract.states?.initial).toBe('active');
  });

  describe('valid transitions', () => {
    const valid: Array<[string, string, string]> = [
      ['active', 'pause', 'paused'],
      ['active', 'complete', 'completed'],
      ['active', 'fail', 'failed'],
      ['paused', 'resume', 'active'],
      ['paused', 'complete', 'completed'],
      ['paused', 'fail', 'failed'],
    ];
    for (const [from, op, to] of valid) {
      it(`${from} --${op}--> ${to}`, () => {
        expect(transitionTarget(from, op)).toBe(to);
      });
    }
  });

  describe('invalid transitions', () => {
    const invalid: Array<[string, string]> = [
      ['active', 'resume'], // can only resume from paused
      ['paused', 'pause'], // already paused
      ['completed', 'resume'], // terminal
      ['completed', 'pause'],
      ['completed', 'complete'],
      ['failed', 'resume'], // terminal
      ['failed', 'complete'],
    ];
    for (const [from, op] of invalid) {
      it(`${from} cannot ${op}`, () => {
        expect(transitionTarget(from, op)).toBeUndefined();
      });
    }
  });

  it('completed is a terminal state (no outgoing transitions)', () => {
    expect(GoalContract.states?.transitions.completed).toEqual({});
  });

  it('failed is a terminal state (no outgoing transitions)', () => {
    expect(GoalContract.states?.transitions.failed).toEqual({});
  });

  describe('multi-source operations agree with the operation transition declarations', () => {
    it('complete accepts both active and paused as sources', () => {
      const t = GoalContract.operations.complete.transition;
      expect(t?.from).toEqual(['active', 'paused']);
      expect(t?.to).toBe('completed');
      // every declared source must reach the declared target in the states map
      for (const from of t!.from as string[]) {
        expect(transitionTarget(from, 'complete')).toBe('completed');
      }
    });

    it('fail accepts both active and paused as sources', () => {
      const t = GoalContract.operations.fail.transition;
      expect(t?.from).toEqual(['active', 'paused']);
      expect(t?.to).toBe('failed');
      for (const from of t!.from as string[]) {
        expect(transitionTarget(from, 'fail')).toBe('failed');
      }
    });
  });
});

// ─── Invariant: completed_has_timestamp ──────────────────────

describe('invariant: completed_has_timestamp', () => {
  const inv = invariant('completed_has_timestamp');

  it('is declared and applies to the complete operation', () => {
    expect(inv).toBeDefined();
    expect(inv!.appliesTo).toContain('complete');
  });

  it('fails when a completed goal has no completedAt', () => {
    const result = inv!.check(validGoal({ status: 'completed', completedAt: null }));
    expect(result).toBe('Completed goal requires completedAt');
  });

  it('passes when a completed goal has a completedAt', () => {
    const result = inv!.check(
      validGoal({ status: 'completed', completedAt: '2026-06-24T00:00:00.000Z' }),
    );
    expect(result).toBe(true);
  });

  it('passes for non-completed goals regardless of completedAt', () => {
    expect(inv!.check(validGoal({ status: 'active', completedAt: null }))).toBe(true);
    expect(inv!.check(validGoal({ status: 'paused', completedAt: null }))).toBe(true);
    expect(inv!.check(validGoal({ status: 'failed', completedAt: null }))).toBe(true);
  });
});

// ─── Authority rules ─────────────────────────────────────────

describe('Goal authority rules', () => {
  it('restricts terminal transitions (complete/fail) and recordRun to system', () => {
    for (const op of ['complete', 'fail', 'recordRun']) {
      const auth = GoalContract.authority[op];
      expect(auth).toEqual({ requires: 'role', roles: ['system'] });
    }
  });

  it('allows operators and system to create, pause, and resume', () => {
    for (const op of ['create', 'pause', 'resume']) {
      const auth = GoalContract.authority[op] as { requires: string; roles: string[] };
      expect(auth.requires).toBe('role');
      expect(auth.roles).toEqual(['operator', 'system']);
    }
  });
});
