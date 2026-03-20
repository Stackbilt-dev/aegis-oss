// Episodic memory tests — outcome sanitization, recording, retrograde,
// token estimation, history budgeting

import { describe, it, expect } from 'vitest';
import {
  sanitizeEpisodicOutcome,
  recordEpisode,
  retrogradeEpisode,
  getRecentEpisodes,
  getEpisodeStats,
  getConversationHistory,
  estimateTokens,
  budgetConversationHistory,
} from '../../src/kernel/memory/episodic.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(opts: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Array<{ results: Record<string, unknown>[] }>;
  runResults?: Array<{ success: boolean }>;
} = {}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let allIdx = 0;
  let runIdx = 0;

  return {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          return (opts.firstResults?.[firstIdx++] ?? null) as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return (opts.allResults?.[allIdx++] ?? { results: [] }) as { results: T[] };
        },
        async run() {
          return opts.runResults?.[runIdx++] ?? { success: true };
        },
      };
    },
    _queries: queries,
  } as unknown as D1Database & { _queries: MockQuery[] };
}

// ─── sanitizeEpisodicOutcome ─────────────────────────────────

describe('sanitizeEpisodicOutcome', () => {
  it('passes through "success"', () => {
    expect(sanitizeEpisodicOutcome('success')).toBe('success');
  });

  it('maps "failure" to "failure"', () => {
    expect(sanitizeEpisodicOutcome('failure')).toBe('failure');
  });

  it('maps partial_failure to failure', () => {
    expect(sanitizeEpisodicOutcome('partial_failure')).toBe('failure');
  });

  it('maps null to failure', () => {
    expect(sanitizeEpisodicOutcome(null)).toBe('failure');
  });

  it('maps undefined to failure', () => {
    expect(sanitizeEpisodicOutcome(undefined)).toBe('failure');
  });

  it('maps unknown strings to failure', () => {
    expect(sanitizeEpisodicOutcome('error')).toBe('failure');
    expect(sanitizeEpisodicOutcome('blocked')).toBe('failure');
    expect(sanitizeEpisodicOutcome('')).toBe('failure');
  });
});

// ─── recordEpisode ───────────────────────────────────────────

describe('recordEpisode', () => {
  it('inserts episode with sanitized outcome', async () => {
    const db = createMockDb({ runResults: [{ success: true }] });

    await recordEpisode(db, {
      intent_class: 'greeting',
      channel: 'web',
      summary: 'User said hello',
      outcome: 'success',
      cost: 0.001,
      latency_ms: 150,
    });

    expect(db._queries).toHaveLength(1);
    expect(db._queries[0].sql).toContain('INSERT INTO episodic_memory');
    expect(db._queries[0].bindings[0]).toBe('greeting');
    expect(db._queries[0].bindings[3]).toBe('success');
  });

  it('sanitizes invalid outcome to failure before insert', async () => {
    const db = createMockDb({ runResults: [{ success: true }] });

    await recordEpisode(db, {
      intent_class: 'code_task',
      channel: 'web',
      summary: 'Task ran',
      outcome: 'partial_failure' as 'success',
      cost: 0.1,
      latency_ms: 5000,
    });

    // Outcome should be sanitized to 'failure'
    expect(db._queries[0].bindings[3]).toBe('failure');
  });

  it('handles optional fields as null', async () => {
    const db = createMockDb({ runResults: [{ success: true }] });

    await recordEpisode(db, {
      intent_class: 'test',
      channel: 'cli',
      summary: 'test',
      outcome: 'success',
      cost: 0,
      latency_ms: 0,
    });

    // near_miss, classifier_confidence, thread_id, executor should be null
    const bindings = db._queries[0].bindings;
    expect(bindings[6]).toBeNull(); // near_miss
    expect(bindings[7]).toBeNull(); // classifier_confidence
    expect(bindings[9]).toBeNull(); // thread_id
    expect(bindings[10]).toBeNull(); // executor
  });
});

// ─── retrogradeEpisode ──────────────────────────────────────

