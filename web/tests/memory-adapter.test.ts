// Tests for memory-adapter.ts — focused on the recordMemory upsert contract.
// Regression guard for Stackbilt-dev/aegis#437 (silent dedupe-and-drop on
// updates). Pre-fix behavior: any write whose content matched an existing
// entry above a 0.55 Jaccard similarity was silently dropped, the existing
// id was returned, and the operator saw a success message — with the old
// content still in storage. The fix raises the threshold to 0.85 AND turns
// matches into real upserts via store-then-forget.

import { describe, it, expect, vi } from 'vitest';
import { recordMemory } from '../src/kernel/memory-adapter.js';
import type { MemoryServiceBinding, MemoryFragmentResult } from '../src/types.js';

// ─── Mock factory ──────────────────────────────────────────────

function createMockMemory(opts: {
  recalled?: MemoryFragmentResult[];
  storeFn?: ReturnType<typeof vi.fn>;
  forgetFn?: ReturnType<typeof vi.fn>;
  recallFn?: ReturnType<typeof vi.fn>;
} = {}): MemoryServiceBinding & { store: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn>; recall: ReturnType<typeof vi.fn> } {
  return {
    store: opts.storeFn ?? vi.fn().mockResolvedValue({
      stored: 1, merged: 0, duplicates: 0, fragment_ids: ['new-id-1'],
    }),
    recall: opts.recallFn ?? vi.fn().mockResolvedValue(opts.recalled ?? []),
    forget: opts.forgetFn ?? vi.fn().mockResolvedValue(1),
    decay: vi.fn().mockResolvedValue({ decayed: 0, pruned: 0, promoted: 0 }),
    consolidate: vi.fn().mockResolvedValue({ processed: 0, merged: 0, pruned: 0, high_water_mark: '' }),
    health: vi.fn().mockResolvedValue({ status: 'ok', version: '1.0', tenants: 1, total_fragments: 0, active_fragments: 0 }),
    stats: vi.fn().mockResolvedValue({ total_active: 0, topics: [], recalled_last_24h: 0, strength_distribution: { low: 0, medium: 0, high: 0 } }),
    embed: vi.fn().mockResolvedValue({ embeddings: [] }),
  } as any;
}

function makeFragment(id: string, content: string, lifecycle = 'confirmed'): MemoryFragmentResult {
  return {
    id,
    tenant_id: 'aegis',
    content,
    topic: 'stackbilt',
    confidence: 0.8,
    lifecycle,
    strength: 1.0,
    last_accessed_at: '2026-04-09T00:00:00Z',
    access_count: 1,
    created_at: '2026-04-09T00:00:00Z',
    updated_at: '2026-04-09T00:00:00Z',
  };
}

// ─── Fresh write (no existing match) ──────────────────────────

describe('recordMemory — fresh write', () => {
  it('stores a new entry when no similar entry exists', async () => {
    const mem = createMockMemory({ recalled: [] });
    const result = await recordMemory(mem, 'stackbilt', 'a brand new fact about the company', 0.9, 'test');

    expect(result.fragment_id).toBe('new-id-1');
    expect(result.updated).toBeUndefined();
    expect(result.superseded_id).toBeUndefined();
    expect(mem.store).toHaveBeenCalledTimes(1);
    expect(mem.forget).not.toHaveBeenCalled();
  });

  it('stores a new entry when recall returns entries below the similarity threshold', async () => {
    // Similarity between "workers ai serves llama models" and "our compliance
    // deadline is next thursday" is very low (~0). Should store as new.
    const mem = createMockMemory({
      recalled: [makeFragment('old-1', 'our compliance deadline is next thursday')],
    });
    const result = await recordMemory(mem, 'stackbilt', 'workers ai serves llama models', 0.9, 'test');

    expect(result.fragment_id).toBe('new-id-1');
    expect(result.updated).toBeUndefined();
    expect(mem.forget).not.toHaveBeenCalled();
  });

  it('treats moderate similarity (~0.6) as new content, not a duplicate', async () => {
    // This is the #437 regression case — pre-fix this would dedupe at 0.55
    // and silently drop the new content. Post-fix (threshold 0.85), moderate
    // overlap means "related fact, store it separately."
    const oldFact = 'foodfiles apps/api/package.json uses link: paths for sibling deps and the sha pins rotted within hours';
    const newFact = 'foodfiles apps/api/package.json uses link: paths for sibling deps — do not cache specific shas in memory, they drift within hours';
    const mem = createMockMemory({
      recalled: [makeFragment('stale-1', oldFact)],
    });

    const result = await recordMemory(mem, 'stackbilt', newFact, 0.93, 'operator');

    // Store called with the NEW fact, not deduped
    expect(mem.store).toHaveBeenCalledTimes(1);
    const storeArg = (mem.store as any).mock.calls[0][1][0];
    expect(storeArg.content).toBe(newFact);
    // No forget — the old entry stays until operator decides
    expect(mem.forget).not.toHaveBeenCalled();
    expect(result.updated).toBeUndefined();
  });
});

