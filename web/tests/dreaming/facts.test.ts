import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processFacts, type DreamingResult } from '../../src/kernel/scheduled/dreaming/facts.js';

const mockRecordMemory = vi.fn().mockResolvedValue({ fragment_id: 'f-1' });
const mockRecordMemoryWithAutoTopic = vi.fn().mockResolvedValue({
  fragment_id: 'f-1',
  classification: { topic: 'aegis', confidence: 'high', source: 'classifier' },
});

// Mock memory adapter
vi.mock('../../src/kernel/memory-adapter.js', () => ({
  recordMemory: (...args: unknown[]) => mockRecordMemory(...args),
  recordMemoryWithAutoTopic: (...args: unknown[]) => mockRecordMemoryWithAutoTopic(...args),
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

function makeEnvWithAutoTopic(overrides?: Record<string, unknown>) {
  return makeEnv({
    tarotscriptFetcher: { fetch: vi.fn() },
    ...overrides,
  });
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

// ─── Auto-topic classification ──────────────────────────────

describe('processFacts with auto-topic classification', () => {
  beforeEach(() => {
    mockRecordMemory.mockClear();
    mockRecordMemoryWithAutoTopic.mockClear();
    mockRecordMemoryWithAutoTopic.mockResolvedValue({
      fragment_id: 'f-auto',
      classification: { topic: 'infrastructure', confidence: 'high', source: 'classifier' },
    });
  });

  it('uses recordMemoryWithAutoTopic when tarotscriptFetcher is available', async () => {
    const env = makeEnvWithAutoTopic();
    const result: DreamingResult = {
      facts: [
        { topic: 'infra_stuff', fact: 'The deploy pipeline now supports canary rollouts via Cloudflare', confidence: 0.9 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(1);
    expect(mockRecordMemoryWithAutoTopic).toHaveBeenCalledTimes(1);
    expect(mockRecordMemory).not.toHaveBeenCalled();
  });

  it('falls back to recordMemory when tarotscriptFetcher is absent', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      facts: [
        { topic: 'aegis', fact: 'The dispatch loop now handles 8 executor types including composite', confidence: 0.9 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(1);
    expect(mockRecordMemory).toHaveBeenCalledTimes(1);
    expect(mockRecordMemoryWithAutoTopic).not.toHaveBeenCalled();
  });

  it('skips topic allowlist check when auto-topic is active', async () => {
    const env = makeEnvWithAutoTopic();
    const result: DreamingResult = {
      facts: [
        { topic: 'random_new_topic', fact: 'A fact with an unknown LLM topic that the classifier will reclassify properly', confidence: 0.8 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(1);
    expect(mockRecordMemoryWithAutoTopic).toHaveBeenCalledTimes(1);
  });

  it('still blocks dangerous topics even with auto-topic active', async () => {
    const env = makeEnvWithAutoTopic();
    const result: DreamingResult = {
      facts: [
        { topic: 'synthesis_cross_domain', fact: 'Some vague synthesis observation that pollutes memory with noise', confidence: 0.8 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(0);
    expect(mockRecordMemoryWithAutoTopic).not.toHaveBeenCalled();
  });

  it('classifier fallback to general does not break the cycle', async () => {
    mockRecordMemoryWithAutoTopic.mockResolvedValue({
      fragment_id: 'f-fallback',
      classification: { topic: 'general', confidence: 'low', source: 'fallback' },
    });
    const env = makeEnvWithAutoTopic();
    const result: DreamingResult = {
      facts: [
        { topic: 'aegis', fact: 'Some fact that the classifier cannot confidently classify into a topic', confidence: 0.8 },
      ],
    };
    const count = await processFacts(env, result);
    expect(count).toBe(1);
    expect(mockRecordMemoryWithAutoTopic).toHaveBeenCalledTimes(1);
  });

  it('auto-classifies preferences when tarotscriptFetcher available', async () => {
    mockRecordMemoryWithAutoTopic.mockResolvedValue({
      fragment_id: 'f-pref',
      classification: { topic: 'operator', confidence: 'moderate', source: 'classifier' },
    });
    const env = makeEnvWithAutoTopic();
    const result: DreamingResult = {
      preferences: [
        { preference: 'Prefers direct communication with minimal ceremony', evidence: 'conversation thread' },
      ],
    };
    await processFacts(env, result);
    expect(mockRecordMemoryWithAutoTopic).toHaveBeenCalledTimes(1);
    expect(mockRecordMemory).not.toHaveBeenCalled();
  });

  it('uses hardcoded operator_preferences topic when no fetcher', async () => {
    const env = makeEnv();
    const result: DreamingResult = {
      preferences: [
        { preference: 'Prefers direct communication with minimal ceremony', evidence: 'conversation thread' },
      ],
    };
    await processFacts(env, result);
    expect(mockRecordMemory).toHaveBeenCalledWith(
      expect.anything(), 'operator_preferences', expect.any(String), 0.85, 'dreaming_cycle',
    );
    expect(mockRecordMemoryWithAutoTopic).not.toHaveBeenCalled();
  });
});
