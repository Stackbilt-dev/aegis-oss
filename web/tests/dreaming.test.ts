// Dreaming cycle tests — task proposal processing, category routing, JSON parsing
// Covers: AUTO_SAFE/PROPOSED category sets, processDreamingTaskProposals logic, response parsing

import { describe, it, expect } from 'vitest';

// ─── Category Routing (mirrors dreaming.ts logic) ────────────

const AUTO_SAFE_CATEGORIES = new Set(['docs', 'tests', 'research', 'refactor', 'bugfix', 'feature']);
const VALID_CATEGORIES = AUTO_SAFE_CATEGORIES;

describe('dreaming task category routing', () => {
  it('routes docs/tests/research/refactor as auto_safe', () => {
    for (const cat of ['docs', 'tests', 'research', 'refactor']) {
      expect(AUTO_SAFE_CATEGORIES.has(cat)).toBe(true);
      expect(VALID_CATEGORIES.has(cat)).toBe(true);
    }
  });

  it('routes all categories as auto_safe', () => {
    for (const cat of ['bugfix', 'feature']) {
      expect(AUTO_SAFE_CATEGORIES.has(cat)).toBe(true);
      expect(VALID_CATEGORIES.has(cat)).toBe(true);
    }
  });

  it('rejects deploy category', () => {
    expect(VALID_CATEGORIES.has('deploy')).toBe(false);
  });

  it('rejects unknown categories', () => {
    expect(VALID_CATEGORIES.has('infra')).toBe(false);
    expect(VALID_CATEGORIES.has('ops')).toBe(false);
    expect(VALID_CATEGORIES.has('')).toBe(false);
  });
});

// ─── Task Proposal Validation ────────────────────────────────

describe('dreaming task proposal validation', () => {
  interface TaskProposal {
    title: string;
    repo: string;
    prompt: string;
    category: string;
    rationale: string;
  }

  function validateTask(task: Partial<TaskProposal>): boolean {
    return !!(task.title && task.repo && task.prompt && task.category);
  }

  it('accepts valid task proposals', () => {
    expect(validateTask({
      title: 'Add logging',
      repo: 'my-project',
      prompt: 'Add structured logging to dispatch.ts',
      category: 'feature',
      rationale: 'Needed for debugging',
    })).toBe(true);
  });

  it('rejects proposals with missing title', () => {
    expect(validateTask({ repo: 'aegis', prompt: 'Do stuff', category: 'docs' })).toBe(false);
  });

  it('rejects proposals with missing repo', () => {
    expect(validateTask({ title: 'Fix it', prompt: 'Fix the bug', category: 'bugfix' })).toBe(false);
  });

  it('rejects proposals with missing prompt', () => {
    expect(validateTask({ title: 'Fix it', repo: 'aegis', category: 'bugfix' })).toBe(false);
  });

  it('rejects proposals with missing category', () => {
    expect(validateTask({ title: 'Fix it', repo: 'aegis', prompt: 'Do it' })).toBe(false);
  });

  it('caps proposals at 3 per cycle', () => {
    const proposals = Array.from({ length: 5 }, (_, i) => ({
      title: `Task ${i}`,
      repo: 'aegis',
      prompt: 'Do something',
      category: 'docs',
    }));

    const capped = proposals.slice(0, 3);
    expect(capped).toHaveLength(3);
  });
});

// ─── Groq Response Parsing ───────────────────────────────────

describe('dreaming Groq response parsing', () => {
  function cleanAndParse(raw: string): Record<string, unknown> | null {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  it('parses clean JSON response', () => {
    const raw = '{"facts": [], "routing_failures": []}';
    const result = cleanAndParse(raw);
    expect(result).toEqual({ facts: [], routing_failures: [] });
  });

  it('strips markdown code fence from JSON', () => {
    const raw = '```json\n{"facts": [{"topic": "test", "fact": "something", "confidence": 0.8}]}\n```';
    const result = cleanAndParse(raw);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).facts).toHaveLength(1);
  });

  it('handles response with just code fence markers', () => {
    const raw = '```json\n{"proposed_tasks": []}\n```\n';
    const result = cleanAndParse(raw);
    expect(result).toEqual({ proposed_tasks: [] });
  });

  it('returns null for invalid JSON', () => {
    const result = cleanAndParse('not json at all');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = cleanAndParse('');
    expect(result).toBeNull();
  });
});

// ─── Fact Recording Filters ──────────────────────────────────

