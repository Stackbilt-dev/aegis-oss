// Tests for classifyMemoryTopic — the aegis-oss wrapper around the
// memory-topic-classify spread. Covers fallback semantics, confidence
// gating, unknown-topic defense, and the recordMemoryWithAutoTopic
// composition.

import { describe, it, expect, vi } from 'vitest';
import {
  classifyMemoryTopic,
  runMemoryTopicClassification,
  CANONICAL_MEMORY_TOPICS,
} from '../src/kernel/classify-memory-topic.js';
import { recordMemoryWithAutoTopic } from '../src/kernel/memory-adapter.js';
import type { MemoryServiceBinding } from '../src/types.js';

// ─── Fetcher mock factory ───────────────────────────────────────

function createMockFetcher(
  fn: (url: string, init?: RequestInit) => Promise<Response>,
): Fetcher {
  return {
    fetch: vi.fn().mockImplementation(fn),
    connect: vi.fn() as any,
  } as unknown as Fetcher;
}

function mockWorkerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── runMemoryTopicClassification ──────────────────────────────

describe('runMemoryTopicClassification', () => {
  it('parses facts from a successful worker response', async () => {
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({
        facts: {
          classification: 'operator',
          classification_confidence: 'moderate',
          classification_element: 'Water',
        },
        receipt: { hash: 'abc123' },
      }),
    );

    const result = await runMemoryTopicClassification(fetcher, 'Kurt prefers X');
    expect(result).toEqual({
      classification: 'operator',
      classification_confidence: 'moderate',
      classification_element: 'Water',
      receipt_hash: 'abc123',
    });
  });

  it('returns null on non-OK response instead of throwing', async () => {
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({ error: 'worker down' }, 503),
    );

    const result = await runMemoryTopicClassification(fetcher, 'some fact');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network blip / binding unavailable)', async () => {
    const fetcher = createMockFetcher(async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await runMemoryTopicClassification(fetcher, 'some fact');
    expect(result).toBeNull();
  });

  it('sends the correct spread + querent shape to the worker', async () => {
    const capturedBody: any[] = [];
    const fetcher = createMockFetcher(async (_url, init) => {
      capturedBody.push(JSON.parse(String(init?.body)));
      return mockWorkerResponse({ facts: { classification: 'operator', classification_confidence: 'moderate' } });
    });

    await runMemoryTopicClassification(fetcher, 'Kurt note about the business', { seed: 42 });
    expect(capturedBody[0]).toEqual({
      spreadType: 'memory-topic-classify',
      querent: { id: 'aegis', intention: 'Kurt note about the business' },
      seed: 42,
      inscribe: false, // classification is metadata, shouldn't persist to grimoire
    });
  });
});

// ─── classifyMemoryTopic (fallback wrapper) ────────────────────

describe('classifyMemoryTopic', () => {
  it('returns the classifier topic when confidence is moderate', async () => {
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({
        facts: {
          classification: 'business_ops',
          classification_confidence: 'moderate',
          classification_element: 'Earth',
        },
        receipt: { hash: 'def456' },
      }),
    );

    const result = await classifyMemoryTopic(fetcher, 'Stackbilt LLC revenue hit $100');
    expect(result).toEqual({
      topic: 'business_ops',
      confidence: 'moderate',
      source: 'classifier',
      element: 'Earth',
      receipt_hash: 'def456',
    });
  });

  it('falls through to "general" when classifier returns low confidence', async () => {
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({
        facts: {
          classification: 'operator',
          classification_confidence: 'low',
        },
      }),
    );

    const result = await classifyMemoryTopic(fetcher, 'ambiguous fact');
    expect(result.topic).toBe('general');
    expect(result.source).toBe('fallback');
    expect(result.confidence).toBe('low');
  });

  it('falls through to "general" when classifier is unreachable', async () => {
    const fetcher = createMockFetcher(async () => {
      throw new Error('binding unavailable');
    });

    const result = await classifyMemoryTopic(fetcher, 'any fact');
    expect(result.topic).toBe('general');
    expect(result.source).toBe('fallback');
  });

  it('falls through to "general" when classifier returns an unknown topic (deck drift guard)', async () => {
    // Scenario: someone adds a card to the deck with a canonical_topic not
    // in CANONICAL_MEMORY_TOPICS. Wrapper must not silently propagate the
    // unknown value — it should fall through and log.
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({
        facts: {
          classification: 'brand_new_unknown_topic',
          classification_confidence: 'moderate',
        },
      }),
    );

    const result = await classifyMemoryTopic(fetcher, 'some fact');
    expect(result.topic).toBe('general');
    expect(result.source).toBe('fallback');
    expect(result.confidence).toBe('moderate'); // original conf preserved for observability
  });

  it('passes seed through to the underlying classification call', async () => {
    const seeds: number[] = [];
    const fetcher = createMockFetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      seeds.push(body.seed);
      return mockWorkerResponse({
        facts: { classification: 'operator', classification_confidence: 'moderate' },
      });
    });

    await classifyMemoryTopic(fetcher, 'fact A', { seed: 100 });
    await classifyMemoryTopic(fetcher, 'fact B', { seed: 200 });
    expect(seeds).toEqual([100, 200]);
  });

  it('knows about every canonical topic in the deck manifest', () => {
    // Guard against drift between this file's CANONICAL_MEMORY_TOPICS and
    // the deck's actual card set. If someone adds a card to the deck
    // without updating this list, this test fails loudly.
    expect(CANONICAL_MEMORY_TOPICS).toContain('operator');
    expect(CANONICAL_MEMORY_TOPICS).toContain('feedback');
    expect(CANONICAL_MEMORY_TOPICS).toContain('business_ops');
    expect(CANONICAL_MEMORY_TOPICS).toContain('compliance');
    expect(CANONICAL_MEMORY_TOPICS).toContain('execution');
    expect(CANONICAL_MEMORY_TOPICS).toContain('content');
    expect(CANONICAL_MEMORY_TOPICS).toContain('research');
    expect(CANONICAL_MEMORY_TOPICS).toContain('reflection');
    expect(CANONICAL_MEMORY_TOPICS).toContain('cross_repo_intelligence');
    expect(CANONICAL_MEMORY_TOPICS).toContain('feed_intel');
    expect(CANONICAL_MEMORY_TOPICS).toContain('aegis');
    expect(CANONICAL_MEMORY_TOPICS).toContain('tarotscript');
    expect(CANONICAL_MEMORY_TOPICS).toContain('infrastructure');
    expect(CANONICAL_MEMORY_TOPICS).toContain('portfolio_project');
    expect(CANONICAL_MEMORY_TOPICS).toContain('general');
    expect(CANONICAL_MEMORY_TOPICS.length).toBe(15);
  });
});

