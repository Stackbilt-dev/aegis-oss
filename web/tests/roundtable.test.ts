// Roundtable content generator tests — topic picking, generation, writing, and queueing.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../src/kernel/memory/index.js', () => ({
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/kernel/memory-adapter.js', () => ({
  recordMemory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/sanitize.js', () => ({
  sanitizeForBlog: vi.fn((s: string) => s), // passthrough
}));
vi.mock('../src/content/hero-image.js', () => ({
  generateHeroImage: vi.fn().mockResolvedValue(null),
}));

import {
  pickNextTopic,
  generateRoundtable,
  writeRoundtable,
  queueRoundtableTopic,
  type RoundtableOutput,
} from '../src/content/roundtable.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(opts: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: { results: Record<string, unknown>[] }[];
} = {}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;

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
          const r = opts.firstResults?.[firstIdx++] ?? null;
          return r as T | null;
        },
        async run() { return { success: true }; },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
    },
    _queries: queries,
  };
  return db;
}

// ─── Fetch mock ───────────────────────────────────────────────

function mockAnthropicFetch(output: Record<string, unknown>, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      usage,
    }),
  });
}

// ─── Tests ────────────────────────────────────────────────────

describe('pickNextTopic', () => {
  it('returns queued topic and marks it as used', async () => {
    const topic = { id: 'topic-1', topic: 'MCP Security', context: 'research', cta_product: 'edgestack' };
    const db = createMockDb({ firstResults: [topic] });

    const result = await pickNextTopic(db as unknown as D1Database);

    expect(result).toEqual(topic);
    // First query: SELECT, second query: UPDATE
    expect(db._queries).toHaveLength(2);
    expect(db._queries[0].sql).toContain('SELECT');
    expect(db._queries[0].sql).toContain("status = 'queued'");
    expect(db._queries[1].sql).toContain('UPDATE');
    expect(db._queries[1].bindings).toContain('topic-1');
  });

  it('returns null when no queued topics exist', async () => {
    const db = createMockDb({ firstResults: [null] });
    const result = await pickNextTopic(db as unknown as D1Database);
    expect(result).toBeNull();
    // Only the SELECT query — no UPDATE since topic was null
    expect(db._queries).toHaveLength(1);
  });
});