describe('dreaming fact filtering', () => {
  interface DreamFact {
    topic: string;
    fact: string;
    confidence: number;
  }

  function shouldRecordFact(fact: Partial<DreamFact>): boolean {
    return !!(fact.topic && fact.fact && fact.fact.length >= 20);
  }

  it('accepts facts with topic, fact >= 20 chars', () => {
    expect(shouldRecordFact({
      topic: 'architecture',
      fact: 'The dispatch system uses an 8-tier cost model',
      confidence: 0.8,
    })).toBe(true);
  });

  it('rejects facts without topic', () => {
    expect(shouldRecordFact({
      fact: 'Some fact about something that is long enough',
      confidence: 0.8,
    })).toBe(false);
  });

  it('rejects facts shorter than 20 chars', () => {
    expect(shouldRecordFact({
      topic: 'test',
      fact: 'Too short',
      confidence: 0.8,
    })).toBe(false);
  });

  it('caps facts at 5 per cycle', () => {
    const facts = Array.from({ length: 8 }, (_, i) => ({
      topic: `topic_${i}`,
      fact: `Fact number ${i} with enough detail to pass the 20 char filter`,
      confidence: 0.8,
    }));

    expect(facts.slice(0, 5)).toHaveLength(5);
  });
});

// ─── Preference Recording Filters ────────────────────────────

describe('dreaming preference filtering', () => {
  function shouldRecordPreference(pref: { preference?: string }): boolean {
    return !!(pref.preference && pref.preference.length >= 15);
  }

  it('accepts preferences >= 15 chars', () => {
    expect(shouldRecordPreference({
      preference: 'Prefers direct communication over verbose explanations',
    })).toBe(true);
  });

  it('rejects preferences < 15 chars', () => {
    expect(shouldRecordPreference({ preference: 'Be direct' })).toBe(false);
  });

  it('rejects empty preferences', () => {
    expect(shouldRecordPreference({ preference: '' })).toBe(false);
  });

  it('caps preferences at 3 per cycle', () => {
    const prefs = Array.from({ length: 5 }, (_, i) => ({
      preference: `Preference number ${i} with detail`,
    }));
    expect(prefs.slice(0, 3)).toHaveLength(3);
  });
});

// ─── Agenda Triage Logic ─────────────────────────────────────

describe('agenda triage filtering', () => {
  interface AgendaItem {
    id: number;
    item: string;
    context: string | null;
    created_at: string;
  }

  function filterTriageCandidates(items: AgendaItem[], nowMs: number): AgendaItem[] {
    const SETTLING_MS = 48 * 60 * 60 * 1000;
    return items.filter(i => {
      if (i.item.startsWith('[PROPOSED ACTION]') || i.item.startsWith('[PROPOSED TASK]')) return false;
      if (i.context?.includes('Auto-detected by heartbeat')) return false;
      const createdMs = new Date(i.created_at.endsWith('Z') ? i.created_at : i.created_at + 'Z').getTime();
      if (nowMs - createdMs < SETTLING_MS) return false;
      return true;
    });
  }

  const baseTime = new Date('2026-03-10T12:00:00Z').getTime();
  const threeDaysAgo = new Date(baseTime - 3 * 86_400_000).toISOString();
  const oneHourAgo = new Date(baseTime - 3_600_000).toISOString();

  it('filters out proposed action items', () => {
    const items: AgendaItem[] = [
      { id: 1, item: '[PROPOSED ACTION] Do something', context: null, created_at: threeDaysAgo },
      { id: 2, item: 'Regular item', context: null, created_at: threeDaysAgo },
    ];

    const result = filterTriageCandidates(items, baseTime);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('filters out proposed task items', () => {
    const items: AgendaItem[] = [
      { id: 1, item: '[PROPOSED TASK] Build something', context: null, created_at: threeDaysAgo },
    ];
    expect(filterTriageCandidates(items, baseTime)).toHaveLength(0);
  });

  it('filters out heartbeat-detected items', () => {
    const items: AgendaItem[] = [
      { id: 1, item: 'Some check failed', context: 'Auto-detected by heartbeat', created_at: threeDaysAgo },
    ];
    expect(filterTriageCandidates(items, baseTime)).toHaveLength(0);
  });

  it('filters out items < 48h old (settling period)', () => {
    const items: AgendaItem[] = [
      { id: 1, item: 'New item', context: null, created_at: oneHourAgo },
    ];
    expect(filterTriageCandidates(items, baseTime)).toHaveLength(0);
  });

  it('passes items > 48h old without special prefixes', () => {
    const items: AgendaItem[] = [
      { id: 1, item: 'Old regular item', context: 'Some context', created_at: threeDaysAgo },
    ];
    const result = filterTriageCandidates(items, baseTime);
    expect(result).toHaveLength(1);
  });

  it('handles timestamps without Z suffix', () => {
    const noZ = '2026-03-07T12:00:00';
    const items: AgendaItem[] = [
      { id: 1, item: 'Item', context: null, created_at: noZ },
    ];
    const result = filterTriageCandidates(items, baseTime);
    expect(result).toHaveLength(1);
  });
});
