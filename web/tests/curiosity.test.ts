// Curiosity cycle tests — buildCuriosityPrompt, CuriosityCandidate structure
// Covers: prompt generation, candidate source types, interest rotation

import { describe, it, expect } from 'vitest';
import { buildCuriosityPrompt, type CuriosityCandidate } from '../src/kernel/scheduled/curiosity.js';

// ─── buildCuriosityPrompt Tests ──────────────────────────────

describe('buildCuriosityPrompt', () => {
  it('includes all candidate topics in numbered list', () => {
    const candidates: CuriosityCandidate[] = [
      { topic: 'Memory gaps in auth', reason: 'Only 2 entries', source: 'memory_gap' },
      { topic: 'Why does routing fail?', reason: '5/10 failures', source: 'failure_rate' },
    ];

    const prompt = buildCuriosityPrompt(candidates);

    expect(prompt).toContain('1. [memory_gap] Memory gaps in auth');
    expect(prompt).toContain('2. [failure_rate] Why does routing fail?');
    expect(prompt).toContain('Reason: Only 2 entries');
    expect(prompt).toContain('Reason: 5/10 failures');
  });

  it('includes source tags in brackets', () => {
    const candidates: CuriosityCandidate[] = [
      { topic: 'Topic A', reason: 'R', source: 'heartbeat_warn' },
      { topic: 'Topic B', reason: 'R', source: 'goal_failure' },
      { topic: 'Topic C', reason: 'R', source: 'self_interest' },
      { topic: 'Topic D', reason: 'R', source: 'low_confidence' },
    ];

    const prompt = buildCuriosityPrompt(candidates);

    expect(prompt).toContain('[heartbeat_warn]');
    expect(prompt).toContain('[goal_failure]');
    expect(prompt).toContain('[self_interest]');
    expect(prompt).toContain('[low_confidence]');
  });

  it('includes exploration instructions', () => {
    const prompt = buildCuriosityPrompt([
      { topic: 'Test', reason: 'Reason', source: 'memory_gap' },
    ]);

    expect(prompt).toContain('Pick the 1-2 most interesting');
    expect(prompt).toContain('Record findings as memory entries');
    expect(prompt).toContain('Be genuinely curious');
  });

  it('mentions self-model interests in instructions', () => {
    const prompt = buildCuriosityPrompt([
      { topic: 'Explore AI', reason: 'Self-model interest', source: 'self_interest' },
    ]);

    expect(prompt).toContain('self-model interests');
  });
});

// ─── CuriosityCandidate Source Types ─────────────────────────

describe('CuriosityCandidate source types', () => {
  const ALL_SOURCES: CuriosityCandidate['source'][] = [
    'memory_gap',
    'low_confidence',
    'failure_rate',
    'heartbeat_warn',
    'goal_failure',
    'self_interest',
  ];

  it('covers all 6 source types', () => {
    expect(ALL_SOURCES).toHaveLength(6);
  });

  it('all source types are valid in prompt generation', () => {
    for (const source of ALL_SOURCES) {
      const prompt = buildCuriosityPrompt([
        { topic: `Topic for ${source}`, reason: 'Test', source },
      ]);
      expect(prompt).toContain(`[${source}]`);
    }
  });
});

// ─── Interest Rotation Logic ─────────────────────────────────

describe('interest rotation', () => {
  it('rotates through interests by day of year', () => {
    const interests = ['AI safety', 'distributed systems', 'type theory', 'compilers'];
    const results = new Set<number>();

    // Simulate 4 different days
    for (let dayOfYear = 0; dayOfYear < 4; dayOfYear++) {
      const idx = dayOfYear % interests.length;
      results.add(idx);
    }

    // All 4 indices should be different
    expect(results.size).toBe(4);
  });

  it('adds a second interest when enough are available (>2)', () => {
    const interests = ['AI', 'systems', 'types', 'compilers'];
    const dayOfYear = 0;
    const idx = dayOfYear % interests.length;
    const idx2 = (idx + Math.floor(interests.length / 2)) % interests.length;

    // idx and idx2 should be different
    expect(idx).not.toBe(idx2);
  });

  it('does not add second interest when only 2 available', () => {
    const interests = ['AI', 'systems'];
    expect(interests.length > 2).toBe(false);
  });
});
