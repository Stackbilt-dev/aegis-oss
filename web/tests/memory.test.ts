// Memory subsystem unit tests — GitHub issue #146
// Covers: semantic.ts, episodic.ts, procedural.ts, insights.ts,
//         consolidation.ts, pruning.ts, goals.ts, agenda.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery {
  sql: string;
  bindings: unknown[];
}

function createMockDb(options: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
  runMeta?: { changes?: number; last_row_id?: number }[];
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
        async first() {
          return options.firstResults?.[firstIdx++] ?? null;
        },
        async all() {
          const results = options.allResults?.[allIdx++] ?? [];
          return { results };
        },
        async run() {
          const meta = options.runMeta?.[runIdx++] ?? { changes: 1, last_row_id: 1 };
          return { meta };
        },
      };
    },
    _queries: queries,
  } as unknown as D1Database & { _queries: MockQuery[] };
}

// ════════════════════════════════════════════════════════════════
// semantic.ts
// ════════════════════════════════════════════════════════════════

import {
  normalizeTopic,
  factHash,
  tokenize,
  jaccardSimilarity,
  computeEwaScore,
  BASE_HALF_LIFE_DAYS,
  recordMemory,
  searchMemoryByKeywords,
  recallMemory,
  getMemoryEntries,
  getAllMemoryForContext,
} from '../src/kernel/memory/semantic.js';

