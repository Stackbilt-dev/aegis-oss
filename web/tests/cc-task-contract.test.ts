// Contract-level tests for the CCTask bounded context.
// Validates the declarative contract artifact directly — schema constraints,
// operation input schemas, the status state machine, and runtime invariants.
// No mocks: fixtures are inline objects parsed through the contract itself.

import { describe, it, expect } from 'vitest';
import { CCTaskContract } from '../src/contracts/cc-task.contract.js';

const { schema, operations, states, invariants } = CCTaskContract;

// Minimal valid entity that satisfies every required field of the schema.
function validEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Do the thing',
    repo: 'aegis',
    prompt: 'Make it so',
    completionSignal: null,
    dependsOn: null,
    blockedBy: null,
    allowedTools: null,
    sessionId: null,
    result: null,
    error: null,
    exitCode: null,
    preflightJson: null,
    failureKind: null,
    autopsyJson: null,
    createdAt: '2026-06-24T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    branch: null,
    prUrl: null,
    utilityJson: null,
    githubIssueRepo: null,
    githubIssueNumber: null,
    ...overrides,
  };
}

function inv(name: string) {
  const found = invariants?.find((i) => i.name === name);
  if (!found) throw new Error(`invariant ${name} not found in contract`);
  return found;
}

// ─── Schema field constraints ─────────────────────────────────

describe('CCTask schema', () => {
  it('parses a minimal valid entity and applies defaults', () => {
    const parsed = schema.parse(validEntity());
    expect(parsed.status).toBe('pending');
    expect(parsed.priority).toBe(50);
    expect(parsed.maxTurns).toBe(25);
    expect(parsed.retryable).toBe(false);
    expect(parsed.createdBy).toBe('operator');
    expect(parsed.authority).toBe('operator');
    expect(parsed.category).toBe('feature');
    expect(parsed.businessUnit).toBe('stackbilt');
  });

  it.each(['id', 'title', 'repo', 'prompt'])('rejects empty %s', (field) => {
    expect(() => schema.parse(validEntity({ [field]: '' }))).toThrow();
  });

  it('rejects a missing required field', () => {
    const e = validEntity();
    delete (e as Record<string, unknown>).repo;
    expect(() => schema.parse(e)).toThrow();
  });

  it('accepts every TaskStatus enum value', () => {
    for (const s of ['pending', 'running', 'completed', 'failed', 'cancelled']) {
      expect(schema.parse(validEntity({ status: s })).status).toBe(s);
    }
  });

  it('rejects an unknown status', () => {
    expect(() => schema.parse(validEntity({ status: 'paused' }))).toThrow();
  });

  it('accepts every TaskAuthority enum value', () => {
    for (const a of ['proposed', 'auto_safe', 'operator']) {
      expect(schema.parse(validEntity({ authority: a })).authority).toBe(a);
    }
  });

  it('rejects an unknown authority', () => {
    expect(() => schema.parse(validEntity({ authority: 'admin' }))).toThrow();
  });

  it('accepts every TaskCategory enum value', () => {
    for (const c of ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy']) {
      expect(schema.parse(validEntity({ category: c })).category).toBe(c);
    }
  });

  it('rejects an unknown category', () => {
    expect(() => schema.parse(validEntity({ category: 'yolo' }))).toThrow();
  });

  it('accepts priority at both bounds', () => {
    expect(schema.parse(validEntity({ priority: 0 })).priority).toBe(0);
    expect(schema.parse(validEntity({ priority: 100 })).priority).toBe(100);
  });

  it.each([-1, 101])('rejects out-of-range priority %i', (p) => {
    expect(() => schema.parse(validEntity({ priority: p }))).toThrow();
  });

  it('rejects a non-integer priority', () => {
    expect(() => schema.parse(validEntity({ priority: 12.5 }))).toThrow();
  });

  it('rejects a non-positive maxTurns', () => {
    expect(() => schema.parse(validEntity({ maxTurns: 0 }))).toThrow();
  });

  it('rejects a non-positive githubIssueNumber but accepts a positive one', () => {
    expect(() => schema.parse(validEntity({ githubIssueNumber: 0 }))).toThrow();
    expect(schema.parse(validEntity({ githubIssueNumber: 72 })).githubIssueNumber).toBe(72);
  });

  it('rejects a non-datetime createdAt', () => {
    expect(() => schema.parse(validEntity({ createdAt: 'yesterday' }))).toThrow();
  });

  it('allows nullable timestamps but rejects malformed ones', () => {
    expect(schema.parse(validEntity({ startedAt: null })).startedAt).toBeNull();
    expect(() => schema.parse(validEntity({ startedAt: 'soon' }))).toThrow();
  });
});

// ─── Operation input schemas ──────────────────────────────────

