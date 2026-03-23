// Column content generator tests — generation parsing, D1 writing, and validation.

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

import {
  generateColumn,
  writeColumn,
  type ColumnOutput,
} from '../src/content/column.js';

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

function mockAnthropicFetch(output: Record<string, unknown>, usage = { input_tokens: 500, output_tokens: 800 }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      usage,
    }),
  });
}

// ─── Tests ────────────────────────────────────────────────────

describe('generateColumn', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  const validOutput: ColumnOutput = {
    title: 'The Confidence Boundary Problem',
    slug: 'aegis-confidence-boundary',
    meta_description: 'Why the calls at the routing boundary fail more than expected.',
    body: '## I noticed something this week...\n\nThe router confidence scores cluster in weird ways.',
  };

  it('parses valid response and calculates cost', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch(validOutput, { input_tokens: 1500, output_tokens: 800 }));

    const result = await generateColumn('key', 'model', 'https://api.test', 'activity');

    expect(result.output.title).toBe('The Confidence Boundary Problem');
    expect(result.output.body).toContain('router confidence scores');
    // Cost: (1500 * 3 + 800 * 15) / 1_000_000 = 0.0165
    expect(result.cost).toBeCloseTo(0.0165, 4);
  });

  it('strips markdown fences from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(validOutput) + '\n```' }],
        usage: { input_tokens: 100, output_tokens: 100 },
      }),
    }));

    const result = await generateColumn('key', 'model', 'https://api.test', 'ctx');
    expect(result.output.title).toBe('The Confidence Boundary Problem');
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'forbidden',
    }));

    await expect(
      generateColumn('key', 'model', 'https://api.test', 'ctx'),
    ).rejects.toThrow('Anthropic API error 403');
  });

  it('throws on invalid structure (missing body)', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch({ title: 'T', slug: 's', body: '' }));

    await expect(
      generateColumn('key', 'model', 'https://api.test', 'ctx'),
    ).rejects.toThrow('Invalid column output structure');
  });

  it('throws on invalid structure (missing slug)', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch({ title: 'T', slug: '', body: 'content' }));

    await expect(
      generateColumn('key', 'model', 'https://api.test', 'ctx'),
    ).rejects.toThrow('Invalid column output structure');
  });

  it('defaults missing meta_description', async () => {
    const partial = { title: 'T', slug: 's', body: 'content' };
    vi.stubGlobal('fetch', mockAnthropicFetch(partial));

    const result = await generateColumn('key', 'model', 'https://api.test', 'ctx');
    expect(result.output.meta_description).toBe('');
  });

  it('sends activity context and uses 2048 max_tokens', async () => {
    vi.stubGlobal('fetch', mockAnthropicFetch(validOutput));

    await generateColumn('key', 'model', 'https://api.test', 'Recent episodes data');

    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.messages[0].content).toContain('Recent episodes data');
    expect(body.max_tokens).toBe(2048);
  });
});

describe('writeColumn', () => {
  it('inserts column into roundtables table with aegis_column topic', async () => {
    const db = createMockDb();
    const output: ColumnOutput = {
      title: 'Test Column',
      slug: 'test-column',
      meta_description: 'A test column.',
      body: 'Column body markdown.',
    };

    const id = await writeColumn(db as unknown as D1Database, output);

    expect(typeof id).toBe('string');
    expect(db._queries).toHaveLength(1);
    expect(db._queries[0].sql).toContain('INSERT INTO roundtables');
    expect(db._queries[0].sql).toContain("'aegis_column'");
    expect(db._queries[0].sql).toContain("'draft'");
  });

  it('stores body in synthesis field and meta in correct position', async () => {
    const db = createMockDb();
    const output: ColumnOutput = {
      title: 'T',
      slug: 'slug-val',
      meta_description: 'meta desc',
      body: 'The full column text.',
    };

    await writeColumn(db as unknown as D1Database, output);

    const bindings = db._queries[0].bindings;
    expect(bindings).toContain('slug-val');
    // Last binding should be the body (synthesis)
    expect(bindings[bindings.length - 1]).toBe('The full column text.');
  });

  it('sets null for header_image_url (columns have no images)', async () => {
    const db = createMockDb();
    const output: ColumnOutput = { title: 'T', slug: 's', meta_description: 'd', body: 'b' };

    await writeColumn(db as unknown as D1Database, output);

    // The SQL has NULL literal for header_image_url, not a binding
    expect(db._queries[0].sql).toContain('NULL');
  });

  it('uses example.com as CTA URL', async () => {
    const db = createMockDb();
    const output: ColumnOutput = { title: 'T', slug: 's', meta_description: 'd', body: 'b' };

    await writeColumn(db as unknown as D1Database, output);
    expect(db._queries[0].bindings).toContain('https://example.com');
  });
});