describe('semantic.ts', () => {
  // ─── normalizeTopic ────────────────────────────────────────
  describe('normalizeTopic', () => {
    it('lowercases and replaces spaces with underscores', () => {
      expect(normalizeTopic('Compliance Monitoring')).toBe('compliance_monitoring');
    });

    it('strips non-alphanumeric characters', () => {
      expect(normalizeTopic('hello-world!')).toBe('helloworld');
    });

    it('collapses multiple underscores', () => {
      expect(normalizeTopic('foo  bar   baz')).toBe('foo_bar_baz');
    });

    it('strips leading and trailing underscores', () => {
      expect(normalizeTopic(' _test_ ')).toBe('test');
    });

    it('maps canonical topics correctly', () => {
      expect(normalizeTopic('aegis_development')).toBe('aegis');
      expect(normalizeTopic('AEGIS_DEVELOPMENT')).toBe('aegis');
      expect(normalizeTopic('imgforge')).toBe('img_forge');
      expect(normalizeTopic('bizops_improvements')).toBe('bizops');
      expect(normalizeTopic('dispatch_generation')).toBe('content');
      expect(normalizeTopic('self_improvement_outcomes')).toBe('self_improvement');
      expect(normalizeTopic('organization_governance')).toBe('organization');
    });

    it('passes through unknown topics unchanged', () => {
      expect(normalizeTopic('unique_topic')).toBe('unique_topic');
    });
  });

  // ─── factHash ──────────────────────────────────────────────
  describe('factHash', () => {
    it('returns 8-character hex string', () => {
      const hash = factHash('aegis', 'some fact');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('is deterministic', () => {
      const h1 = factHash('topic', 'fact');
      const h2 = factHash('topic', 'fact');
      expect(h1).toBe(h2);
    });

    it('normalizes whitespace in the fact', () => {
      const h1 = factHash('topic', 'hello   world');
      const h2 = factHash('topic', 'hello world');
      expect(h1).toBe(h2);
    });

    it('is case-insensitive for fact text', () => {
      const h1 = factHash('topic', 'Hello World');
      const h2 = factHash('topic', 'hello world');
      expect(h1).toBe(h2);
    });

    it('differs for different topics', () => {
      const h1 = factHash('aegis', 'same fact');
      const h2 = factHash('bizops', 'same fact');
      expect(h1).not.toBe(h2);
    });
  });

  // ─── tokenize ──────────────────────────────────────────────
  describe('tokenize', () => {
    it('removes stop words', () => {
      const tokens = tokenize('the cat is on the mat');
      expect(tokens.has('the')).toBe(false);
      expect(tokens.has('is')).toBe(false);
      expect(tokens.has('on')).toBe(false);
      expect(tokens.has('cat')).toBe(true);
      expect(tokens.has('mat')).toBe(true);
    });

    it('removes single-character words', () => {
      const tokens = tokenize('I have a b test');
      expect(tokens.has('test')).toBe(true);
      expect(tokens.has('a')).toBe(false);
      expect(tokens.has('b')).toBe(false);
    });

    it('lowercases all tokens', () => {
      const tokens = tokenize('Hello WORLD');
      expect(tokens.has('hello')).toBe(true);
      expect(tokens.has('world')).toBe(true);
    });

    it('strips non-alphanumeric characters', () => {
      const tokens = tokenize('hello-world test.case');
      expect(tokens.has('hello')).toBe(true);
      expect(tokens.has('world')).toBe(true);
      expect(tokens.has('test')).toBe(true);
      expect(tokens.has('case')).toBe(true);
    });

    it('returns a Set (no duplicates)', () => {
      const tokens = tokenize('deploy deploy deploy');
      expect(tokens.size).toBe(1);
      expect(tokens.has('deploy')).toBe(true);
    });
  });

  // ─── jaccardSimilarity ────────────────────────────────────
  describe('jaccardSimilarity', () => {
    it('returns 1 for identical sets', () => {
      const s = new Set(['a', 'b', 'c']);
      expect(jaccardSimilarity(s, s)).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      const a = new Set(['a', 'b']);
      const b = new Set(['c', 'd']);
      expect(jaccardSimilarity(a, b)).toBe(0);
    });

    it('returns 1 for two empty sets', () => {
      expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    });

    it('computes partial overlap correctly', () => {
      const a = new Set(['a', 'b', 'c']);
      const b = new Set(['b', 'c', 'd']);
      // intersection=2, union=4
      expect(jaccardSimilarity(a, b)).toBe(0.5);
    });

    it('handles one empty set as 0', () => {
      const a = new Set(['a']);
      const b = new Set<string>();
      expect(jaccardSimilarity(a, b)).toBe(0);
    });
  });

  // ─── computeEwaScore ──────────────────────────────────────
  describe('computeEwaScore', () => {
    it('returns maximum score for fresh strong confident memory', () => {
      const score = computeEwaScore(0, 5, 1.0);
      // daysSince=0 → recency = 2^0 = 1
      // strength=5 → log2(6)/5 ≈ 0.5170
      // score = 0.6*1 + 0.3*0.5170 + 0.1*1.0 = 0.6 + 0.1551 + 0.1 = 0.8551
      expect(score).toBeCloseTo(0.855, 2);
    });

    it('decays with time', () => {
      const fresh = computeEwaScore(0, 1, 0.8);
      const old = computeEwaScore(30, 1, 0.8);
      expect(fresh).toBeGreaterThan(old);
    });

    it('decays slower with higher strength', () => {
      const weak = computeEwaScore(14, 1, 0.8);
      const strong = computeEwaScore(14, 3, 0.8);
      expect(strong).toBeGreaterThan(weak);
    });

    it('strength=1 at half-life days gives 0.5 recency', () => {
      // 2^(-14 / (1*14)) = 2^(-1) = 0.5
      const score = computeEwaScore(BASE_HALF_LIFE_DAYS, 1, 0.5);
      const expectedRecency = 0.5;
      const expectedStrength = Math.log2(2) / 5; // 0.2
      const expected = 0.6 * expectedRecency + 0.3 * expectedStrength + 0.1 * 0.5;
      expect(score).toBeCloseTo(expected, 5);
    });

    it('handles zero strength gracefully (strength + 1 prevents NaN)', () => {
      // strength=0 → log2(1)/5 = 0
      // recency = 2^(-10 / (0 * 14)) = 2^(-Infinity) = 0
      const score = computeEwaScore(10, 0, 0.5);
      // recency is 0 (2^(-Inf)), strength is 0, confidence is 0.5
      expect(score).toBeCloseTo(0.1 * 0.5, 5);
    });

    it('very old memory with low strength gives near-zero', () => {
      const score = computeEwaScore(365, 1, 0.5);
      expect(score).toBeLessThan(0.15);
    });
  });

  // ─── recordMemory ─────────────────────────────────────────
  describe('recordMemory', () => {
    it('updates confidence on exact hash match (dedup phase 1)', async () => {
      const db = createMockDb({
        // Phase 1: SELECT finds existing entry
        firstResults: [{ id: 42, confidence: 0.7 }],
        runMeta: [{ changes: 1 }],
      });

      await recordMemory(db, 'aegis', 'some fact', 0.9, 'test');

      // Should have run SELECT then UPDATE
      expect(db._queries).toHaveLength(2);
      expect(db._queries[0].sql).toContain('SELECT');
      expect(db._queries[0].sql).toContain('fact_hash');
      expect(db._queries[1].sql).toContain('UPDATE');
      expect(db._queries[1].sql).toContain('MAX(confidence');
    });

    it('inserts new entry when no match found (phase 3)', async () => {
      const db = createMockDb({
        // Phase 1: no hash match
        firstResults: [null],
        // Phase 2: no semantic match (empty topic entries)
        allResults: [[]],
        runMeta: [{ changes: 1 }],
      });

      await recordMemory(db, 'aegis', 'brand new fact', 0.8, 'test');

      expect(db._queries).toHaveLength(3);
      // Phase 1 SELECT, Phase 2 SELECT, Phase 3 INSERT
      expect(db._queries[2].sql).toContain('INSERT INTO memory_entries');
    });

    it('supersedes semantically similar entry (phase 2)', async () => {
      const db = createMockDb({
        // Phase 1: no hash match
        firstResults: [null],
        // Phase 2: topic entries with similar content
        allResults: [[{ id: 10, fact: 'deploy workers cloudflare edge', confidence: 0.7 }]],
        // UPDATE old entry (invalidate) + INSERT new + UPDATE back-link
        runMeta: [{ changes: 1 }, { changes: 1, last_row_id: 11 }, { changes: 1 }],
      });

      await recordMemory(db, 'aegis', 'deploy workers cloudflare edge setup', 0.85, 'test');

      // Should have: SELECT hash, SELECT topic, UPDATE invalidate, INSERT, UPDATE back-link
      expect(db._queries.length).toBeGreaterThanOrEqual(4);
      const updateQuery = db._queries.find(q => q.sql.includes('valid_until'));
      expect(updateQuery).toBeDefined();
    });

    it('normalizes topic before any DB operation', async () => {
      const db = createMockDb({
        firstResults: [null],
        allResults: [[]],
      });

      await recordMemory(db, 'AEGIS_DEVELOPMENT', 'test fact', 0.8, 'test');

      // Topic should be normalized to 'aegis'
      expect(db._queries[0].bindings[0]).toBe('aegis');
    });
  });

  // ─── searchMemoryByKeywords ────────────────────────────────
  describe('searchMemoryByKeywords', () => {
    it('returns empty for queries with only stop/short words', async () => {
      const db = createMockDb();
      const results = await searchMemoryByKeywords(db, 'the is a on');
      expect(results).toEqual([]);
      expect(db._queries).toHaveLength(0);
    });

    it('builds LIKE clauses for significant keywords', async () => {
      const db = createMockDb({
        allResults: [[
          { id: 1, topic: 'aegis', fact: 'deploy worker to cloudflare', confidence: 0.9 },
        ]],
      });

      const results = await searchMemoryByKeywords(db, 'deploy cloudflare worker');

      expect(results).toHaveLength(1);
      expect(db._queries[0].sql).toContain('LIKE');
      // Should have 3 keyword bindings + 1 limit binding
      expect(db._queries[0].bindings).toHaveLength(4); // 3 keywords + limit=10
    });

    it('respects custom limit', async () => {
      const db = createMockDb({ allResults: [[]] });
      await searchMemoryByKeywords(db, 'deploy worker setup', 5);
      const lastBinding = db._queries[0].bindings[db._queries[0].bindings.length - 1];
      expect(lastBinding).toBe(5);
    });

    it('filters words <= 3 chars from keywords', async () => {
      const db = createMockDb({ allResults: [[]] });
      await searchMemoryByKeywords(db, 'a the big cat runs');
      // "big" is 3 chars → filtered, "runs" is 4 → kept, "cat" is 3 → filtered
      // Only "runs" should be a keyword
      expect(db._queries[0].bindings[0]).toBe('%runs%');
    });
  });

  // ─── recallMemory ─────────────────────────────────────────
  describe('recallMemory', () => {
    it('does nothing for empty ids', async () => {
      const db = createMockDb();
      await recallMemory(db, []);
      expect(db._queries).toHaveLength(0);
    });

    it('builds batch UPDATE with correct placeholders', async () => {
      const db = createMockDb({ runMeta: [{ changes: 3 }] });
      await recallMemory(db, [1, 2, 3]);
      expect(db._queries).toHaveLength(1);
      expect(db._queries[0].sql).toContain('strength = strength + 1');
      expect(db._queries[0].sql).toContain('?,?,?');
      expect(db._queries[0].bindings).toEqual([1, 2, 3]);
    });
  });

  // ─── getMemoryEntries ─────────────────────────────────────
  describe('getMemoryEntries', () => {
    it('filters by normalized topic when provided', async () => {
      const db = createMockDb({
        allResults: [[{ id: 1, topic: 'aegis', fact: 'test' }]],
      });
      await getMemoryEntries(db, 'AEGIS_DEVELOPMENT');
      expect(db._queries[0].bindings[0]).toBe('aegis');
    });

    it('fetches all entries (capped 100) when no topic', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getMemoryEntries(db);
      expect(db._queries[0].sql).toContain('LIMIT 100');
      expect(db._queries[0].bindings).toHaveLength(0);
    });
  });

  // ─── getAllMemoryForContext ────────────────────────────────
  describe('getAllMemoryForContext', () => {
    it('returns empty text and ids for no entries', async () => {
      const db = createMockDb({ allResults: [[]] });
      const result = await getAllMemoryForContext(db);
      expect(result.text).toBe('');
      expect(result.ids).toEqual([]);
    });

    it('formats entries by topic with EWA scoring', async () => {
      const now = new Date().toISOString();
      const db = createMockDb({
        allResults: [[
          { id: 1, topic: 'aegis', fact: 'fact one', confidence: 0.9, strength: 2, last_recalled_at: null, created_at: now },
          { id: 2, topic: 'bizops', fact: 'fact two', confidence: 0.8, strength: 1, last_recalled_at: null, created_at: now },
        ]],
      });

      const result = await getAllMemoryForContext(db);
      expect(result.text).toContain('## Agent Memory');
      expect(result.text).toContain('### aegis');
      expect(result.text).toContain('fact one');
      expect(result.text).toContain('### bizops');
      expect(result.ids).toContain(1);
      expect(result.ids).toContain(2);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// episodic.ts
// ════════════════════════════════════════════════════════════════

import {
  sanitizeEpisodicOutcome,
  recordEpisode,
  retrogradeEpisode,
  getRecentEpisodes,
  estimateTokens,
  budgetConversationHistory,
} from '../src/kernel/memory/episodic.js';

describe('episodic.ts', () => {
  // ─── sanitizeEpisodicOutcome ──────────────────────────────
  describe('sanitizeEpisodicOutcome', () => {
    it('passes through success', () => {
      expect(sanitizeEpisodicOutcome('success')).toBe('success');
    });

    it('passes through failure', () => {
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

    it('maps arbitrary strings to failure', () => {
      expect(sanitizeEpisodicOutcome('error')).toBe('failure');
      expect(sanitizeEpisodicOutcome('blocked')).toBe('failure');
      expect(sanitizeEpisodicOutcome('')).toBe('failure');
    });
  });

  // ─── recordEpisode ────────────────────────────────────────
  describe('recordEpisode', () => {
    it('inserts episode with sanitized outcome', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordEpisode(db, {
        intent_class: 'memory_recall',
        channel: 'web',
        summary: 'User asked about project status',
        outcome: 'success',
        cost: 0.003,
        latency_ms: 1200,
      });

      expect(db._queries).toHaveLength(1);
      expect(db._queries[0].sql).toContain('INSERT INTO episodic_memory');
      expect(db._queries[0].bindings[0]).toBe('memory_recall');
      expect(db._queries[0].bindings[3]).toBe('success');
    });

    it('sanitizes bad outcome values before insert', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordEpisode(db, {
        intent_class: 'chat',
        channel: 'web',
        summary: 'Partial failure scenario',
        outcome: 'partial_failure' as any,
        cost: 0.01,
        latency_ms: 500,
      });

      // outcome should be sanitized to 'failure'
      expect(db._queries[0].bindings[3]).toBe('failure');
    });

    it('handles optional fields as null', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordEpisode(db, {
        intent_class: 'chat',
        channel: 'cli',
        summary: 'test',
        outcome: 'success',
        cost: 0,
        latency_ms: 100,
      });

      // near_miss, classifier_confidence, thread_id, executor should be null
      const bindings = db._queries[0].bindings;
      expect(bindings[6]).toBeNull(); // near_miss
      expect(bindings[7]).toBeNull(); // classifier_confidence
      expect(bindings[9]).toBeNull(); // thread_id
      expect(bindings[10]).toBeNull(); // executor
    });
  });

  // ─── retrogradeEpisode ────────────────────────────────────
  describe('retrogradeEpisode', () => {
    it('returns null when no successful episode exists', async () => {
      const db = createMockDb({ firstResults: [null] });
      const result = await retrogradeEpisode(db, 'thread-123');
      expect(result).toBeNull();
    });

    it('updates last success to failure and returns the episode', async () => {
      const episode = { id: 5, thread_id: 'thread-123', outcome: 'success', summary: 'test' };
      const db = createMockDb({
        firstResults: [episode],
        runMeta: [{ changes: 1 }],
      });

      const result = await retrogradeEpisode(db, 'thread-123');
      expect(result).toEqual(episode);
      expect(db._queries[1].sql).toContain("outcome = 'failure'");
      expect(db._queries[1].bindings[0]).toBe(5);
    });
  });

  // ─── getRecentEpisodes ────────────────────────────────────
  describe('getRecentEpisodes', () => {
    it('queries by intent_class with default limit', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getRecentEpisodes(db, 'memory_recall');
      expect(db._queries[0].bindings[0]).toBe('memory_recall');
      expect(db._queries[0].bindings[1]).toBe(5);
    });

    it('respects custom limit', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getRecentEpisodes(db, 'chat', 10);
      expect(db._queries[0].bindings[1]).toBe(10);
    });
  });

  // ─── estimateTokens ──────────────────────────────────────
  describe('estimateTokens', () => {
    it('estimates based on char count / 3.5', () => {
      expect(estimateTokens('hello world')).toBe(Math.ceil(11 / 3.5));
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });
  });

  // ─── budgetConversationHistory ────────────────────────────
  describe('budgetConversationHistory', () => {
    it('returns full history when within budget', () => {
      const history = [
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'hi' },
      ];
      const result = budgetConversationHistory(history);
      expect(result).toHaveLength(2);
    });

    it('drops oldest pairs when over budget', () => {
      const longContent = 'x'.repeat(350_000); // ~100k tokens
      const history = [
        { role: 'user' as const, content: longContent },
        { role: 'assistant' as const, content: longContent },
        { role: 'user' as const, content: 'recent question' },
        { role: 'assistant' as const, content: 'recent answer' },
      ];
      // Default max = 200k tokens, overhead+output reserve = 12096
      // Available ≈ 187904 tokens. Two longContent messages ≈ 200k tokens → must drop
      const result = budgetConversationHistory(history);
      expect(result.length).toBeLessThan(history.length);
      // Should keep the recent pair
      expect(result[result.length - 1].content).toBe('recent answer');
    });

    it('drops pairs (2 at a time)', () => {
      const history = [
        { role: 'user' as const, content: 'x'.repeat(350_000) },
        { role: 'assistant' as const, content: 'x'.repeat(350_000) },
        { role: 'user' as const, content: 'keep' },
        { role: 'assistant' as const, content: 'keep' },
      ];
      const result = budgetConversationHistory(history, 200_000, 8_000, 4_096);
      // Should drop the first pair (too large)
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('keep');
    });

    it('accepts custom budget parameters', () => {
      const history = [
        { role: 'user' as const, content: 'a' },
        { role: 'assistant' as const, content: 'b' },
      ];
      // Tiny budget — even short messages should fit in 1000 tokens
      const result = budgetConversationHistory(history, 1000, 100, 100);
      expect(result).toHaveLength(2);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// procedural.ts
// ════════════════════════════════════════════════════════════════

import {
  complexityTier,
  procedureKey,
  PROCEDURE_MIN_SUCCESSES,
  PROCEDURE_MIN_SUCCESS_RATE,
  getProcedure,
  upsertProcedure,
  degradeProcedure,
  maintainProcedures,
} from '../src/kernel/memory/procedural.js';

describe('procedural.ts', () => {
  // ─── complexityTier ───────────────────────────────────────
  describe('complexityTier', () => {
    it('returns low for complexity <= 1', () => {
      expect(complexityTier(0)).toBe('low');
      expect(complexityTier(1)).toBe('low');
    });

    it('returns mid for complexity 2', () => {
      expect(complexityTier(2)).toBe('mid');
    });

    it('returns high for complexity >= 3', () => {
      expect(complexityTier(3)).toBe('high');
      expect(complexityTier(5)).toBe('high');
    });

    it('defaults to mid for undefined', () => {
      expect(complexityTier(undefined)).toBe('mid');
    });
  });

  // ─── procedureKey ─────────────────────────────────────────
  describe('procedureKey', () => {
    it('combines classification and tier', () => {
      expect(procedureKey('memory_recall', 1)).toBe('memory_recall:low');
      expect(procedureKey('chat', 2)).toBe('chat:mid');
      expect(procedureKey('code_task', 4)).toBe('code_task:high');
    });
  });

  // ─── constants ────────────────────────────────────────────
  describe('constants', () => {
    it('requires 3 successes to promote', () => {
      expect(PROCEDURE_MIN_SUCCESSES).toBe(3);
    });

    it('requires 70% success rate', () => {
      expect(PROCEDURE_MIN_SUCCESS_RATE).toBe(0.7);
    });
  });

  // ─── getProcedure ─────────────────────────────────────────
  describe('getProcedure', () => {
    it('returns null when not found', async () => {
      const db = createMockDb({ firstResults: [null] });
      const result = await getProcedure(db, 'chat:mid');
      expect(result).toBeNull();
    });

    it('returns the procedure when found', async () => {
      const proc = { id: 1, task_pattern: 'chat:mid', executor: 'groq', status: 'learned' };
      const db = createMockDb({ firstResults: [proc] });
      const result = await getProcedure(db, 'chat:mid');
      expect(result).toEqual(proc);
    });
  });

  // ─── upsertProcedure ─────────────────────────────────────
  describe('upsertProcedure', () => {
    it('inserts new learning procedure on first success', async () => {
      const db = createMockDb({
        firstResults: [null], // getProcedure returns null
        runMeta: [{ changes: 1 }],
      });

      await upsertProcedure(db, 'chat:mid', 'groq', '{}', 'success', 500, 0.001);

      // Should SELECT then INSERT
      expect(db._queries).toHaveLength(2);
      expect(db._queries[1].sql).toContain('INSERT INTO procedural_memory');
      expect(db._queries[1].bindings[0]).toBe('chat:mid');
      expect(db._queries[1].bindings[1]).toBe('groq'); // executor on success
    });

    it('sets executor to pending on first failure', async () => {
      const db = createMockDb({
        firstResults: [null],
        runMeta: [{ changes: 1 }],
      });

      await upsertProcedure(db, 'chat:mid', 'groq', '{}', 'failure', 500, 0.001);

      expect(db._queries[1].bindings[1]).toBe('pending');
    });

    it('updates existing procedure on success', async () => {
      const existing = {
        id: 1, task_pattern: 'chat:mid', executor: 'groq', executor_config: '{}',
        success_count: 2, fail_count: 0, avg_latency_ms: 400, avg_cost: 0.001,
        status: 'learning', consecutive_failures: 0, refinements: '[]',
        candidate_executor: null, candidate_successes: 0,
      };
      const db = createMockDb({
        firstResults: [existing],
        runMeta: [{ changes: 1 }],
      });

      await upsertProcedure(db, 'chat:mid', 'groq', '{}', 'success', 500, 0.002);

      expect(db._queries[1].sql).toContain('UPDATE procedural_memory');
      // success_count should be 3
      expect(db._queries[1].bindings[2]).toBe(3);
    });

    it('degrades after consecutive failures reach threshold (2)', async () => {
      const existing = {
        id: 1, task_pattern: 'chat:mid', executor: 'groq', executor_config: '{}',
        success_count: 5, fail_count: 3, avg_latency_ms: 400, avg_cost: 0.001,
        status: 'learned', consecutive_failures: 1, refinements: '[]',
        candidate_executor: null, candidate_successes: 0,
      };
      const db = createMockDb({
        firstResults: [existing],
        runMeta: [{ changes: 1 }],
      });

      await upsertProcedure(db, 'chat:mid', 'groq', '{}', 'failure', 500, 0.002);

      // consecutive_failures: 1+1=2 → degrades
      const statusBinding = db._queries[1].bindings[6]; // status
      expect(statusBinding).toBe('degraded');
    });

    it('resets consecutive failures on success', async () => {
      const existing = {
        id: 1, task_pattern: 'chat:mid', executor: 'groq', executor_config: '{}',
        success_count: 3, fail_count: 2, avg_latency_ms: 400, avg_cost: 0.001,
        status: 'learned', consecutive_failures: 1, refinements: '[]',
        candidate_executor: null, candidate_successes: 0,
      };
      const db = createMockDb({
        firstResults: [existing],
        runMeta: [{ changes: 1 }],
      });

      await upsertProcedure(db, 'chat:mid', 'groq', '{}', 'success', 500, 0.002);

      const consecFailuresBinding = db._queries[1].bindings[7]; // consecutive_failures
      expect(consecFailuresBinding).toBe(0);
    });

    it('keeps broken status permanently', async () => {
      const existing = {
        id: 1, task_pattern: 'chat:mid', executor: 'groq', executor_config: '{}',
        success_count: 1, fail_count: 10, avg_latency_ms: 400, avg_cost: 0.001,
        status: 'broken', consecutive_failures: 5, refinements: '[]',
        candidate_executor: null, candidate_successes: 0,
      };
      const db = createMockDb({
        firstResults: [existing],
        runMeta: [{ changes: 1 }],
      });

      await upsertProcedure(db, 'chat:mid', 'groq', '{}', 'failure', 500, 0.002);

      const statusBinding = db._queries[1].bindings[6];
      expect(statusBinding).toBe('broken');
    });
  });

  // ─── degradeProcedure ─────────────────────────────────────
  describe('degradeProcedure', () => {
    it('does nothing when procedure not found', async () => {
      const db = createMockDb({ firstResults: [null] });
      await degradeProcedure(db, 'unknown:mid', 'groq');
      // Only 1 query (the SELECT)
      expect(db._queries).toHaveLength(1);
    });

    it('increments failures and adds negative refinement', async () => {
      const existing = {
        id: 1, task_pattern: 'chat:mid', executor: 'groq', executor_config: '{}',
        success_count: 5, fail_count: 1, avg_latency_ms: 400, avg_cost: 0.001,
        status: 'learned', consecutive_failures: 0, refinements: '[]',
        candidate_executor: null, candidate_successes: 0,
      };
      const db = createMockDb({
        // getProcedure in degradeProcedure
        firstResults: [existing, existing], // addRefinement also calls getProcedure
        runMeta: [{ changes: 1 }, { changes: 1 }],
      });

      await degradeProcedure(db, 'chat:mid', 'groq');

      // Should UPDATE fail_count and add refinement
      expect(db._queries.length).toBeGreaterThanOrEqual(2);
      expect(db._queries[1].sql).toContain('UPDATE procedural_memory');
      expect(db._queries[1].bindings[0]).toBe(2); // fail_count: 1+1
    });
  });

  // ─── maintainProcedures ───────────────────────────────────
  describe('maintainProcedures', () => {
    it('resets stale learned procedures to learning', async () => {
      const db = createMockDb({
        // Stale procedures query
        allResults: [
          [{ task_pattern: 'old:mid' }],
          [], // low-utility query returns nothing
        ],
        runMeta: [{ changes: 1 }],
      });

      await maintainProcedures(db);

      const updateQuery = db._queries.find(q =>
        q.sql.includes("status = 'learning'") && q.sql.includes('UPDATE')
      );
      expect(updateQuery).toBeDefined();
      expect(updateQuery!.bindings[0]).toBe('old:mid');
    });

    it('degrades low-utility procedures', async () => {
      const db = createMockDb({
        allResults: [
          [], // no stale procedures
          [{ task_pattern: 'bad:mid', success_count: 1, fail_count: 9 }], // low utility
        ],
        runMeta: [{ changes: 1 }],
      });

      await maintainProcedures(db);

      const degradeQuery = db._queries.find(q =>
        q.sql.includes("status = 'degraded'") && q.sql.includes('UPDATE')
      );
      expect(degradeQuery).toBeDefined();
    });
  });
});

// ════════════════════════════════════════════════════════════════
// insights.ts (CRIX)
// ════════════════════════════════════════════════════════════════

import {
  publishInsight,
  validateInsight,
  promoteInsight,
  listInsights,
  type InsightPayload,
} from '../src/kernel/memory/insights.js';

describe('insights.ts', () => {
  // ─── publishInsight ───────────────────────────────────────
  describe('publishInsight', () => {
    it('rejects low confidence (< 0.75)', async () => {
      const db = createMockDb();
      const result = await publishInsight(db, {
        fact: 'test fact',
        insight_type: 'pattern',
        origin_repo: 'my-project',
        keywords: ['test'],
        confidence: 0.5,
      });

      expect(result.published).toBe(false);
      expect(result.reason).toContain('confidence');
    });

    it('rejects duplicate insights via factHash', async () => {
      const db = createMockDb({
        firstResults: [{ id: 42 }], // existing entry found
      });

      const result = await publishInsight(db, {
        fact: 'existing fact',
        insight_type: 'pattern',
        origin_repo: 'my-project',
        keywords: ['test'],
        confidence: 0.9,
      });

      expect(result.published).toBe(false);
      expect(result.reason).toContain('duplicate');
    });

    it('rejects context-specific insights (hardcoded paths)', async () => {
      const db = createMockDb({
        firstResults: [null], // no dup
      });

      const result = await publishInsight(db, {
        fact: 'The file at /home/user/test.ts has a bug',
        insight_type: 'bug_signature',
        origin_repo: 'my-project',
        keywords: ['bug'],
        confidence: 0.9,
      });

      expect(result.published).toBe(false);
      expect(result.reason).toContain('context-specific');
    });

    it('rejects context-specific insights (env vars)', async () => {
      const db = createMockDb({
        firstResults: [null],
      });

      const result = await publishInsight(db, {
        fact: 'Set $ANTHROPIC_API_KEY before running tests',
        insight_type: 'gotcha',
        origin_repo: 'my-project',
        keywords: ['env'],
        confidence: 0.9,
      });

      expect(result.published).toBe(false);
      expect(result.reason).toContain('context-specific');
    });

    it('rejects single-file references without general pattern language', async () => {
      const db = createMockDb({
        firstResults: [null],
      });

      const result = await publishInsight(db, {
        fact: 'Bug found in dispatch.ts at line 42: the handler returns undefined',
        insight_type: 'bug_signature',
        origin_repo: 'my-project',
        keywords: ['bug'],
        confidence: 0.9,
      });

      expect(result.published).toBe(false);
      expect(result.reason).toContain('context-specific');
    });

    it('allows file references with general pattern language', async () => {
      const db = createMockDb({
        firstResults: [null], // no dup hash
        runMeta: [{ changes: 1, last_row_id: 10 }], // INSERT
      });

      const result = await publishInsight(db, {
        fact: 'When using service bindings in workers.ts: always validate the binding exists before calling RPC',
        insight_type: 'pattern',
        origin_repo: 'my-project',
        keywords: ['service', 'binding'],
        confidence: 0.85,
      });

      expect(result.published).toBe(true);
    });

    it('publishes valid insight via D1 fallback (no memory binding)', async () => {
      const db = createMockDb({
        firstResults: [null], // no dup
        // recordMemory: hash check, topic entries, insert
        allResults: [[]],
        runMeta: [{ changes: 1, last_row_id: 10 }],
      });

      const result = await publishInsight(db, {
        fact: 'Service bindings between CF Workers avoid cold start overhead, reducing p99 latency by 40ms',
        insight_type: 'perf_win',
        origin_repo: 'my-project',
        keywords: ['latency', 'service-binding'],
        confidence: 0.9,
      });

      expect(result.published).toBe(true);
    });
  });

  // ─── validateInsight ──────────────────────────────────────
  describe('validateInsight', () => {
    it('returns candidate stage when insight not found', async () => {
      const db = createMockDb({ firstResults: [null] });
      const result = await validateInsight(db, 'deadbeef', 'img-forge', true);
      expect(result.stage).toBe('candidate');
      expect(result.transitioned).toBe(false);
    });

    it('promotes candidate to validated on first confirmation', async () => {
      const db = createMockDb({
        firstResults: [{
          id: 1, validation_stage: 'candidate', validators: '[]', fact: 'test',
        }],
        runMeta: [{ changes: 1 }],
      });

      const result = await validateInsight(db, 'abc123', 'img-forge', true);
      expect(result.stage).toBe('validated');
      expect(result.transitioned).toBe(true);
    });

    it('refutes immediately on negative confirmation', async () => {
      const db = createMockDb({
        firstResults: [{
          id: 1, validation_stage: 'candidate', validators: '[]', fact: 'test',
        }],
        runMeta: [{ changes: 1 }],
      });

      const result = await validateInsight(db, 'abc123', 'img-forge', false);
      expect(result.stage).toBe('refuted');
      expect(result.transitioned).toBe(true);
    });

    it('does not transition terminal stages (canonical)', async () => {
      const db = createMockDb({
        firstResults: [{
          id: 1, validation_stage: 'canonical', validators: '[]', fact: 'test',
        }],
      });

      const result = await validateInsight(db, 'abc123', 'img-forge', true);
      expect(result.stage).toBe('canonical');
      expect(result.transitioned).toBe(false);
    });

    it('does not transition terminal stages (refuted)', async () => {
      const db = createMockDb({
        firstResults: [{
          id: 1, validation_stage: 'refuted', validators: '[]', fact: 'test',
        }],
      });

      const result = await validateInsight(db, 'abc123', 'img-forge', true);
      expect(result.stage).toBe('refuted');
      expect(result.transitioned).toBe(false);
    });

    it('promotes validated to expert after 2+ confirmations', async () => {
      const db = createMockDb({
        firstResults: [{
          id: 1, validation_stage: 'validated',
          validators: JSON.stringify([{ repo: 'repo-a', confirmed: true, date: '2026-01-01' }]),
          fact: 'test',
        }],
        runMeta: [{ changes: 1 }],
      });

      const result = await validateInsight(db, 'abc123', 'repo-b', true);
      expect(result.stage).toBe('expert');
      expect(result.transitioned).toBe(true);
    });
  });

  // ─── promoteInsight ───────────────────────────────────────
  describe('promoteInsight', () => {
    it('returns not found for missing insight', async () => {
      const db = createMockDb({ firstResults: [null] });
      const result = await promoteInsight(db, 'deadbeef', 'canonical');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('rejects invalid transitions (candidate to canonical)', async () => {
      const db = createMockDb({
        firstResults: [{ id: 1, validation_stage: 'candidate' }],
      });

      const result = await promoteInsight(db, 'abc123', 'canonical');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('canonical promotion requires expert stage');
    });

    it('rejects promotion from validated directly to canonical', async () => {
      const db = createMockDb({
        firstResults: [{ id: 1, validation_stage: 'validated' }],
      });

      const result = await promoteInsight(db, 'abc123', 'canonical');
      expect(result.success).toBe(false);
    });

    it('allows validated to expert promotion', async () => {
      const db = createMockDb({
        firstResults: [{ id: 1, validation_stage: 'validated' }],
        runMeta: [{ changes: 1 }],
      });

      const result = await promoteInsight(db, 'abc123', 'expert');
      expect(result.success).toBe(true);
    });

    it('allows expert to canonical promotion', async () => {
      const db = createMockDb({
        firstResults: [{ id: 1, validation_stage: 'expert' }],
        runMeta: [{ changes: 1 }],
      });

      const result = await promoteInsight(db, 'abc123', 'canonical');
      expect(result.success).toBe(true);
    });

    it('rejects promotion from refuted', async () => {
      const db = createMockDb({
        firstResults: [{ id: 1, validation_stage: 'refuted' }],
      });

      const result = await promoteInsight(db, 'abc123', 'expert');
      expect(result.success).toBe(false);
    });
  });

  // ─── listInsights ─────────────────────────────────────────
  describe('listInsights', () => {
    it('returns empty array on no results', async () => {
      const db = createMockDb({ allResults: [[]] });
      const results = await listInsights(db);
      expect(results).toEqual([]);
    });

    it('parses rows correctly with null validators', async () => {
      const db = createMockDb({
        allResults: [[{
          id: 1, fact: 'test insight', fact_hash: 'abc',
          validation_stage: 'candidate', confidence: 0.8,
          validators: null, created_at: '2026-03-10',
        }]],
      });

      const results = await listInsights(db);
      expect(results).toHaveLength(1);
      expect(results[0].validators).toEqual([]);
      expect(results[0].insight_type).toBeNull();
      expect(results[0].origin_repo).toBeNull();
    });

    it('filters by stage when provided', async () => {
      const db = createMockDb({ allResults: [[]] });
      await listInsights(db, { stage: 'validated' });
      expect(db._queries[0].sql).toContain('validation_stage = ?');
      expect(db._queries[0].bindings).toContain('validated');
    });

    it('returns all insights when no stage filter', async () => {
      const db = createMockDb({ allResults: [[]] });
      await listInsights(db);
      // No bindings when no stage filter is provided
      expect(db._queries[0].bindings).toHaveLength(0);
      expect(db._queries[0].sql).toContain('ORDER BY created_at DESC');
    });
  });
});

// ════════════════════════════════════════════════════════════════
// consolidation.ts
// ════════════════════════════════════════════════════════════════

// consolidateEpisodicToSemantic depends on askGroq, so we test
// the guards and parsing logic by controlling the DB mock returns.

import { consolidateEpisodicToSemantic } from '../src/kernel/memory/consolidation.js';

// Mock groq module
vi.mock('../src/groq.js', () => ({
  askGroq: vi.fn(),
}));

import { askGroq } from '../src/groq.js';
const mockAskGroq = vi.mocked(askGroq);

describe('consolidation.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('consolidateEpisodicToSemantic', () => {
    it('skips when fewer than 3 episodes since last run', async () => {
      const db = createMockDb({
        // last consolidation watermark
        firstResults: [{ received_at: '2026-03-10 00:00:00' }],
        // fewer than 3 episodes
        allResults: [[
          { id: 1, intent_class: 'chat', channel: 'web', summary: 'test', outcome: 'success', cost: 0.01 },
        ]],
      });

      await consolidateEpisodicToSemantic(db, 'fake-key', 'llama3');

      expect(mockAskGroq).not.toHaveBeenCalled();
    });

    it('calls Groq when enough episodes exist', async () => {
      mockAskGroq.mockResolvedValue('[]');

      const episodes = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, intent_class: 'chat', channel: 'web',
        summary: `Episode ${i}`, outcome: 'success', cost: 0.01,
      }));

      const db = createMockDb({
        firstResults: [null], // no watermark
        allResults: [
          episodes,           // episodes query
          [],                 // existing memory
        ],
        runMeta: [{ changes: 1 }], // watermark update
      });

      await consolidateEpisodicToSemantic(db, 'fake-key', 'llama3');

      expect(mockAskGroq).toHaveBeenCalledOnce();
    });

    it('processes ADD operations from Groq response', async () => {
      const addOps = JSON.stringify([
        { operation: 'ADD', topic: 'aegis', fact: 'Version 1.30.1 deployed successfully on 2026-03-10', confidence: 0.85 },
      ]);
      mockAskGroq.mockResolvedValue(addOps);

      const episodes = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, intent_class: 'chat', channel: 'web',
        summary: `Episode ${i}`, outcome: 'success', cost: 0.01,
      }));

      const db = createMockDb({
        firstResults: [
          null, // watermark
        ],
        allResults: [
          episodes,  // episodes query
        ],
        runMeta: [
          { changes: 1 }, // watermark update
        ],
      });

      // ADD operations require memoryBinding (source uses memoryBinding.store)
      const mockStore = vi.fn().mockResolvedValue(undefined);
      const mockRecallFn = vi.fn().mockResolvedValue([]);
      const memBinding = { store: mockStore, recall: mockRecallFn, forget: vi.fn(), health: vi.fn() };

      await consolidateEpisodicToSemantic(db, 'fake-key', 'llama3', undefined, memBinding as any);

      // Should have stored via memoryBinding
      expect(mockStore).toHaveBeenCalledWith('aegis', expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Version 1.30.1'), topic: 'aegis' }),
      ]));
    });

    it('processes DELETE operations from Groq response', async () => {
      const deleteOps = JSON.stringify([
        { operation: 'DELETE', target_id: 42, reason: 'obsolete' },
      ]);
      mockAskGroq.mockResolvedValue(deleteOps);

      const episodes = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, intent_class: 'chat', channel: 'web',
        summary: `Episode ${i}`, outcome: 'success', cost: 0.01,
      }));

      const db = createMockDb({
        firstResults: [null], // watermark
        allResults: [
          episodes,
          [], // existing memory
        ],
        runMeta: [
          { changes: 1 }, // soft delete
          { changes: 1 }, // watermark
        ],
      });

      await consolidateEpisodicToSemantic(db, 'fake-key', 'llama3');

      const deleteQuery = db._queries.find(q => q.sql.includes('valid_until') && q.sql.includes('UPDATE'));
      expect(deleteQuery).toBeDefined();
    });

    it('skips ADD operations with short facts (< 30 chars)', async () => {
      const ops = JSON.stringify([
        { operation: 'ADD', topic: 'aegis', fact: 'Too short', confidence: 0.8 },
      ]);
      mockAskGroq.mockResolvedValue(ops);

      const episodes = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, intent_class: 'chat', channel: 'web',
        summary: `Episode ${i}`, outcome: 'success', cost: 0.01,
      }));

      const db = createMockDb({
        firstResults: [null],
        allResults: [episodes, []],
        runMeta: [{ changes: 1 }], // only watermark
      });

      await consolidateEpisodicToSemantic(db, 'fake-key', 'llama3');

      // Should NOT have inserted any memory (short fact filtered)
      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO memory_entries'));
      expect(insertQuery).toBeUndefined();
    });

    it('handles malformed Groq response gracefully', async () => {
      mockAskGroq.mockResolvedValue('not json at all');

      const episodes = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, intent_class: 'chat', channel: 'web',
        summary: `Episode ${i}`, outcome: 'success', cost: 0.01,
      }));

      const db = createMockDb({
        firstResults: [null],
        allResults: [episodes, []],
      });

      // Should not throw
      await expect(
        consolidateEpisodicToSemantic(db, 'fake-key', 'llama3')
      ).resolves.not.toThrow();
    });

    it('caps operations at 3 per run', async () => {
      const ops = JSON.stringify([
        { operation: 'ADD', topic: 'a', fact: 'Fact about system A with version 1.0 deployed', confidence: 0.8 },
        { operation: 'ADD', topic: 'b', fact: 'Fact about system B with version 2.0 deployed', confidence: 0.8 },
        { operation: 'ADD', topic: 'c', fact: 'Fact about system C with version 3.0 deployed', confidence: 0.8 },
        { operation: 'ADD', topic: 'd', fact: 'Fact about system D with version 4.0 should be skipped', confidence: 0.8 },
      ]);
      mockAskGroq.mockResolvedValue(ops);

      const episodes = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, intent_class: 'chat', channel: 'web',
        summary: `Episode ${i}`, outcome: 'success', cost: 0.01,
      }));

      // We need enough mock results for 3 recordMemory calls
      const db = createMockDb({
        firstResults: [
          null, // watermark
          null, null, null, // 3x recordMemory phase 1 (no hash dup)
        ],
        allResults: [
          episodes,
          [], // existing memory
          [], [], [], // 3x recordMemory phase 2
        ],
        runMeta: [
          { changes: 1, last_row_id: 50 },
          { changes: 1, last_row_id: 51 },
          { changes: 1, last_row_id: 52 },
          { changes: 1 }, // watermark
        ],
      });

      await consolidateEpisodicToSemantic(db, 'fake-key', 'llama3');

      // Count INSERT queries for memory_entries (not watermark)
      const inserts = db._queries.filter(q =>
        q.sql.includes('INSERT INTO memory_entries')
      );
      expect(inserts.length).toBeLessThanOrEqual(3);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// pruning.ts