describe('retrogradeEpisode', () => {
  it('returns null when no success episode found', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await retrogradeEpisode(db, 'thread-123');
    expect(result).toBeNull();
  });

  it('marks last success episode as failure', async () => {
    const db = createMockDb({
      firstResults: [{ id: 5, outcome: 'success', thread_id: 'thread-123' }],
      runResults: [{ success: true }],
    });

    const result = await retrogradeEpisode(db, 'thread-123');
    expect(result).not.toBeNull();
    expect(result!.id).toBe(5);

    // Should have run an UPDATE to set outcome='failure'
    expect(db._queries).toHaveLength(2);
    expect(db._queries[1].sql).toContain("outcome = 'failure'");
    expect(db._queries[1].bindings).toContain(5);
  });
});

// ─── getRecentEpisodes ──────────────────────────────────────

describe('getRecentEpisodes', () => {
  it('queries by intent class with limit', async () => {
    const db = createMockDb({
      allResults: [{
        results: [
          { id: 1, intent_class: 'greeting', outcome: 'success' },
          { id: 2, intent_class: 'greeting', outcome: 'failure' },
        ],
      }],
    });

    const result = await getRecentEpisodes(db, 'greeting', 10);
    expect(result).toHaveLength(2);
    expect(db._queries[0].bindings).toEqual(['greeting', 10]);
  });
});

// ─── getEpisodeStats ────────────────────────────────────────

describe('getEpisodeStats', () => {
  it('returns null for no episodes', async () => {
    const db = createMockDb({ firstResults: [{ count: 0, success_rate: 0, avg_cost: 0, avg_latency: 0 }] });
    const result = await getEpisodeStats(db, 'unknown_class');
    expect(result).toBeNull();
  });

  it('returns computed stats', async () => {
    const db = createMockDb({
      firstResults: [{ count: 10, success_rate: 0.8, avg_cost: 0.05, avg_latency: 200 }],
    });

    const result = await getEpisodeStats(db, 'greeting');
    expect(result).not.toBeNull();
    expect(result!.count).toBe(10);
    expect(result!.successRate).toBe(0.8);
    expect(result!.avgCost).toBe(0.05);
    expect(result!.avgLatency).toBe(200);
  });
});

// ─── estimateTokens ─────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates tokens as ceil(length / 3.5)', () => {
    expect(estimateTokens('hello')).toBe(Math.ceil(5 / 3.5)); // 2
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long strings', () => {
    const text = 'a'.repeat(350);
    expect(estimateTokens(text)).toBe(100);
  });
});

// ─── budgetConversationHistory ──────────────────────────────

describe('budgetConversationHistory', () => {
  it('returns all history when within budget', () => {
    const history = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];

    const result = budgetConversationHistory(history);
    expect(result).toHaveLength(2);
  });

  it('trims oldest pairs when over budget', () => {
    // Create large messages that exceed a small budget
    const longMsg = 'x'.repeat(3500); // ~1000 tokens each
    const history = [
      { role: 'user' as const, content: longMsg },
      { role: 'assistant' as const, content: longMsg },
      { role: 'user' as const, content: longMsg },
      { role: 'assistant' as const, content: longMsg },
      { role: 'user' as const, content: 'last question' },
      { role: 'assistant' as const, content: 'last answer' },
    ];

    // Small budget: 2500 tokens available (after overhead/output reserves)
    const result = budgetConversationHistory(history, 15_000, 8_000, 4_000);
    // available = 15000 - 8000 - 4000 = 3000 tokens
    // Each long pair = ~2000 tokens, so first pairs get dropped
    expect(result.length).toBeLessThan(history.length);
    // Last pair should be preserved
    expect(result[result.length - 1].content).toBe('last answer');
  });

  it('preserves all when budget is generous', () => {
    const history = [
      { role: 'user' as const, content: 'short message' },
      { role: 'assistant' as const, content: 'short reply' },
    ];

    const result = budgetConversationHistory(history, 200_000, 8_000, 4_096);
    expect(result).toHaveLength(2);
  });

  it('returns empty-ish result for impossibly small budget', () => {
    const history = [
      { role: 'user' as const, content: 'a'.repeat(35000) },
      { role: 'assistant' as const, content: 'b'.repeat(35000) },
    ];

    // Budget = 100 - 50 - 50 = 0 tokens available
    const result = budgetConversationHistory(history, 100, 50, 50);
    expect(result.length).toBeLessThanOrEqual(history.length);
  });
});