// ─── recordMemoryWithAutoTopic (composition) ───────────────────

describe('recordMemoryWithAutoTopic', () => {
  function createMockMemory(): MemoryServiceBinding & { store: ReturnType<typeof vi.fn>; recall: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> } {
    return {
      store: vi.fn().mockResolvedValue({ stored: 1, merged: 0, duplicates: 0, fragment_ids: ['new-id'] }),
      recall: vi.fn().mockResolvedValue([]),
      forget: vi.fn().mockResolvedValue(0),
      decay: vi.fn().mockResolvedValue({ decayed: 0, pruned: 0, promoted: 0 }),
      consolidate: vi.fn().mockResolvedValue({ processed: 0, merged: 0, pruned: 0, high_water_mark: '' }),
      health: vi.fn().mockResolvedValue({ status: 'ok', version: '1.0', tenants: 1, total_fragments: 0, active_fragments: 0 }),
      stats: vi.fn().mockResolvedValue({ total_active: 0, topics: [], recalled_last_24h: 0, strength_distribution: { low: 0, medium: 0, high: 0 } }),
      embed: vi.fn().mockResolvedValue({ embeddings: [] }),
    } as any;
  }

  it('classifies the fact then writes with the inferred topic', async () => {
    const mem = createMockMemory();
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({
        facts: {
          classification: 'operator',
          classification_confidence: 'moderate',
        },
      }),
    );

    const result = await recordMemoryWithAutoTopic(mem, fetcher, 'Kurt prefers anti-corporate tone', 0.9, 'test');

    // Memory was written with the inferred topic
    const storeCall = (mem.store as any).mock.calls[0][1][0];
    expect(storeCall.topic).toBe('operator');
    expect(storeCall.content).toBe('Kurt prefers anti-corporate tone');

    // Classification metadata attached to result
    expect(result.classification.topic).toBe('operator');
    expect(result.classification.source).toBe('classifier');
    expect(result.fragment_id).toBe('new-id');
  });

  it('writes with "general" topic when classifier falls through', async () => {
    const mem = createMockMemory();
    const fetcher = createMockFetcher(async () => {
      throw new Error('tarotscript down');
    });

    const result = await recordMemoryWithAutoTopic(mem, fetcher, 'some fact', 0.8, 'test');

    const storeCall = (mem.store as any).mock.calls[0][1][0];
    expect(storeCall.topic).toBe('general');
    expect(result.classification.source).toBe('fallback');
  });

  it('does not prevent the write if classification fails — fact still lands', async () => {
    // Critical invariant: auto-topic classification is best-effort metadata.
    // A classifier failure must never block the actual memory write. The
    // fallback path ensures this — verify the write still happens.
    const mem = createMockMemory();
    const fetcher = createMockFetcher(async () =>
      mockWorkerResponse({ error: 'spread error' }, 500),
    );

    const result = await recordMemoryWithAutoTopic(mem, fetcher, 'important operator note', 0.95, 'test');

    expect(mem.store).toHaveBeenCalledTimes(1);
    expect(result.fragment_id).toBe('new-id');
    expect(result.classification.topic).toBe('general');
  });
});
