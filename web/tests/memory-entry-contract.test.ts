// Contract-derived fixture tests for the MemoryEntry bounded context.
// These exercise the contract object itself — its schema constraints, the
// CRIX validation state machine, and the declared invariants — independent
// of the runtime CRIX engine in insights.ts. No DB, no mocks.

import { describe, it, expect } from 'vitest';
import { MemoryEntryContract } from '../src/contracts/memory-entry.contract.js';

const { schema, operations, states, invariants } = MemoryEntryContract;

function invariant(name: string) {
  const inv = invariants?.find((i) => i.name === name);
  if (!inv) throw new Error(`invariant ${name} not found in contract`);
  return inv;
}

// ─── Schema constraints ──────────────────────────────────────────

describe('MemoryEntry schema', () => {
  const base = {
    id: 1,
    topic: 'aegis',
    fact: 'a meaningful fact',
    source: 'test',
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
    expiresAt: null,
    validUntil: null,
    supersededBy: null,
    lastRecalledAt: null,
    validators: null,
  };

  it('applies declared defaults (factHash, confidence, strength, validationStage)', () => {
    const parsed = schema.parse(base);
    expect(parsed.factHash).toBe('');
    expect(parsed.confidence).toBe(0.8);
    expect(parsed.strength).toBe(1);
    expect(parsed.validationStage).toBe('candidate');
  });

  it('accepts confidence at the 0 and 1 boundaries', () => {
    expect(schema.parse({ ...base, confidence: 0 }).confidence).toBe(0);
    expect(schema.parse({ ...base, confidence: 1 }).confidence).toBe(1);
  });

  it('rejects confidence below 0 or above 1', () => {
    expect(() => schema.parse({ ...base, confidence: -0.01 })).toThrow();
    expect(() => schema.parse({ ...base, confidence: 1.01 })).toThrow();
  });

  it('rejects empty topic, fact, or source', () => {
    expect(() => schema.parse({ ...base, topic: '' })).toThrow();
    expect(() => schema.parse({ ...base, fact: '' })).toThrow();
    expect(() => schema.parse({ ...base, source: '' })).toThrow();
  });

  it('rejects non-positive or non-integer id', () => {
    expect(() => schema.parse({ ...base, id: 0 })).toThrow();
    expect(() => schema.parse({ ...base, id: -1 })).toThrow();
    expect(() => schema.parse({ ...base, id: 1.5 })).toThrow();
  });

  it('rejects negative strength but accepts zero', () => {
    expect(schema.parse({ ...base, strength: 0 }).strength).toBe(0);
    expect(() => schema.parse({ ...base, strength: -1 })).toThrow();
  });

  it('constrains validationStage to the known enum', () => {
    for (const stage of ['candidate', 'validated', 'expert', 'canonical', 'refuted']) {
      expect(schema.parse({ ...base, validationStage: stage }).validationStage).toBe(stage);
    }
    expect(() => schema.parse({ ...base, validationStage: 'unknown' })).toThrow();
  });

  it('rejects non-datetime createdAt/updatedAt', () => {
    expect(() => schema.parse({ ...base, createdAt: 'not-a-date' })).toThrow();
  });
});

// ─── CRIX state machine: valid transitions ───────────────────────

describe('CRIX validation pipeline — valid transitions', () => {
  it('starts at candidate', () => {
    expect(states?.initial).toBe('candidate');
  });

  it('candidate → validated via validate', () => {
    expect(states?.transitions.candidate.validate).toBe('validated');
  });

  it('validated → expert via promoteToExpert', () => {
    expect(states?.transitions.validated.promoteToExpert).toBe('expert');
  });

  it('expert → canonical via promoteToCanonical', () => {
    expect(states?.transitions.expert.promoteToCanonical).toBe('canonical');
  });

  it('candidate → refuted via refute', () => {
    expect(states?.transitions.candidate.refute).toBe('refuted');
  });

  it('validated → refuted via refute', () => {
    expect(states?.transitions.validated.refute).toBe('refuted');
  });

  it('expert → refuted via refute', () => {
    expect(states?.transitions.expert.refute).toBe('refuted');
  });

  it('operation transition declarations agree with the state map', () => {
    expect(operations.validate.transition).toEqual({ from: 'candidate', to: 'validated' });
    expect(operations.promoteToExpert.transition).toEqual({ from: 'validated', to: 'expert' });
    expect(operations.promoteToCanonical.transition).toEqual({ from: 'expert', to: 'canonical' });
    expect(operations.refute.transition).toEqual({
      from: ['candidate', 'validated', 'expert'],
      to: 'refuted',
    });
  });
});