// ════════════════════════════════════════════════════════════════

import { pruneMemory } from '../src/kernel/memory/pruning.js';

describe('pruning.ts', () => {
  describe('pruneMemory', () => {
    it('runs all pruning phases', async () => {
      const now = new Date();
      const db = createMockDb({
        // Phase 1: DELETE expired
        // Phase 2: DELETE low-confidence old
        // Phase 3: topics query
        allResults: [
          [{ topic: 'aegis' }, { topic: 'bizops' }], // topics
          // Phase 3c retention: active entries
          [{
            id: 1, strength: 1,
            last_recalled_at: null,
            created_at: new Date(now.getTime() - 365 * 86_400_000).toISOString(),
          }],
        ],
        runMeta: [
          { changes: 0 }, // phase 1: delete expired
          { changes: 0 }, // phase 2: delete low-confidence
          { changes: 0 }, // phase 3: cap topic 'aegis'
          { changes: 0 }, // phase 3: cap topic 'bizops'
          { changes: 0 }, // phase 3b: purge old superseded
          // phase 3c: handled by allResults above, then individual updates
          { changes: 1 }, // soft-delete low retention entry
          { changes: 0 }, // phase 4: prune stale events
          { changes: 0 }, // phase 5: prune old heartbeats
        ],
      });

      await pruneMemory(db);

      // Should run at least: expired delete, low-conf delete, topics query, per-topic cap, superseded purge, retention scan, events, heartbeats
      expect(db._queries.length).toBeGreaterThanOrEqual(6);

      // Check expired entries pruning
      expect(db._queries[0].sql).toContain('DELETE FROM memory_entries');
      expect(db._queries[0].sql).toContain('expires_at');

      // Check low-confidence pruning
      expect(db._queries[1].sql).toContain('confidence < 0.5');

      // Check events pruning
      const eventsQuery = db._queries.find(q => q.sql.includes('DELETE FROM web_events'));
      expect(eventsQuery).toBeDefined();

      // Check heartbeat pruning
      const heartbeatQuery = db._queries.find(q => q.sql.includes('DELETE FROM heartbeat_results'));
      expect(heartbeatQuery).toBeDefined();
    });

    it('soft-deletes entries with decayed retention below threshold', async () => {
      // Create an entry that's very old (1 year) with low strength
      const oneYearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();

      const db = createMockDb({
        allResults: [
          [{ topic: 'aegis' }], // topics
          [{ id: 99, strength: 1, last_recalled_at: null, created_at: oneYearAgo }], // active entries for retention scan
        ],
        runMeta: [
          { changes: 0 }, // expired
          { changes: 0 }, // low-confidence
          { changes: 0 }, // cap aegis
          { changes: 0 }, // superseded purge
          { changes: 1 }, // retention soft-delete for id 99
          { changes: 0 }, // events
          { changes: 0 }, // heartbeats
        ],
      });

      await pruneMemory(db);

      // Find the soft-delete UPDATE for retention pruning
      const retentionUpdate = db._queries.find(q =>
        q.sql.includes("valid_until = datetime('now')") &&
        q.sql.includes('UPDATE memory_entries') &&
        q.bindings.includes(99)
      );
      expect(retentionUpdate).toBeDefined();
    });

    it('preserves entries with sufficient retention', async () => {
      // Recent entry with high strength — should NOT be pruned
      const recentDate = new Date().toISOString();

      const db = createMockDb({
        allResults: [
          [{ topic: 'aegis' }],
          [{ id: 100, strength: 5, last_recalled_at: recentDate, created_at: recentDate }],
        ],
        runMeta: [
          { changes: 0 }, // expired
          { changes: 0 }, // low-confidence
          { changes: 0 }, // cap aegis
          { changes: 0 }, // superseded
          // No retention soft-delete should happen
          { changes: 0 }, // events
          { changes: 0 }, // heartbeats
        ],
      });

      await pruneMemory(db);

      // Should NOT find a soft-delete for id 100
      const retentionUpdate = db._queries.find(q =>
        q.sql.includes("valid_until = datetime('now')") &&
        q.sql.includes('UPDATE memory_entries') &&
        q.bindings.includes(100)
      );
      expect(retentionUpdate).toBeUndefined();
    });
  });
});

