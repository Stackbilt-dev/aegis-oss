// Semantic memory tests — normalizeTopic, factHash, tokenize, jaccardSimilarity,
// recordMemory (3-phase dedup), searchMemoryByKeywords, computeEwaScore, getAllMemoryForContext

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeTopic,
  tokenize,
  jaccardSimilarity,
  cosineSimilarity,
  recordMemory,
  searchMemoryByKeywords,
  computeEwaScore,
  getAllMemoryForContext,
  recallMemory,
  factHash,
} from '../../src/kernel/memory/semantic.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(opts: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Array<{ results: Record<string, unknown>[] }>;
  runResults?: Array<{ success: boolean; meta?: Record<string, unknown> }>;
} = {}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let allIdx = 0;
  let runIdx = 0;

  const db = {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          const idx = firstIdx++;
          return (opts.firstResults?.[idx] ?? null) as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const idx = allIdx++;
          return (opts.allResults?.[idx] ?? { results: [] }) as { results: T[] };
        },
        async run() {
          const idx = runIdx++;
          return opts.runResults?.[idx] ?? { success: true, meta: {} };
        },
      };
    },
    _queries: queries,
  };

  return db as unknown as D1Database & { _queries: MockQuery[] };
}

// ─── normalizeTopic ──────────────────────────────────────────

describe('normalizeTopic', () => {
  it('lowercases and replaces spaces with underscores', () => {
    expect(normalizeTopic('Compliance Monitoring')).toBe('compliance_monitoring');
  });

  it('strips non-alphanum characters', () => {
    // 'img-forge (v2)' → 'imgforge_v2' (hyphen/parens stripped, digits kept)
    // No canonical alias for 'imgforge_v2', returned as-is
    expect(normalizeTopic('img-forge (v2)')).toBe('imgforge_v2');
    // Bare 'imgforge' has canonical alias → 'img_forge'
    expect(normalizeTopic('imgforge')).toBe('img_forge');
  });

  it('collapses canonical variants to their canonical form', () => {
    expect(normalizeTopic('aegis_development')).toBe('aegis');
    expect(normalizeTopic('aegis_architecture')).toBe('aegis');
    expect(normalizeTopic('imgforge')).toBe('img_forge');
    expect(normalizeTopic('bizops_improvements')).toBe('bizops');
    expect(normalizeTopic('dispatch_generation')).toBe('content');
    expect(normalizeTopic('roundtable_generation')).toBe('content');
    expect(normalizeTopic('stackbilt_governance')).toBe('stackbilt');
  });

  it('returns normalized form when no canonical match', () => {
    expect(normalizeTopic('Custom Topic')).toBe('custom_topic');
  });

  it('collapses multiple underscores and trims edges', () => {
    expect(normalizeTopic('__hello__world__')).toBe('hello_world');
  });
});

// ─── factHash ────────────────────────────────────────────────

describe('factHash', () => {
  it('produces consistent hex hash', () => {
    const h1 = factHash('aegis', 'some fact');
    const h2 = factHash('aegis', 'some fact');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
  });

  it('normalizes whitespace before hashing', () => {
    const h1 = factHash('test', 'hello  world');
    const h2 = factHash('test', 'hello world');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different topics', () => {
    const h1 = factHash('topic1', 'same fact');
    const h2 = factHash('topic2', 'same fact');
    expect(h1).not.toBe(h2);
  });

  it('is case-insensitive on fact', () => {
    const h1 = factHash('test', 'Hello World');
    const h2 = factHash('test', 'hello world');
    expect(h1).toBe(h2);
  });
});

// ─── tokenize ────────────────────────────────────────────────

describe('tokenize', () => {
  it('returns significant words excluding stop words', () => {
    const tokens = tokenize('The quick brown fox jumps over the lazy dog');
    expect(tokens.has('quick')).toBe(true);
    expect(tokens.has('brown')).toBe(true);
    expect(tokens.has('fox')).toBe(true);
    expect(tokens.has('jumps')).toBe(true);
    expect(tokens.has('over')).toBe(true); // 'over' is NOT a stop word
    expect(tokens.has('lazy')).toBe(true);
    expect(tokens.has('dog')).toBe(true);
    // stop words excluded
    expect(tokens.has('the')).toBe(false);
  });

  it('removes single-char words', () => {
    const tokens = tokenize('I am a great programmer');
    expect(tokens.has('great')).toBe(true);
    expect(tokens.has('programmer')).toBe(true);
    // Single chars filtered
    expect(tokens.has('a')).toBe(false);
  });

  it('strips non-alphanum chars and lowercases', () => {
    const tokens = tokenize('TypeScript v4.0 is GREAT!');
    expect(tokens.has('typescript')).toBe(true);
    expect(tokens.has('great')).toBe(true);
  });
});

// ─── jaccardSimilarity ──────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['x', 'y']);
    const b = new Set(['m', 'n']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it('computes correct ratio for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

// ─── cosineSimilarity ────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('computes correct similarity for known vectors', () => {
    // cos([1,2,3], [4,5,6]) = (4+10+18) / (sqrt(14)*sqrt(77)) = 32/32.833 ≈ 0.9746
    expect(cosineSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(0.9746, 3);
  });
});

// ─── recordMemory ────────────────────────────────────────────

