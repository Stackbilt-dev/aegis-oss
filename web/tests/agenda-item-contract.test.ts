// Contract conformance tests for the AgendaItem bounded context.
// Derived directly from src/contracts/agenda-item.contract.ts — the source of truth.
// Fixtures are inline objects built from the contract schema; nothing is mocked.

import { describe, it, expect } from 'vitest';
import { AgendaItemContract } from '../src/contracts/agenda-item.contract.js';

const { schema, operations, states, invariants, authority } = AgendaItemContract;

// A fully-valid entity, used as a base for targeted mutations.
const validEntity = {
  id: 1,
  item: 'Review Q3 compliance filing',
  context: 'Upstream registry not yet updated',
  priority: 'high' as const,
  status: 'active' as const,
  createdAt: '2026-06-24T10:00:00.000Z',
  resolvedAt: null,
  businessUnit: 'stackbilt',
};

describe('AgendaItem contract — metadata', () => {
  it('is named AgendaItem and versioned', () => {
    expect(AgendaItemContract.name).toBe('AgendaItem');
    expect(AgendaItemContract.version).toBe('1.0.0');
  });
});

describe('AgendaItem schema — entity validation', () => {
  it('accepts a fully-valid entity', () => {
    const parsed = schema.parse(validEntity);
    expect(parsed.id).toBe(1);
    expect(parsed.status).toBe('active');
  });

  // ── id: positive int ──────────────────────────────────────
  it('rejects a non-positive id', () => {
    expect(schema.safeParse({ ...validEntity, id: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...validEntity, id: -3 }).success).toBe(false);
  });

  it('rejects a non-integer id', () => {
    expect(schema.safeParse({ ...validEntity, id: 1.5 }).success).toBe(false);
  });

  // ── item: min(1) ──────────────────────────────────────────
  it('rejects an empty item string', () => {
    expect(schema.safeParse({ ...validEntity, item: '' }).success).toBe(false);
  });

  it('accepts a single-character item', () => {
    expect(schema.safeParse({ ...validEntity, item: 'x' }).success).toBe(true);
  });

  // ── context: nullable ─────────────────────────────────────
  it('accepts a null context', () => {
    expect(schema.safeParse({ ...validEntity, context: null }).success).toBe(true);
  });

  it('rejects a missing context (nullable, not optional)', () => {
    const { context: _omit, ...withoutContext } = validEntity;
    expect(schema.safeParse(withoutContext).success).toBe(false);
  });

  // ── priority: enum + default ──────────────────────────────
  it('rejects an out-of-enum priority', () => {
    expect(schema.safeParse({ ...validEntity, priority: 'urgent' }).success).toBe(false);
  });

  it('defaults priority to medium when omitted', () => {
    const { priority: _omit, ...withoutPriority } = validEntity;
    expect(schema.parse(withoutPriority).priority).toBe('medium');
  });

  // ── status: enum + default ────────────────────────────────
  it('rejects an out-of-enum status', () => {
    expect(schema.safeParse({ ...validEntity, status: 'archived' }).success).toBe(false);
  });

  it('defaults status to active when omitted', () => {
    const { status: _omit, ...withoutStatus } = validEntity;
    expect(schema.parse(withoutStatus).status).toBe('active');
  });

  // ── createdAt: datetime ───────────────────────────────────
  it('rejects a non-ISO createdAt', () => {
    expect(schema.safeParse({ ...validEntity, createdAt: '2026-06-24' }).success).toBe(false);
  });

  // ── resolvedAt: nullable datetime ─────────────────────────
  it('accepts a null resolvedAt', () => {
    expect(schema.safeParse({ ...validEntity, resolvedAt: null }).success).toBe(true);
  });

  it('rejects a non-ISO resolvedAt', () => {
    expect(schema.safeParse({ ...validEntity, resolvedAt: 'yesterday' }).success).toBe(false);
  });

  // ── businessUnit: min(1) + default ────────────────────────
  it('rejects an empty businessUnit', () => {
    expect(schema.safeParse({ ...validEntity, businessUnit: '' }).success).toBe(false);
  });

  it('defaults businessUnit to stackbilt when omitted', () => {
    const { businessUnit: _omit, ...withoutBu } = validEntity;
    expect(schema.parse(withoutBu).businessUnit).toBe('stackbilt');
  });
});