// ════════════════════════════════════════════════════════════════
// goals.ts
// ════════════════════════════════════════════════════════════════

import {
  sanitizeActionOutcome,
  addGoal,
  updateGoalStatus,
  touchGoal,
  recordGoalAction,
  getActiveGoals,
  getGoalActions,
  downgradeGoalAuthority,
} from '../src/kernel/memory/goals.js';

describe('goals.ts', () => {
  // ─── sanitizeActionOutcome ────────────────────────────────
  describe('sanitizeActionOutcome', () => {
    it('passes through valid outcomes', () => {
      expect(sanitizeActionOutcome('success')).toBe('success');
      expect(sanitizeActionOutcome('failure')).toBe('failure');
      expect(sanitizeActionOutcome('pending')).toBe('pending');
    });

    it('returns null for null/undefined', () => {
      expect(sanitizeActionOutcome(null)).toBeNull();
      expect(sanitizeActionOutcome(undefined)).toBeNull();
    });

    it('maps invalid values to failure', () => {
      expect(sanitizeActionOutcome('partial_failure')).toBe('failure');
      expect(sanitizeActionOutcome('error')).toBe('failure');
      expect(sanitizeActionOutcome('blocked')).toBe('failure');
      expect(sanitizeActionOutcome('')).toBe('failure');
    });
  });

  // ─── addGoal ──────────────────────────────────────────────
  describe('addGoal', () => {
    it('inserts a goal and returns UUID', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      const id = await addGoal(db, 'Test Goal', 'Description', 12);

      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(db._queries[0].sql).toContain('INSERT INTO agent_goals');
      expect(db._queries[0].bindings[1]).toBe('Test Goal');
      expect(db._queries[0].bindings[2]).toBe('Description');
      expect(db._queries[0].bindings[3]).toBe(12);
    });

    it('defaults schedule_hours to 6', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await addGoal(db, 'Test Goal');

      expect(db._queries[0].bindings[3]).toBe(6);
    });

    it('handles null description', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await addGoal(db, 'Test Goal');

      expect(db._queries[0].bindings[2]).toBeNull();
    });
  });

  // ─── updateGoalStatus ─────────────────────────────────────
  describe('updateGoalStatus', () => {
    it('sets completed_at for completed status', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await updateGoalStatus(db, 'goal-123', 'completed');

      expect(db._queries[0].sql).toContain("datetime('now')");
      expect(db._queries[0].bindings[0]).toBe('completed');
    });

    it('sets completed_at for failed status', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await updateGoalStatus(db, 'goal-123', 'failed');

      expect(db._queries[0].sql).toContain("datetime('now')");
      expect(db._queries[0].bindings[0]).toBe('failed');
    });

    it('uses NULL for active status', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await updateGoalStatus(db, 'goal-123', 'active');

      expect(db._queries[0].sql).toContain('NULL');
      expect(db._queries[0].bindings[0]).toBe('active');
    });
  });

  // ─── touchGoal ────────────────────────────────────────────
  describe('touchGoal', () => {
    it('updates last_run_at and increments run_count', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await touchGoal(db, 'goal-123', 6);

      expect(db._queries[0].sql).toContain("last_run_at = datetime('now')");
      expect(db._queries[0].sql).toContain('run_count = run_count + 1');
      expect(db._queries[0].bindings[0]).toBe(6);
      expect(db._queries[0].bindings[1]).toBe('goal-123');
    });
  });

  // ─── recordGoalAction ─────────────────────────────────────
  describe('recordGoalAction', () => {
    it('inserts action with sanitized outcome', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordGoalAction(db, 'goal-123', 'executed', 'Did a thing', 'success');

      expect(db._queries[0].sql).toContain('INSERT INTO agent_actions');
      expect(db._queries[0].bindings[1]).toBe('goal-123');
      expect(db._queries[0].bindings[2]).toBe('executed');
      expect(db._queries[0].bindings[4]).toBe('success');
    });

    it('sanitizes invalid outcome values', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordGoalAction(db, 'goal-123', 'executed', 'Did a thing', 'partial_failure' as any);

      expect(db._queries[0].bindings[4]).toBe('failure');
    });

    it('handles null goal_id for unlinked actions', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordGoalAction(db, null, 'proposed', 'Proposed something');

      expect(db._queries[0].bindings[1]).toBeNull();
    });

    it('passes optional tool metadata', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await recordGoalAction(db, 'goal-123', 'executed', 'Called tool', 'success', {
        autoExecuted: true,
        authorityLevel: 'auto_low',
        toolCalled: 'record_memory_entry',
        toolArgsJson: '{"topic":"test"}',
        toolResultJson: '{"ok":true}',
      });

      expect(db._queries[0].bindings[5]).toBe(1); // autoExecuted → 1
      expect(db._queries[0].bindings[6]).toBe('auto_low');
      expect(db._queries[0].bindings[7]).toBe('record_memory_entry');
    });
  });

  // ─── getActiveGoals ───────────────────────────────────────
  describe('getActiveGoals', () => {
    it('queries for active goals sorted by created_at', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getActiveGoals(db);
      expect(db._queries[0].sql).toContain("status = 'active'");
      expect(db._queries[0].sql).toContain('ORDER BY created_at ASC');
    });
  });

  // ─── downgradeGoalAuthority ───────────────────────────────
  describe('downgradeGoalAuthority', () => {
    it('sets authority to propose', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await downgradeGoalAuthority(db, 'goal-123', 'too many failures');
      expect(db._queries[0].sql).toContain("authority_level = 'propose'");
      expect(db._queries[0].bindings[0]).toBe('goal-123');
    });
  });

  // ─── getGoalActions ───────────────────────────────────────
  describe('getGoalActions', () => {
    it('filters by goal_id when provided', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getGoalActions(db, 'goal-123', 10);
      expect(db._queries[0].bindings[0]).toBe('goal-123');
      expect(db._queries[0].bindings[1]).toBe(10);
    });

    it('returns all actions when no goal_id', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getGoalActions(db);
      expect(db._queries[0].sql).not.toContain('goal_id = ?');
      expect(db._queries[0].bindings[0]).toBe(20); // default limit
    });
  });
});