describe('recordMemory', () => {
  it('phase 1: updates existing entry on exact hash match', async () => {
    const db = createMockDb({
      firstResults: [{ id: 42, confidence: 0.5 }], // existing hash match
      runResults: [{ success: true, meta: {} }],    // UPDATE
    });

    await recordMemory(db, 'aegis', 'some fact', 0.9, 'test');

    // Should SELECT for hash match, then UPDATE
    expect(db._queries).toHaveLength(2);
    expect(db._queries[0].sql).toContain('fact_hash');
    expect(db._queries[1].sql).toContain('UPDATE');
  });

  it('phase 2: supersedes on Jaccard similarity match', async () => {
    const db = createMockDb({
      firstResults: [null], // no exact hash match
      allResults: [{
        results: [{ id: 10, fact: 'workers ai llama model handles classification', confidence: 0.7 }],
      }],
      runResults: [
        { success: true, meta: {} },                     // invalidate old
        { success: true, meta: { last_row_id: 99 } },    // insert new
        { success: true, meta: {} },                      // back-link
      ],
    });

    // Similar fact that should trigger Jaccard match (same keywords)
    await recordMemory(db, 'aegis', 'workers ai llama model handles classification tasks', 0.8, 'test');

    // Should have: SELECT hash, SELECT topic entries, UPDATE old, INSERT new, UPDATE back-link
    expect(db._queries.length).toBeGreaterThanOrEqual(4);
    const insertQuery = db._queries.find(q => q.sql.includes('INSERT'));
    expect(insertQuery).toBeDefined();
  });

  it('phase 3: inserts new entry when no match', async () => {
    const db = createMockDb({
      firstResults: [null], // no hash match
      allResults: [{ results: [] }], // no topic entries
      runResults: [{ success: true, meta: {} }], // INSERT
    });

    await recordMemory(db, 'new_topic', 'completely new fact', 0.8, 'test');

    const insertQuery = db._queries.find(q => q.sql.includes('INSERT'));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.bindings).toContain('new_topic');
  });
});

// ─── searchMemoryByKeywords ─────────────────────────────────

describe('searchMemoryByKeywords', () => {
  it('returns empty array for queries with no significant keywords', async () => {
    const db = createMockDb();
    const result = await searchMemoryByKeywords(db, 'the a is');
    expect(result).toEqual([]);
  });

  it('builds LIKE query for significant keywords', async () => {
    const db = createMockDb({
      allResults: [{
        results: [
          { id: 1, topic: 'aegis', fact: 'deployment pattern', confidence: 0.9 },
        ],
      }],
    });

    const result = await searchMemoryByKeywords(db, 'deployment pattern for workers');
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe('deployment pattern');
    // Query should contain LIKE clauses
    const query = db._queries[0];
    expect(query.sql).toContain('LIKE');
  });
});

// ─── computeEwaScore ────────────────────────────────────────

describe('computeEwaScore', () => {
  it('returns high score for recently recalled, high-strength entries', () => {
    const score = computeEwaScore(0, 5, 0.9);
    expect(score).toBeGreaterThan(0.5);
  });

  it('decays score with age', () => {
    const fresh = computeEwaScore(0, 1, 0.8);
    const stale = computeEwaScore(30, 1, 0.8);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('higher strength slows decay', () => {
    const lowStrength = computeEwaScore(14, 1, 0.8);
    const highStrength = computeEwaScore(14, 5, 0.8);
    expect(highStrength).toBeGreaterThan(lowStrength);
  });

  it('returns 0.6 recency + 0 strength + 0.1 confidence for brand new entry', () => {
    // daysSince=0, strength=1 → recency = 2^0 = 1, strengthScore = log2(2)/5 = 0.2
    const score = computeEwaScore(0, 1, 1.0);
    // 0.6*1 + 0.3*0.2 + 0.1*1.0 = 0.6 + 0.06 + 0.1 = 0.76
    expect(score).toBeCloseTo(0.76, 2);
  });
});

// ─── recallMemory ────────────────────────────────────────────

describe('recallMemory', () => {
  it('skips update for empty IDs array', async () => {
    const db = createMockDb();
    await recallMemory(db, []);
    expect(db._queries).toHaveLength(0);
  });

  it('batch updates strength for multiple IDs', async () => {
    const db = createMockDb({
      runResults: [{ success: true, meta: {} }],
    });
    await recallMemory(db, [1, 2, 3]);
    expect(db._queries).toHaveLength(1);
    expect(db._queries[0].sql).toContain('IN (?,?,?)');
    expect(db._queries[0].bindings).toEqual([1, 2, 3]);
  });
});

// ─── getAllMemoryForContext ──────────────────────────────────

describe('getAllMemoryForContext', () => {
  it('returns empty text for no entries', async () => {
    const db = createMockDb({
      allResults: [{ results: [] }],
    });

    const result = await getAllMemoryForContext(db);
    expect(result.text).toBe('');
    expect(result.ids).toEqual([]);
  });

  it('groups entries by topic and scores by EWA', async () => {
    const now = new Date().toISOString();
    const db = createMockDb({
      allResults: [{
        results: [
          { id: 1, topic: 'aegis', fact: 'fact one', confidence: 0.9, strength: 3, last_recalled_at: now, created_at: now },
          { id: 2, topic: 'aegis', fact: 'fact two', confidence: 0.7, strength: 1, last_recalled_at: null, created_at: now },
          { id: 3, topic: 'finance', fact: 'finance fact', confidence: 0.8, strength: 2, last_recalled_at: now, created_at: now },
        ],
      }],
    });

    const result = await getAllMemoryForContext(db);
    expect(result.text).toContain('## Agent Memory');
    expect(result.text).toContain('### aegis');
    expect(result.text).toContain('### finance');
    expect(result.ids).toHaveLength(3);
    expect(result.ids).toContain(1);
    expect(result.ids).toContain(3);
  });

  it('limits to top 50 entries', async () => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1, topic: `topic_${i % 3}`, fact: `fact ${i}`,
      confidence: 0.5, strength: 1, last_recalled_at: null, created_at: now,
    }));

    const db = createMockDb({
      allResults: [{ results: entries }],
    });

    const result = await getAllMemoryForContext(db);
    expect(result.ids).toHaveLength(50);
  });
});
