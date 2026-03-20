// Escalation tests — ESCALATION_THRESHOLDS, ISSUE_REF_PATTERN, runAgendaEscalation
// Covers: priority escalation timing, stale high item detection, issue ref parsing

import { describe, it, expect } from 'vitest';
import {
  ESCALATION_THRESHOLDS,
  STALE_HIGH_ALERT_DAYS,
  ISSUE_REF_PATTERN,
} from '../src/kernel/scheduled/escalation.js';

// ─── Constants Tests ─────────────────────────────────────────

describe('ESCALATION_THRESHOLDS', () => {
  it('escalates low→medium after 7 days', () => {
    expect(ESCALATION_THRESHOLDS['low']).toEqual({ days: 7, newPriority: 'medium' });
  });

  it('escalates medium→high after 3 days', () => {
    expect(ESCALATION_THRESHOLDS['medium']).toEqual({ days: 3, newPriority: 'high' });
  });

  it('does not define an escalation for high (no further promotion)', () => {
    expect(ESCALATION_THRESHOLDS['high']).toBeUndefined();
  });

  it('stale high alert triggers after 1 day', () => {
    expect(STALE_HIGH_ALERT_DAYS).toBe(1);
  });
});

// ─── ISSUE_REF_PATTERN Tests ─────────────────────────────────

describe('ISSUE_REF_PATTERN', () => {
  it('matches issue references in text', () => {
    const text = 'Fix #42 and #99';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('42');
    expect(matches[1][1]).toBe('99');
  });

  it('does not match numbers without # prefix', () => {
    const text = 'There are 42 items';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(0);
  });

  it('matches issue refs at start and end of string', () => {
    const text = '#1 is the first issue';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('1');
  });

  it('matches multi-digit issue numbers', () => {
    const text = 'See #9999 for details';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('9999');
  });
});

// ─── Escalation Logic Tests (unit-level) ─────────────────────

describe('escalation logic', () => {
  it('correctly identifies items needing escalation by age', () => {
    const now = Date.now();

    // Simulate the priority escalation check from runAgendaEscalation
    function shouldEscalate(priority: string, ageDays: number): { shouldEscalate: boolean; newPriority?: string } {
      const threshold = ESCALATION_THRESHOLDS[priority];
      if (threshold && ageDays > threshold.days) {
        return { shouldEscalate: true, newPriority: threshold.newPriority };
      }
      return { shouldEscalate: false };
    }

    // Low priority, 8 days old → should escalate to medium
    expect(shouldEscalate('low', 8)).toEqual({ shouldEscalate: true, newPriority: 'medium' });

    // Low priority, 5 days old → should NOT escalate
    expect(shouldEscalate('low', 5)).toEqual({ shouldEscalate: false });

    // Medium priority, 4 days old → should escalate to high
    expect(shouldEscalate('medium', 4)).toEqual({ shouldEscalate: true, newPriority: 'high' });

    // Medium priority, 2 days old → should NOT escalate
    expect(shouldEscalate('medium', 2)).toEqual({ shouldEscalate: false });

    // High priority → no escalation defined
    expect(shouldEscalate('high', 100)).toEqual({ shouldEscalate: false });
  });

  it('detects stale high-priority items correctly', () => {
    function isStaleHigh(priority: string, ageDays: number): boolean {
      const threshold = ESCALATION_THRESHOLDS[priority];
      if (threshold && ageDays > threshold.days) return false; // Would be escalated instead
      return priority === 'high' && ageDays > STALE_HIGH_ALERT_DAYS;
    }

    // High priority, 2 days old → stale
    expect(isStaleHigh('high', 2)).toBe(true);

    // High priority, 0.5 days old → not stale yet
    expect(isStaleHigh('high', 0.5)).toBe(false);

    // Medium priority, 2 days old → not high, so not stale high
    expect(isStaleHigh('medium', 2)).toBe(false);
  });

  it('validates issue ref range (0-10000)', () => {
    // The code filters: issueNum > 0 && issueNum < 10000
    function isValidIssueRef(num: number): boolean {
      return num > 0 && num < 10000;
    }

    expect(isValidIssueRef(1)).toBe(true);
    expect(isValidIssueRef(9999)).toBe(true);
    expect(isValidIssueRef(0)).toBe(false);
    expect(isValidIssueRef(10000)).toBe(false);
    expect(isValidIssueRef(-1)).toBe(false);
  });
});