describe('CCTask operation inputs', () => {
  it('create accepts the minimal required input', () => {
    const parsed = operations.create.input.parse({
      id: 't1', title: 'T', repo: 'aegis', prompt: 'go',
    });
    expect(parsed.id).toBe('t1');
  });

  it('create rejects missing prompt', () => {
    expect(() => operations.create.input.parse({
      id: 't1', title: 'T', repo: 'aegis',
    })).toThrow();
  });

  it('create rejects out-of-range priority', () => {
    expect(() => operations.create.input.parse({
      id: 't1', title: 'T', repo: 'aegis', prompt: 'go', priority: 200,
    })).toThrow();
  });

  it('start requires a non-empty sessionId', () => {
    expect(operations.start.input.parse({ id: 't1', sessionId: 's1' }).sessionId).toBe('s1');
    expect(() => operations.start.input.parse({ id: 't1', sessionId: '' })).toThrow();
    expect(() => operations.start.input.parse({ id: 't1' })).toThrow();
  });

  it('fail requires a non-empty error', () => {
    expect(operations.fail.input.parse({ id: 't1', error: 'boom' }).error).toBe('boom');
    expect(() => operations.fail.input.parse({ id: 't1', error: '' })).toThrow();
    expect(() => operations.fail.input.parse({ id: 't1' })).toThrow();
  });

  it('complete accepts optional result/exitCode/prUrl', () => {
    const parsed = operations.complete.input.parse({
      id: 't1', result: 'done', exitCode: 0, prUrl: 'http://pr',
    });
    expect(parsed.exitCode).toBe(0);
  });

  it('cancel and approve require only an id', () => {
    expect(operations.cancel.input.parse({ id: 't1' }).id).toBe('t1');
    expect(operations.approve.input.parse({ id: 't1' }).id).toBe('t1');
    expect(() => operations.cancel.input.parse({ id: '' })).toThrow();
  });
});

// ─── State machine ────────────────────────────────────────────

describe('CCTask state machine', () => {
  const transitions = states!.transitions;

  it('declares pending as the initial state', () => {
    expect(states!.initial).toBe('pending');
    expect(states!.field).toBe('status');
  });

  // Valid transitions, derived from contract.states.transitions.
  it.each([
    ['pending', 'start', 'running'],
    ['pending', 'cancel', 'cancelled'],
    ['running', 'complete', 'completed'],
    ['running', 'fail', 'failed'],
    ['running', 'cancel', 'cancelled'],
  ])('allows %s --%s--> %s', (from, op, to) => {
    expect(transitions[from][op]).toBe(to);
  });

  // Invalid transition attempts: operation not defined for that state.
  it.each([
    ['pending', 'complete'],
    ['pending', 'fail'],
    ['running', 'start'],
    ['completed', 'start'],
    ['completed', 'cancel'],
    ['failed', 'complete'],
    ['cancelled', 'start'],
  ])('rejects %s --%s-->', (from, op) => {
    expect(transitions[from][op]).toBeUndefined();
  });

  it('marks completed, failed, and cancelled as terminal', () => {
    expect(transitions.completed).toEqual({});
    expect(transitions.failed).toEqual({});
    expect(transitions.cancelled).toEqual({});
  });

  it('cancel operation declares a multi-source transition', () => {
    expect(operations.cancel.transition).toEqual({
      from: ['pending', 'running'],
      to: 'cancelled',
    });
  });

  it('every operation transition agrees with the states map', () => {
    for (const [op, def] of Object.entries(operations)) {
      const t = def.transition;
      if (!t) continue;
      const froms = Array.isArray(t.from) ? t.from : [t.from];
      for (const from of froms) {
        expect(transitions[from][op]).toBe(t.to);
      }
    }
  });
});

// ─── Invariants ───────────────────────────────────────────────

describe('CCTask invariant: proposed_task_needs_approval', () => {
  const check = inv('proposed_task_needs_approval').check;

  it('applies to the start operation', () => {
    expect(inv('proposed_task_needs_approval').appliesTo).toContain('start');
  });

  it('violates when a proposed task is set running', () => {
    const result = check({ authority: 'proposed', status: 'running' });
    expect(result).toBe('Proposed tasks require approval before execution');
  });

  it('passes when an operator task is set running', () => {
    expect(check({ authority: 'operator', status: 'running' })).toBe(true);
  });

  it('passes when a proposed task is still pending', () => {
    expect(check({ authority: 'proposed', status: 'pending' })).toBe(true);
  });
});

describe('CCTask invariant: completed_has_timestamp', () => {
  const check = inv('completed_has_timestamp').check;

  it('applies to complete and fail operations', () => {
    expect(inv('completed_has_timestamp').appliesTo).toEqual(
      expect.arrayContaining(['complete', 'fail']),
    );
  });

  it.each(['completed', 'failed'])('violates when %s has no completedAt', (status) => {
    expect(check({ status, completedAt: null })).toBe('Terminal tasks require completedAt');
  });

  it.each(['completed', 'failed'])('passes when %s has a completedAt', (status) => {
    expect(check({ status, completedAt: '2026-06-24T00:00:00.000Z' })).toBe(true);
  });

  it('passes for a running task with no completedAt', () => {
    expect(check({ status: 'running', completedAt: null })).toBe(true);
  });
});
