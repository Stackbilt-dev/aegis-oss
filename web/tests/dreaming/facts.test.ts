import { describe, it, expect, vi } from 'vitest';
import { processFacts, type DreamingResult } from '../../src/kernel/scheduled/dreaming/facts.js';

// Mock memory adapter
vi.mock('../../src/kernel/memory-adapter.js', () => ({
  recordMemory: vi.fn().mockResolvedValue(undefined),
}));

// Mock memory guardrails — pass through to real implementation
vi.mock('../../src/kernel/memory-guardrails.js', async () => {
  const actual = await vi.importActual('../../src/kernel/memory-guardrails.js');
  return actual;
});

function makeEnv(overrides?: Record<string, unknown>) {
  return {
    db: {} as D1Database,
    memoryBinding: { recall: vi.fn(), store: vi.fn() },
    ...overrides,
  } as any;
}

describe('processFacts', () => {
  it('records valid facts', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: [
        { topic: 'aegis', fact: 'The dispatch loop now handles 8 executor types including composite', confidence: 0.9 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(1);
  });

  it('skips facts with blocked topic prefix', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: [
        { topic: 'synthesis_cross_domain', fact: 'Some vague synthesis observation that pollutes memory with noise', confidence: 0.8 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(0);
  });

  it('skips facts with unknown topic when allowlist enforced', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: [
        { topic: 'random_new_topic', fact: 'A fact about something not in the established topic taxonomy', confidence: 0.8 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(0);
  });

  it('skips facts shorter than 20 chars', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: [
        { topic: 'aegis', fact: 'too short', confidence: 0.8 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(0);
  });

  it('caps at 5 facts per cycle', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: Array.from({ length: 8 }, (_, i) => ({
        topic: 'aegis',
        fact: `Fact number ${i + 1} with enough detail to pass minimum length validation`,
        confidence: 0.8,
      })),
    };
    const count = await processFacts(env, result);
    expect(count).toBeLessThanOrEqual(5);
  });

  it('skips recording when memoryBinding is null', async () => {
    const env = makeEnv({ memoryBinding: null });
    const result: DreamingResult = {
      facts: [
        { topic: 'aegis', fact: 'Valid fact but no memory binding available to store it', confidence: 0.9 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(0);
  });

  it('handles empty result gracefully', async () => {
    const env = makeEnv();
    const count = await processFacts(env, {});
    expect(count).toBe(0);
  });

  it('handles routing failures without crashing', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: [],
      routing_failures: [
        { thread_id: 'abc', description: 'Agent responded with greeting when user asked for analysis' },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(0); // routing failures are logged, not counted as facts
  });
});
