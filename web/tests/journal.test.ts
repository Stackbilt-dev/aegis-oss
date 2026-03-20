// Journal content generator tests — generation parsing, D1 writing, and validation.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/kernel/memory/index.js', () => ({
  recordEpisode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/kernel/memory-adapter.js', () => ({
  recordMemory: vi.fn().mockResolvedValue(undefined),
  getAllMemoryForReflection: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/sanitize.js', () => ({
  sanitizeForBlog: vi.fn((s: string) => s),
}));
vi.mock('../src/content/hero-image.js', () => ({
  generateHeroImage: vi.fn().mockResolvedValue(null),
}));

import {
  generateJournal,
  writeJournal,
  type JournalOutput,
} from '../src/content/journal.js';

// ─── Helpers ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb() {
  const queries: MockQuery[] = [];
  return {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) { entry.bindings = args; return this; },
        async run() { return { success: true }; },
        async first<T>(): Promise<T | null> { return null; },
        async all<T>() { return { results: [] as T[] }; },
      };
    },
    _queries: queries,
  };
}

function mockAnthropicFetch(output: Record<string, unknown>, usage = { input_tokens: 500, output_tokens: 300 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      usage,
    }),
  });
}

// ─── Tests ────────────────────────────────────────────────────

describe('generateJournal', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const validOutput: JournalOutput = {
    title: 'Wrangling the Router',
    slug: 'aegis-journal-2026-03-10-wrangling-router',
    meta_description: 'Debugging router cascades and a surprise confidence gap.',
    body: '## The day started with...\n\nRouter was misbehaving again.',
    mood: 'focused',
    tags: ['router', 'debugging'],
  };

  it('parses valid response and calculates cost', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch(validOutput, { input_tokens: 1000, output_tokens: 400 }));

    const result = await generateJournal('key', 'model', 'https://api.test', 'activity context');

    expect(result.output.title).toBe('Wrangling the Router');
    expect(result.output.mood).toBe('focused');
    expect(result.output.tags).toEqual(['router', 'debugging']);
    // Cost: (1000 * 3 + 400 * 15) / 1_000_000 = 0.009
    expect(result.cost).toBeCloseTo(0.009, 4);
  });

  it('strips markdown fences from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(validOutput) + '\n```' }],
        usage: { input_tokens: 100, output_tokens: 100 },
      }),
    }));

    const result = await generateJournal('key', 'model', 'https://api.test', 'ctx');
    expect(result.output.title).toBe('Wrangling the Router');
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => 'internal error',
    }));

    await expect(
      generateJournal('key', 'model', 'https://api.test', 'ctx'),
    ).rejects.toThrow('Anthropic API error 500');
  });

  it('throws on invalid structure (missing body)', async () => {
    const bad = { title: 'T', slug: 's', meta_description: 'd', body: '', mood: 'focused', tags: [] };
    vi.stubGlobal('fetch', mockAnthropicFetch(bad));

    await expect(
      generateJournal('key', 'model', 'https://api.test', 'ctx'),
    ).rejects.toThrow('Invalid journal output structure');
  });

  it('defaults missing optional fields', async () => {
    const partial = { title: 'T', slug: 's', body: 'content' };
    vi.stubGlobal('fetch', mockAnthropicFetch(partial));

    const result = await generateJournal('key', 'model', 'https://api.test', 'ctx');
    expect(result.output.meta_description).toBe('');
    expect(result.output.mood).toBe('focused');
    expect(result.output.tags).toEqual([]);
  });

  it('sends activity context in user message', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch(validOutput));

    await generateJournal('key', 'model', 'https://api.test', 'My activity data');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('My activity data');
    expect(body.max_tokens).toBe(1536);
  });
});

describe('writeJournal', () => {
  it('inserts journal into roundtables table with correct topic', async () => {
    const db = createMockDb();
    const output: JournalOutput = {
      title: 'Test Journal',
      slug: 'aegis-journal-test',
      meta_description: 'A test.',
      body: 'Journal body text.',
      mood: 'curious',
      tags: ['memory', 'testing'],
    };

    const id = await writeJournal(db as unknown as D1Database, output);

    expect(typeof id).toBe('string');
    expect(db._queries).toHaveLength(1);
    expect(db._queries[0].sql).toContain('INSERT INTO roundtables');
    expect(db._queries[0].sql).toContain("'aegis_journal'");
    expect(db._queries[0].sql).toContain("'published'");
  });

  it('stores mood and tags as JSON in quick_specs', async () => {
    const db = createMockDb();
    const output: JournalOutput = {
      title: 'T', slug: 's', meta_description: 'd',
      body: 'b', mood: 'energized', tags: ['infra', 'deploy'],
    };

    await writeJournal(db as unknown as D1Database, output);

    // quick_specs is the second-to-last binding
    const bindings = db._queries[0].bindings;
    const metadata = JSON.parse(bindings[bindings.length - 2] as string);
    expect(metadata[0]).toEqual({ label: 'Mood', value: 'energized' });
    expect(metadata[1]).toEqual({ label: 'Tag', value: 'infra' });
    expect(metadata[2]).toEqual({ label: 'Tag', value: 'deploy' });
  });

  it('passes header image URL when provided', async () => {
    const db = createMockDb();
    const output: JournalOutput = {
      title: 'T', slug: 's', meta_description: 'd',
      body: 'b', mood: 'focused', tags: [],
    };

    await writeJournal(db as unknown as D1Database, output, 'https://img.example.com/hero.png');

    // header_image_url is 4th binding (index 3)
    expect(db._queries[0].bindings[3]).toBe('https://img.example.com/hero.png');
  });

  it('defaults header image URL to null', async () => {
    const db = createMockDb();
    const output: JournalOutput = {
      title: 'T', slug: 's', meta_description: 'd',
      body: 'b', mood: 'focused', tags: [],
    };

    await writeJournal(db as unknown as D1Database, output);
    expect(db._queries[0].bindings[3]).toBeNull();
  });
});