describe('generateRoundtable', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const validOutput: RoundtableOutput = {
    title: 'Test Roundtable',
    slug: 'test-roundtable',
    meta_description: 'A test roundtable discussion.',
    executive_summary: [{ metric: 'Test', status: 'green', takeaway: 'All good' }],
    quick_specs: [{ label: 'Size', value: '100' }],
    contributions: [
      { persona: 'architect', content: 'Build it fast.', key_findings: ['Speed matters'] },
      { persona: 'operator', content: 'Watch the costs.', key_findings: ['Budget tight'] },
    ],
    synthesis: 'Both sides have merit.',
  };

  it('parses valid Anthropic response and calculates cost', async () => {
    const fetchMock = mockAnthropicFetch(validOutput, { input_tokens: 2000, output_tokens: 1000 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateRoundtable('key', 'model', 'https://api.test', 'Topic', null, null);

    expect(result.output.title).toBe('Test Roundtable');
    expect(result.output.contributions).toHaveLength(2);
    // Cost: (2000 * 3 + 1000 * 15) / 1_000_000 = 0.021
    expect(result.cost).toBeCloseTo(0.021, 4);
  });

  it('strips markdown fences from response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(validOutput) + '\n```' }],
        usage: { input_tokens: 100, output_tokens: 100 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateRoundtable('key', 'model', 'https://api.test', 'Topic', null, null);
    expect(result.output.title).toBe('Test Roundtable');
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }));

    await expect(
      generateRoundtable('key', 'model', 'https://api.test', 'Topic', null, null),
    ).rejects.toThrow('Anthropic API error 429');
  });

  it('throws on invalid output structure (missing title)', async () => {
    const bad = { ...validOutput, title: '', contributions: [{ persona: 'architect', content: 'x', key_findings: [] }] };
    vi.stubGlobal('fetch', mockAnthropicFetch(bad));

    await expect(
      generateRoundtable('key', 'model', 'https://api.test', 'Topic', null, null),
    ).rejects.toThrow('Invalid roundtable output structure');
  });

  it('throws on invalid output structure (empty contributions)', async () => {
    const bad = { ...validOutput, contributions: [] };
    vi.stubGlobal('fetch', mockAnthropicFetch(bad));

    await expect(
      generateRoundtable('key', 'model', 'https://api.test', 'Topic', null, null),
    ).rejects.toThrow('Invalid roundtable output structure');
  });

  it('defaults missing optional fields gracefully', async () => {
    const partial = {
      title: 'Partial',
      slug: 'partial',
      meta_description: 'test',
      contributions: [{ persona: 'architect', content: 'test' }],
      // Missing: executive_summary, quick_specs, synthesis, key_findings
    };
    vi.stubGlobal('fetch', mockAnthropicFetch(partial));

    const result = await generateRoundtable('key', 'model', 'https://api.test', 'Topic', null, null);
    expect(result.output.executive_summary).toEqual([]);
    expect(result.output.quick_specs).toEqual([]);
    expect(result.output.synthesis).toBe('');
    expect(result.output.contributions[0].key_findings).toEqual([]);
  });

  it('includes context in user prompt when provided', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch(validOutput));

    await generateRoundtable('key', 'model', 'https://api.test', 'Topic', 'Some context', 'edgestack');

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toContain('CONTEXT: Some context');
    expect(body.messages[0].content).toContain('CTA_PRODUCT: edgestack');
  });
});

describe('writeRoundtable', () => {
  it('inserts roundtable and contributions into D1', async () => {
    const db = createMockDb();
    const output: RoundtableOutput = {
      title: 'Test Title',
      slug: 'test-slug',
      meta_description: 'desc',
      executive_summary: [{ metric: 'M', status: 'green', takeaway: 'ok' }],
      quick_specs: [{ label: 'L', value: 'V' }],
      contributions: [
        { persona: 'architect', content: 'content1', key_findings: ['f1'] },
        { persona: 'operator', content: 'content2', key_findings: [] },
      ],
      synthesis: 'synth',
    };

    const id = await writeRoundtable(db as unknown as D1Database, output, 'edgestack');

    expect(typeof id).toBe('string');
    // 1 roundtable INSERT + 2 contribution INSERTs
    expect(db._queries).toHaveLength(3);
    expect(db._queries[0].sql).toContain('INSERT INTO roundtables');
    expect(db._queries[0].bindings).toContain('test-slug');
    expect(db._queries[1].sql).toContain('INSERT INTO contributions');
    expect(db._queries[2].sql).toContain('INSERT INTO contributions');
  });

  it('maps CTA product to correct URL', async () => {
    const db = createMockDb();
    const output: RoundtableOutput = {
      title: 'T', slug: 's', meta_description: 'd',
      executive_summary: [], quick_specs: [],
      contributions: [{ persona: 'architect', content: 'c', key_findings: [] }],
      synthesis: '',
    };

    await writeRoundtable(db as unknown as D1Database, output, 'img-forge');
    // CTA URL should be img-forge URL
    expect(db._queries[0].bindings).toContain('https://img-forge.stackbilt.dev');
  });

  it('falls back to general CTA URL for unknown product', async () => {
    const db = createMockDb();
    const output: RoundtableOutput = {
      title: 'T', slug: 's', meta_description: 'd',
      executive_summary: [], quick_specs: [],
      contributions: [{ persona: 'architect', content: 'c', key_findings: [] }],
      synthesis: '',
    };

    await writeRoundtable(db as unknown as D1Database, output, 'unknown-product');
    expect(db._queries[0].bindings).toContain('https://stackbilt.dev');
  });

  it('passes null header image URL by default', async () => {
    const db = createMockDb();
    const output: RoundtableOutput = {
      title: 'T', slug: 's', meta_description: 'd',
      executive_summary: [], quick_specs: [],
      contributions: [{ persona: 'architect', content: 'c', key_findings: [] }],
      synthesis: '',
    };

    await writeRoundtable(db as unknown as D1Database, output, null);
    // headerImageUrl is the 5th binding (index 4)
    expect(db._queries[0].bindings[4]).toBeNull();
  });
});

describe('queueRoundtableTopic', () => {
  it('inserts new topic when no duplicate exists', async () => {
    const db = createMockDb({ firstResults: [null] });
    const id = await queueRoundtableTopic(
      db as unknown as D1Database, 'New Topic', 'context', 'edgestack', 'heartbeat',
    );

    expect(typeof id).toBe('string');
    expect(db._queries).toHaveLength(2); // SELECT + INSERT
    expect(db._queries[0].sql).toContain('SELECT');
    expect(db._queries[0].bindings).toContain('New Topic');
    expect(db._queries[1].sql).toContain('INSERT INTO topic_queue');
    expect(db._queries[1].bindings).toContain('New Topic');
    expect(db._queries[1].bindings).toContain('heartbeat');
  });

  it('returns existing ID when duplicate topic is queued', async () => {
    const db = createMockDb({ firstResults: [{ id: 'existing-id' }] });
    const id = await queueRoundtableTopic(
      db as unknown as D1Database, 'Duplicate', null, null, 'manual',
    );

    expect(id).toBe('existing-id');
    // Only SELECT, no INSERT
    expect(db._queries).toHaveLength(1);
  });

  it('defaults cta_product to general when null', async () => {
    const db = createMockDb({ firstResults: [null] });
    await queueRoundtableTopic(
      db as unknown as D1Database, 'Topic', null, null, 'test',
    );

    expect(db._queries[1].bindings).toContain('general');
  });
});