// ─── CRIX state machine: terminal stages & invalid transitions ───

describe('CRIX validation pipeline — terminal stages & invalid transitions', () => {
  it('canonical is terminal (no outgoing transitions)', () => {
    expect(states?.transitions.canonical).toEqual({});
  });

  it('refuted is terminal (no outgoing transitions)', () => {
    expect(states?.transitions.refuted).toEqual({});
  });

  it('canonical cannot be refuted (no refute edge from canonical)', () => {
    expect(states?.transitions.canonical.refute).toBeUndefined();
    expect(operations.refute.transition?.from).not.toContain('canonical');
  });

  it('candidate cannot be promoted directly to canonical (no such edge)', () => {
    expect(states?.transitions.candidate.promoteToCanonical).toBeUndefined();
    // The only edge into canonical originates from expert.
    expect(operations.promoteToCanonical.transition?.from).toBe('expert');
  });

  it('candidate cannot skip to expert', () => {
    expect(states?.transitions.candidate.promoteToExpert).toBeUndefined();
  });
});

// ─── Invariant: refuted_entry_not_canonical ──────────────────────

describe("invariant refuted_entry_not_canonical", () => {
  const check = invariant('refuted_entry_not_canonical').check;

  it('applies to the refute operation', () => {
    expect(invariant('refuted_entry_not_canonical').appliesTo).toEqual(['refute']);
  });

  it('fails when a canonical entry is checked against refute', () => {
    const result = check({ validationStage: 'canonical' });
    expect(typeof result).toBe('string');
    expect(result).toContain('cannot transition to refuted');
  });

  it('passes for non-canonical stages', () => {
    for (const stage of ['candidate', 'validated', 'expert']) {
      expect(check({ validationStage: stage })).toBe(true);
    }
  });
});

// ─── Invariant: high_confidence_for_canonical ────────────────────

describe('invariant high_confidence_for_canonical', () => {
  const check = invariant('high_confidence_for_canonical').check;

  it('applies to the promoteToCanonical operation', () => {
    expect(invariant('high_confidence_for_canonical').appliesTo).toEqual(['promoteToCanonical']);
  });

  it('fails a canonical entity with confidence 0.5', () => {
    const result = check({ validationStage: 'canonical', confidence: 0.5 });
    expect(typeof result).toBe('string');
    expect(result).toContain('confidence >= 0.9');
  });

  it('passes a canonical entity with confidence 0.95', () => {
    expect(check({ validationStage: 'canonical', confidence: 0.95 })).toBe(true);
  });

  it('passes a canonical entity exactly at the 0.9 boundary', () => {
    expect(check({ validationStage: 'canonical', confidence: 0.9 })).toBe(true);
  });

  it('ignores confidence for non-canonical stages', () => {
    expect(check({ validationStage: 'expert', confidence: 0.1 })).toBe(true);
    expect(check({ validationStage: 'candidate', confidence: 0 })).toBe(true);
  });

  it('treats missing confidence on a canonical entry as failing', () => {
    const result = check({ validationStage: 'canonical' });
    expect(typeof result).toBe('string');
  });
});

// ─── Authority rules ─────────────────────────────────────────────

describe('MemoryEntry authority', () => {
  const authority = MemoryEntryContract.authority;

  it('allows operator and system to record and refute', () => {
    expect(authority.record).toEqual({ requires: 'role', roles: ['operator', 'system'] });
    expect(authority.refute).toEqual({ requires: 'role', roles: ['operator', 'system'] });
  });

  it('restricts pipeline promotions to system only', () => {
    for (const op of ['validate', 'promoteToExpert', 'promoteToCanonical', 'recall', 'expire']) {
      expect(authority[op]).toEqual({ requires: 'role', roles: ['system'] });
    }
  });

  it('never grants an operation a public/authenticated requirement', () => {
    for (const rule of Object.values(authority)) {
      expect(rule.requires).toBe('role');
    }
  });
});