describe('AgendaItem operations — input validation', () => {
  // ── add ───────────────────────────────────────────────────
  it('add accepts minimal valid input (item only)', () => {
    expect(operations.add.input.safeParse({ item: 'Do the thing' }).success).toBe(true);
  });

  it('add rejects an empty item', () => {
    expect(operations.add.input.safeParse({ item: '' }).success).toBe(false);
  });

  it('add rejects an out-of-enum priority', () => {
    expect(operations.add.input.safeParse({ item: 'x', priority: 'critical' }).success).toBe(false);
  });

  it('add rejects an empty businessUnit when provided', () => {
    expect(operations.add.input.safeParse({ item: 'x', businessUnit: '' }).success).toBe(false);
  });

  // ── resolve / dismiss / escalate share the id-only input ──
  for (const op of ['resolve', 'dismiss', 'escalate'] as const) {
    it(`${op} accepts a positive integer id`, () => {
      expect(operations[op].input.safeParse({ id: 42 }).success).toBe(true);
    });

    it(`${op} rejects a non-positive id`, () => {
      expect(operations[op].input.safeParse({ id: 0 }).success).toBe(false);
    });

    it(`${op} rejects a missing id`, () => {
      expect(operations[op].input.safeParse({}).success).toBe(false);
    });
  }
});

describe('AgendaItem operations — declared transitions & events', () => {
  it('resolve declares active → done', () => {
    expect(operations.resolve.transition).toEqual({ from: 'active', to: 'done' });
    expect(operations.resolve.emits).toContain('agenda_item.resolved');
  });

  it('dismiss declares active → dismissed', () => {
    expect(operations.dismiss.transition).toEqual({ from: 'active', to: 'dismissed' });
    expect(operations.dismiss.emits).toContain('agenda_item.dismissed');
  });

  it('escalate declares no state transition', () => {
    expect(operations.escalate.transition).toBeUndefined();
    expect(operations.escalate.emits).toContain('agenda_item.escalated');
  });

  it('add emits agenda_item.added', () => {
    expect(operations.add.emits).toContain('agenda_item.added');
  });
});

describe('AgendaItem state machine', () => {
  const transitions = states!.transitions;

  it('starts in the active state', () => {
    expect(states!.initial).toBe('active');
    expect(states!.field).toBe('status');
  });

  // ── valid transitions ─────────────────────────────────────
  it('allows active → done via resolve', () => {
    expect(transitions.active.resolve).toBe('done');
  });

  it('allows active → dismissed via dismiss', () => {
    expect(transitions.active.dismiss).toBe('dismissed');
  });

  // ── invalid transitions: terminal states ──────────────────
  it('done is terminal — no resolve out of it', () => {
    expect(transitions.done.resolve).toBeUndefined();
  });

  it('done is terminal — no dismiss out of it', () => {
    expect(transitions.done.dismiss).toBeUndefined();
  });

  it('dismissed is terminal — no resolve out of it', () => {
    expect(transitions.dismissed.resolve).toBeUndefined();
  });

  it('dismissed is terminal — no dismiss out of it', () => {
    expect(transitions.dismissed.dismiss).toBeUndefined();
  });

  it('every declared state is reachable from the transition map', () => {
    const targets = new Set<string>([states!.initial]);
    for (const fromState of Object.values(transitions)) {
      for (const to of Object.values(fromState)) {
        if (to) targets.add(to);
      }
    }
    expect(targets).toEqual(new Set(['active', 'done', 'dismissed']));
  });
});

describe('AgendaItem invariants — resolved_has_timestamp', () => {
  const inv = invariants!.find((i) => i.name === 'resolved_has_timestamp')!;

  it('is declared and applies to resolve', () => {
    expect(inv).toBeDefined();
    expect(inv.appliesTo).toContain('resolve');
  });

  it('passes when a done item has a resolvedAt', () => {
    const check = inv.check({ status: 'done', resolvedAt: '2026-06-24T11:00:00.000Z' });
    expect(check).toBe(true);
  });

  it('triggers when a done item lacks a resolvedAt', () => {
    const check = inv.check({ status: 'done', resolvedAt: null });
    expect(typeof check).toBe('string');
    expect(check).toBe('Done agenda item requires resolvedAt');
  });

  it('passes for non-done items regardless of resolvedAt', () => {
    expect(inv.check({ status: 'active', resolvedAt: null })).toBe(true);
    expect(inv.check({ status: 'dismissed', resolvedAt: null })).toBe(true);
  });
});

describe('AgendaItem authority', () => {
  it('add / resolve / dismiss are open to operator and system roles', () => {
    for (const op of ['add', 'resolve', 'dismiss'] as const) {
      const rule = authority[op];
      expect(rule.requires).toBe('role');
      expect((rule as { roles: string[] }).roles).toEqual(['operator', 'system']);
    }
  });

  it('escalate is restricted to the system role', () => {
    const rule = authority.escalate;
    expect(rule.requires).toBe('role');
    expect((rule as { roles: string[] }).roles).toEqual(['system']);
    expect((rule as { roles: string[] }).roles).not.toContain('operator');
  });
});