// ─── High-similarity upsert (the #437 fix) ────────────────────

describe('recordMemory — upsert on high similarity', () => {
  it('upserts by storing new then forgetting old when similarity >= 0.85', async () => {
    // Near-identical paraphrase — only punctuation/whitespace/case changes.
    // Jaccard token similarity should be 1.0 because tokenize() lowercases,
    // strips non-alphanumeric, and filters tokens shorter than 3 characters.
    const oldFact = 'operating agreement signed march 2026 final version filed delaware';
    const newFact = 'Operating Agreement signed March 2026 — final version, filed Delaware.';
    const mem = createMockMemory({
      recalled: [makeFragment('old-1', oldFact)],
      storeFn: vi.fn().mockResolvedValue({
        stored: 1, merged: 0, duplicates: 0, fragment_ids: ['fresh-id'],
      }),
    });

    const result = await recordMemory(mem, 'stackbilt', newFact, 0.95, 'operator');

    // Store was called with the new content
    expect(mem.store).toHaveBeenCalledTimes(1);
    const storeArg = (mem.store as any).mock.calls[0][1][0];
    expect(storeArg.content).toBe(newFact);

    // Forget was called on the old entry — real upsert, not silent drop
    expect(mem.forget).toHaveBeenCalledTimes(1);
    expect((mem.forget as any).mock.calls[0][1]).toEqual({ ids: ['old-1'] });

    // Result surfaces the upsert signal
    expect(result.fragment_id).toBe('fresh-id');
    expect(result.updated).toBe(true);
    expect(result.superseded_id).toBe('old-1');
  });

  it('preserves lifecycle=core when upserting a core entry', async () => {
    // Core entries (persona, identity) must not silently demote to 'observed'
    // on update, or they'd become eligible for decay/pruning.
    const oldFact = 'kurt is a pragmatic senior technical co-founder who ships fast';
    const newFact = 'Kurt is a pragmatic senior technical co-founder who ships fast.';
    const mem = createMockMemory({
      recalled: [makeFragment('core-1', oldFact, 'core')],
      storeFn: vi.fn().mockResolvedValue({
        stored: 1, merged: 0, duplicates: 0, fragment_ids: ['fresh-core'],
      }),
    });

    await recordMemory(mem, 'operator', newFact, 0.95, 'operator');

    const storeArg = (mem.store as any).mock.calls[0][1][0];
    expect(storeArg.lifecycle).toBe('core');
  });

  it('does NOT preserve lifecycle for non-core entries', async () => {
    const oldFact = 'the compliance monitor run completed successfully';
    const newFact = 'The compliance monitor run completed successfully.';
    const mem = createMockMemory({
      recalled: [makeFragment('obs-1', oldFact, 'observed')],
    });

    await recordMemory(mem, 'compliance', newFact, 0.9, 'test');

    const storeArg = (mem.store as any).mock.calls[0][1][0];
    expect(storeArg.lifecycle).toBeUndefined(); // let memory worker pick default
  });

  it('does not crash if forget fails after store succeeds (data is safe)', async () => {
    const oldFact = 'stackbilt llc is registered in delaware as a public benefit corp';
    const newFact = 'Stackbilt LLC is registered in Delaware as a public benefit corp.';
    const mem = createMockMemory({
      recalled: [makeFragment('old-1', oldFact)],
      storeFn: vi.fn().mockResolvedValue({
        stored: 1, merged: 0, duplicates: 0, fragment_ids: ['fresh-id'],
      }),
      forgetFn: vi.fn().mockRejectedValue(new Error('network blip')),
    });

    // Should not throw — the new content is safely stored; stale old entry
    // can be cleaned up manually. Data loss is unacceptable, duplication is
    // tolerable.
    const result = await recordMemory(mem, 'stackbilt', newFact, 0.9, 'test');
    expect(result.fragment_id).toBe('fresh-id');
    expect(result.updated).toBe(true);
    expect(result.superseded_id).toBe('old-1');
  });
});

// ─── Error handling ────────────────────────────────────────────

describe('recordMemory — error handling', () => {
  it('still stores the new entry when the dedup recall check throws', async () => {
    // Dedup check is best-effort. If recall throws, we should still write.
    const mem = createMockMemory({
      recallFn: vi.fn().mockRejectedValue(new Error('recall timeout')),
    });

    const result = await recordMemory(mem, 'stackbilt', 'some new fact', 0.8, 'test');

    expect(result.fragment_id).toBe('new-id-1');
    expect(mem.store).toHaveBeenCalledTimes(1);
  });

  it('throws when the underlying store call fails', async () => {
    const mem = createMockMemory({
      recalled: [],
      storeFn: vi.fn().mockRejectedValue(new Error('store binding down')),
    });

    await expect(recordMemory(mem, 'stackbilt', 'a fact', 0.8, 'test'))
      .rejects.toThrow(/Memory write failed/);
  });
});