// ════════════════════════════════════════════════════════════════
// agenda.ts
// ════════════════════════════════════════════════════════════════

import {
  addAgendaItem,
  resolveAgendaItem,
  getActiveAgendaItems,
  getAgendaContext,
  PROPOSED_ACTION_PREFIX,
  PROPOSED_TASK_PREFIX,
  createProposedTaskAgendaItem,
} from '../src/kernel/memory/agenda.js';

describe('agenda.ts', () => {
  // ─── addAgendaItem ────────────────────────────────────────
  describe('addAgendaItem', () => {
    it('inserts new item when no duplicates exist', async () => {
      const db = createMockDb({
        // dedup query returns no candidates
        allResults: [[]],
        runMeta: [{ changes: 1, last_row_id: 42 }],
      });

      const id = await addAgendaItem(db, 'Fix deployment pipeline', 'Broken since yesterday', 'high');
      expect(id).toBe(42);
      expect(db._queries[1].sql).toContain('INSERT INTO agent_agenda');
    });

    it('returns existing id for duplicate active items', async () => {
      const db = createMockDb({
        allResults: [[{
          id: 10, item: 'Fix deployment pipeline issue', priority: 'medium', status: 'active',
        }]],
      });

      const id = await addAgendaItem(db, 'Fix the deployment pipeline problem', undefined, 'medium');
      expect(id).toBe(10);
    });

    it('upgrades priority on existing active duplicate', async () => {
      const db = createMockDb({
        allResults: [[{
          id: 10, item: 'Fix deployment pipeline issue', priority: 'low', status: 'active',
        }]],
        runMeta: [{ changes: 1 }],
      });

      const id = await addAgendaItem(db, 'Fix the deployment pipeline problem', undefined, 'high');
      expect(id).toBe(10);
      // Should have issued an UPDATE for priority upgrade
      const updateQuery = db._queries.find(q => q.sql.includes('UPDATE agent_agenda SET priority'));
      expect(updateQuery).toBeDefined();
    });

    it('suppresses re-creation of recently resolved items', async () => {
      const db = createMockDb({
        allResults: [[{
          id: 15, item: 'Fix deployment pipeline', priority: 'medium', status: 'done',
        }]],
      });

      const id = await addAgendaItem(db, 'Fix the deployment pipeline problem', undefined, 'medium');
      // Should return existing id without insert
      expect(id).toBe(15);
      expect(db._queries).toHaveLength(1); // only the SELECT
    });

    it('inserts when words are too short for dedup', async () => {
      const db = createMockDb({
        runMeta: [{ changes: 1, last_row_id: 99 }],
      });

      // All words <= 3 chars → skip dedup, go straight to insert
      const id = await addAgendaItem(db, 'do it', undefined, 'low');
      expect(id).toBe(99);
    });
  });

  // ─── resolveAgendaItem ────────────────────────────────────
  describe('resolveAgendaItem', () => {
    it('sets status and resolved_at timestamp', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await resolveAgendaItem(db, 42, 'done');
      expect(db._queries[0].sql).toContain("resolved_at = datetime('now')");
      expect(db._queries[0].bindings[0]).toBe('done');
      expect(db._queries[0].bindings[1]).toBe(42);
    });

    it('accepts dismissed status', async () => {
      const db = createMockDb({ runMeta: [{ changes: 1 }] });
      await resolveAgendaItem(db, 42, 'dismissed');
      expect(db._queries[0].bindings[0]).toBe('dismissed');
    });
  });

  // ─── getActiveAgendaItems ─────────────────────────────────
  describe('getActiveAgendaItems', () => {
    it('queries active items with priority ordering', async () => {
      const db = createMockDb({ allResults: [[]] });
      await getActiveAgendaItems(db);
      expect(db._queries[0].sql).toContain("status = 'active'");
      expect(db._queries[0].sql).toContain('CASE priority');
    });
  });

  // ─── getAgendaContext ─────────────────────────────────────
  describe('getAgendaContext', () => {
    it('returns empty string when no items', async () => {
      const db = createMockDb({ allResults: [[]] });
      const ctx = await getAgendaContext(db);
      expect(ctx).toBe('');
    });

    it('formats proposed actions separately', async () => {
      const db = createMockDb({
        allResults: [[
          { id: 1, item: '[PROPOSED ACTION] Deploy new version', context: 'Ready to ship', priority: 'high', status: 'active', created_at: '2026-03-10', resolved_at: null },
          { id: 2, item: 'Review PR #42', context: null, priority: 'medium', status: 'active', created_at: '2026-03-10', resolved_at: null },
        ]],
      });

      const ctx = await getAgendaContext(db);
      expect(ctx).toContain('Pending Proposed Actions');
      expect(ctx).toContain('Deploy new version');
      expect(ctx).toContain('Active Agenda');
      expect(ctx).toContain('Review PR #42');
    });

    it('shows approval prompt for proposed actions', async () => {
      const db = createMockDb({
        allResults: [[
          { id: 1, item: '[PROPOSED ACTION] Run backup', context: null, priority: 'high', status: 'active', created_at: '2026-03-10', resolved_at: null },
        ]],
      });

      const ctx = await getAgendaContext(db);
      expect(ctx).toContain('approve');
      expect(ctx).toContain('reject');
      expect(ctx).toContain('defer');
    });
  });

  // ─── PROPOSED_ACTION_PREFIX / PROPOSED_TASK_PREFIX ────────
  describe('constants', () => {
    it('defines correct prefixes', () => {
      expect(PROPOSED_ACTION_PREFIX).toBe('[PROPOSED ACTION]');
      expect(PROPOSED_TASK_PREFIX).toBe('[PROPOSED TASK]');
    });
  });

  // ─── createProposedTaskAgendaItem ─────────────────────────
  describe('createProposedTaskAgendaItem', () => {
    it('creates agenda item with PROPOSED TASK prefix', async () => {
      const db = createMockDb({
        allResults: [[]], // dedup check
        runMeta: [{ changes: 1, last_row_id: 77 }],
      });

      const id = await createProposedTaskAgendaItem(
        db, 'task-abc', 'Add logging', 'my-project', 'feature', 'Needed for debugging'
      );

      expect(id).toBe(77);
      const insertQuery = db._queries.find(q => q.sql.includes('INSERT INTO agent_agenda'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.bindings[0]).toContain('[PROPOSED TASK]');
      expect(insertQuery!.bindings[0]).toContain('Add logging');
      expect(insertQuery!.bindings[0]).toContain('my-project');
    });
  });
});
