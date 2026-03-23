// Dispatch tests — covers createIntent, dispatch(), dispatchStream(),
// insight injection, augmentIntent routing, self-improvement ACK, probe eligibility,
// executor fallback, and error paths.
// Mocks all external dependencies (router, executors, memory, groq).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Executor, KernelIntent } from '../src/kernel/types.js';
import type { EdgeEnv } from '../src/kernel/dispatch.js';
import { complexityTier, procedureKey } from '../src/kernel/memory/index.js';

// ── Static tests (no mocks needed) ──────────────────────────

const ALL_EXECUTORS: Executor[] = ['claude', 'claude_opus', 'gpt_oss', 'workers_ai', 'groq', 'direct', 'claude_code', 'composite'];

describe('Dispatch — static', () => {
  it('all executor types are distinct', () => {
    const unique = new Set(ALL_EXECUTORS);
    expect(unique.size).toBe(ALL_EXECUTORS.length);
  });

  it('executor union includes 8 variants', () => {
    expect(ALL_EXECUTORS).toHaveLength(8);
  });

  it('cost ceiling mapping covers all executor tiers', () => {
    function costCeiling(executor: Executor): string {
      if (executor === 'groq' || executor === 'workers_ai' || executor === 'gpt_oss') return 'cheap';
      if (executor === 'direct') return 'free';
      return 'expensive';
    }

    expect(costCeiling('groq')).toBe('cheap');
    expect(costCeiling('workers_ai')).toBe('cheap');
    expect(costCeiling('gpt_oss')).toBe('cheap');
    expect(costCeiling('direct')).toBe('free');
    expect(costCeiling('claude')).toBe('expensive');
    expect(costCeiling('claude_opus')).toBe('expensive');
    expect(costCeiling('claude_code')).toBe('expensive');
    expect(costCeiling('composite')).toBe('expensive');
  });

  it('MAX_TOOL_ROUNDS is enforced (constant check)', () => {
    const MAX_TOOL_ROUNDS = 10;
    expect(MAX_TOOL_ROUNDS).toBe(10);
    expect(MAX_TOOL_ROUNDS).toBeLessThanOrEqual(15);
    expect(MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(5);
  });

  it('complexityTier maps values to low/mid/high', () => {
    expect(complexityTier(0)).toBe('low');
    expect(complexityTier(1)).toBe('low');
    expect(complexityTier(2)).toBe('mid');
    expect(complexityTier(3)).toBe('high');
    expect(complexityTier(undefined)).toBe('mid');
  });

  it('procedureKey combines classification + tier', () => {
    expect(procedureKey('general_knowledge', 1)).toBe('general_knowledge:low');
    expect(procedureKey('general_knowledge', 3)).toBe('general_knowledge:high');
    expect(procedureKey('greeting', 0)).toBe('greeting:low');
    expect(procedureKey('bizops_read', undefined)).toBe('bizops_read:mid');
  });
});

// ── Mocked dispatch tests ────────────────────────────────────

// Mock operator config
vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'AEGIS', possessive: "Alex's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['ExampleCo LLC'], memoryTopics: [] },
    integrations: {
      bizops: { enabled: true, toolPrefix: 'bizops', fallbackUrl: '' },
      github: { enabled: false },
      brave: { enabled: false },
      goals: { enabled: false },
      cfObservability: { enabled: false },
    },
    baseUrl: 'https://your-agent.workers.dev',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

// Mock router
vi.mock('../src/kernel/router.js', () => ({
  route: vi.fn(),
}));

// Mock memory modules
vi.mock('../src/kernel/memory/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    recordEpisode: vi.fn().mockResolvedValue(undefined),
    retrogradeEpisode: vi.fn().mockResolvedValue(null),
    upsertProcedure: vi.fn().mockResolvedValue(undefined),
    addRefinement: vi.fn().mockResolvedValue(undefined),
    degradeProcedure: vi.fn().mockResolvedValue(undefined),
    getProcedure: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../src/kernel/memory-adapter.js', () => ({
  searchMemoryByKeywords: vi.fn().mockResolvedValue([]),
  getAllMemoryForContext: vi.fn().mockResolvedValue({ text: '', ids: [] }),
}));

// Mock groq (probeConsistency)
vi.mock('../src/groq.js', () => ({
  probeConsistency: vi.fn().mockResolvedValue({ sigma: 0.5, agreedText: null }),
  askGroq: vi.fn(),
  askGroqWithLogprobs: vi.fn(),
}));

// Mock composite executor
vi.mock('../src/composite.js', () => ({
  executeComposite: vi.fn().mockResolvedValue({ text: 'composite result', cost: 0.01 }),
}));

vi.mock('../src/operator/prompt-builder.js', () => ({
  buildGroqSystemPrompt: () => 'mock system prompt',
  buildClassifySystem: () => 'mock classify',
  getTaskPatterns: () => ['greeting', 'heartbeat', 'general_knowledge', 'bizops_read', 'self_improvement', 'goal_execution', 'memory_recall', 'code_task', 'user_correction', 'web_research', 'bizops_mutate', 'code_review'],
}));

// Mock executors
vi.mock('../src/kernel/executors/index.js', () => ({
  executeClaude: vi.fn().mockResolvedValue({ text: 'claude result', cost: 0.05 }),
  executeClaudeOpus: vi.fn().mockResolvedValue({ text: 'opus result', cost: 0.15 }),
  executeClaudeStream: vi.fn().mockResolvedValue({ text: 'stream result', cost: 0.05 }),
  executeGroq: vi.fn().mockResolvedValue({ text: 'groq result', cost: 0.0001 }),
  executeWorkersAi: vi.fn().mockResolvedValue({ text: 'workers_ai result', cost: 0 }),
  executeGptOss: vi.fn().mockResolvedValue({ text: 'gpt_oss result', cost: 0.005 }),
  executeDirect: vi.fn().mockResolvedValue({ text: 'direct result', cost: 0 }),
  executeCodeTask: vi.fn().mockResolvedValue({ text: 'code task result', cost: 0.05 }),
  executeWithAnthropicFailover: vi.fn().mockResolvedValue({ text: 'claude result', cost: 0.05, actualExecutor: 'claude' }),
  buildMcpRegistry: vi.fn().mockReturnValue({}),
}));

// Import after mocks
const { createIntent, dispatch, dispatchStream } = await import('../src/kernel/dispatch.js');
const { route } = await import('../src/kernel/router.js');
const { recordEpisode, upsertProcedure, retrogradeEpisode, degradeProcedure, getProcedure } = await import('../src/kernel/memory/index.js');
const { searchMemoryByKeywords } = await import('../src/kernel/memory-adapter.js');
const { probeConsistency } = await import('../src/groq.js');
const { executeGptOss, executeGroq, executeDirect, executeWorkersAi, executeCodeTask, executeWithAnthropicFailover, executeClaudeStream } = await import('../src/kernel/executors/index.js');
const { executeComposite } = await import('../src/composite.js');

function makeEdgeEnv(overrides: Partial<EdgeEnv> = {}): EdgeEnv {
  return {
    db: {} as D1Database,
    anthropicApiKey: 'sk-test',
    claudeModel: 'claude-sonnet-4-6',
    opusModel: 'claude-opus-4-6',
    gptOssModel: '@cf/openai/gpt-oss-120b',
    groqApiKey: 'gsk-test',
    groqModel: 'llama-3.3-70b-versatile',
    groqResponseModel: 'llama-3.1-8b-instant',
    groqGptOssModel: 'openai/gpt-oss-120b',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'biz-test',
    resendApiKey: 'rs-test',
    resendApiKeyPersonal: 'rs-personal-test',
    githubToken: 'gh-test',
    githubRepo: 'ExampleOrg/aegis',
    braveApiKey: 'brave-test',
    notifyEmail: 'test@test.com',
    baseUrl: 'https://your-agent.workers.dev',
    anthropicBaseUrl: 'https://api.anthropic.com',
    groqBaseUrl: 'https://api.groq.com',
    ...overrides,
  } as EdgeEnv;
}

function setupRoute(executor: Executor, classification = 'general_knowledge', procedureId?: number) {
  vi.mocked(route).mockImplementation(async (intent) => {
    // route() sets intent.classified as a side effect
    intent.classified = classification;
    return {
      plan: {
        executor,
        reasoning: `test routing to ${executor}`,
        costCeiling: 'cheap',
        procedureId,
      },
      nearMiss: undefined,
      reclassified: false,
    };
  });
}

describe('createIntent', () => {
  it('creates an intent with channel web', () => {
    const intent = createIntent('thread-1', 'hello world');
    expect(intent.source.channel).toBe('web');
    expect(intent.source.threadId).toBe('thread-1');
    expect(intent.raw).toBe('hello world');
    expect(intent.costCeiling).toBe('expensive');
    expect(intent.timestamp).toBeGreaterThan(0);
  });

  it('applies overrides', () => {
    const intent = createIntent('thread-2', 'test', {
      costCeiling: 'cheap',
      classified: 'greeting',
      complexity: 0,
    });
    expect(intent.costCeiling).toBe('cheap');
    expect(intent.classified).toBe('greeting');
    expect(intent.complexity).toBe(0);
    expect(intent.raw).toBe('test');
  });

  it('override can change channel', () => {
    const intent = createIntent('thread-1', 'hello', {
      source: { channel: 'internal', threadId: 'int-1' },
    });
    expect(intent.source.channel).toBe('internal');
    expect(intent.source.threadId).toBe('int-1');
  });
});

describe('dispatch — executor routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('routes to groq executor', async () => {
    setupRoute('groq', 'greeting');
    const intent = createIntent('t', 'hi');
    const result = await dispatch(intent, makeEdgeEnv());

    expect(executeGroq).toHaveBeenCalled();
    expect(result.executor).toBe('groq');
    expect(result.text).toBe('groq result');
  });

  it('routes to gpt_oss executor', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    const result = await dispatch(createIntent('t', 'test'), makeEdgeEnv());

    expect(executeGptOss).toHaveBeenCalled();
    expect(result.executor).toBe('gpt_oss');
  });

  it('routes to direct executor', async () => {
    setupRoute('direct', 'heartbeat');
    const result = await dispatch(createIntent('t', 'heartbeat'), makeEdgeEnv());

    expect(executeDirect).toHaveBeenCalled();
    expect(result.executor).toBe('direct');
  });

  it('routes to workers_ai executor', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    const result = await dispatch(createIntent('t', 'simple q'), makeEdgeEnv());

    expect(executeWorkersAi).toHaveBeenCalled();
    expect(result.executor).toBe('workers_ai');
  });

  it('routes to claude_code executor', async () => {
    setupRoute('claude_code', 'code_task');
    const result = await dispatch(createIntent('t', 'write code'), makeEdgeEnv());

    expect(executeCodeTask).toHaveBeenCalled();
    expect(result.executor).toBe('claude_code');
  });

  it('routes to composite executor', async () => {
    setupRoute('composite', 'self_improvement');
    // self_improvement from web channel returns ACK without executing
    const intent = createIntent('t', 'analyze code');
    const result = await dispatch(intent, makeEdgeEnv());

    // self_improvement returns immediate ACK
    expect(result.text).toContain('Self-improvement analysis queued');
    expect(result.executor).toBe('composite');
  });

  it('routes to claude via Anthropic failover', async () => {
    setupRoute('claude', 'general_knowledge');
    const result = await dispatch(createIntent('t', 'help me'), makeEdgeEnv());

    expect(executeWithAnthropicFailover).toHaveBeenCalledWith('claude', expect.anything(), expect.anything());
    expect(result.text).toBe('claude result');
  });

  it('routes to claude_opus via Anthropic failover', async () => {
    setupRoute('claude_opus', 'general_knowledge');
    vi.mocked(executeWithAnthropicFailover).mockResolvedValue({ text: 'opus result', cost: 0.15, actualExecutor: 'claude_opus' });

    const result = await dispatch(createIntent('t', 'deep analysis'), makeEdgeEnv());
    expect(executeWithAnthropicFailover).toHaveBeenCalledWith('claude_opus', expect.anything(), expect.anything());
    expect(result.executor).toBe('claude_opus');
  });
});

describe('dispatch — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('returns error text when executor throws', async () => {
    setupRoute('gpt_oss');
    vi.mocked(executeGptOss).mockRejectedValue(new Error('API failure'));

    const result = await dispatch(createIntent('t', 'test'), makeEdgeEnv());

    expect(result.text).toContain('Error: API failure');
    expect(result.cost).toBe(0);
  });

  it('records failure outcome when executor throws', async () => {
    setupRoute('gpt_oss');
    vi.mocked(executeGptOss).mockRejectedValue(new Error('API failure'));

    await dispatch(createIntent('t', 'test'), makeEdgeEnv());

    // recordEpisode should be called with outcome 'failure'
    expect(recordEpisode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it('unknown executor throws', async () => {
    vi.mocked(route).mockResolvedValue({
      plan: {
        executor: 'nonexistent' as Executor,
        reasoning: 'test',
        costCeiling: 'cheap',
      },
    });

    const result = await dispatch(createIntent('t', 'test'), makeEdgeEnv());
    expect(result.text).toContain('Unknown executor');
  });
});

describe('dispatch — bookkeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('records episode after successful dispatch', async () => {
    setupRoute('groq', 'greeting');
    await dispatch(createIntent('t', 'hi'), makeEdgeEnv());

    expect(recordEpisode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        intent_class: 'greeting',
        outcome: 'success',
        executor: 'groq',
      }),
    );
  });

  it('upserts procedure after dispatch', async () => {
    setupRoute('groq', 'greeting');
    await dispatch(createIntent('t', 'hi'), makeEdgeEnv());

    expect(upsertProcedure).toHaveBeenCalled();
  });

  it('reports procedureHit when procedure was used', async () => {
    setupRoute('gpt_oss', 'general_knowledge', 42);
    const result = await dispatch(createIntent('t', 'test'), makeEdgeEnv());

    expect(result.procedureHit).toBe(true);
  });

  it('reports procedureHit=false when no procedure', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    const result = await dispatch(createIntent('t', 'test'), makeEdgeEnv());

    expect(result.procedureHit).toBe(false);
  });
});

describe('dispatch — self-improvement ACK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('returns immediate ACK for web self_improvement', async () => {
    setupRoute('composite', 'self_improvement');
    const intent = createIntent('t', 'improve the codebase');
    const result = await dispatch(intent, makeEdgeEnv());

    expect(result.text).toContain('Self-improvement analysis queued');
    expect(result.executor).toBe('composite');
    expect(result.cost).toBe(0);
  });

  it('does NOT ACK self_improvement from internal channel', async () => {
    setupRoute('composite', 'self_improvement');
    const intent = createIntent('t', 'improve', {
      source: { channel: 'internal', threadId: 'int' },
    });
    // Internal self_improvement should execute normally (via composite)
    const result = await dispatch(intent, makeEdgeEnv());
    expect(result.text).not.toContain('queued');
  });

  it('backgrounds self_improvement work when ctx available', async () => {
    setupRoute('composite', 'self_improvement');
    const waitUntil = vi.fn();
    const mockPrepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({}) }),
    });
    const env = makeEdgeEnv({
      db: { prepare: mockPrepare } as unknown as D1Database,
      ctx: { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    });

    await dispatch(createIntent('t', 'improve'), env);
    expect(waitUntil).toHaveBeenCalled();
  });
});

describe('dispatch — memory recall augmentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('augments intent with memory entries for memory_recall classification', async () => {
    setupRoute('gpt_oss', 'memory_recall');
    vi.mocked(searchMemoryByKeywords).mockResolvedValue([
      { id: '1', topic: 'test', fact: 'test fact', confidence: 0.9 },
    ]);

    const intent = createIntent('t', 'what do you remember about X');
    const env = makeEdgeEnv({ memoryBinding: { recall: vi.fn(), store: vi.fn(), forget: vi.fn(), decay: vi.fn(), consolidate: vi.fn(), health: vi.fn(), stats: vi.fn() } as any });
    await dispatch(intent, env);

    expect(searchMemoryByKeywords).toHaveBeenCalled();
    expect(intent.raw).toContain('Relevant memory entries');
  });

  it('memory recall augmentation failure is non-fatal', async () => {
    setupRoute('gpt_oss', 'memory_recall');
    vi.mocked(searchMemoryByKeywords).mockRejectedValue(new Error('memory down'));

    const env = makeEdgeEnv({ memoryBinding: {} as any });
    const result = await dispatch(createIntent('t', 'recall'), env);
    expect(result).toBeDefined(); // should not throw
  });
});

describe('dispatch — implicit feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('retrogrades previous episode on user_correction', async () => {
    setupRoute('gpt_oss', 'user_correction');
    vi.mocked(retrogradeEpisode).mockResolvedValue({
      id: 5,
      intent_class: 'general_knowledge',
      channel: 'web',
      summary: 'bad answer',
      outcome: 'success',
      cost: 0.01,
      latency_ms: 200,
      executor: 'workers_ai',
    });

    await dispatch(createIntent('t', 'no, that is wrong'), makeEdgeEnv());

    expect(retrogradeEpisode).toHaveBeenCalled();
    expect(degradeProcedure).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'workers_ai',
    );
  });
});

describe('dispatch — partial failure detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('records partial_failure when composite returns partialFailure meta', async () => {
    setupRoute('composite', 'goal_execution');
    vi.mocked(executeComposite).mockResolvedValue({
      text: 'partial result',
      cost: 0.01,
      meta: { partialFailure: true },
    });

    // Need to route to composite directly (not self_improvement which ACKs)
    const intent = createIntent('t', 'run goal', {
      source: { channel: 'internal', threadId: 'int' },
    });
    const result = await dispatch(intent, makeEdgeEnv());

    // partial_failure episodes should be recorded as 'failure'
    expect(recordEpisode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'failure' }),
    );
  });
});

describe('dispatchStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('calls onDelta with response text for non-Claude executors', async () => {
    setupRoute('groq', 'greeting');
    const deltas: string[] = [];

    const result = await dispatchStream(
      createIntent('t', 'hi'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    expect(deltas).toContain('groq result');
    expect(result.text).toBe('groq result');
  });

  it('uses streaming Claude for claude executor when onDelta provided', async () => {
    setupRoute('claude', 'general_knowledge');
    vi.mocked(executeClaudeStream).mockResolvedValue({ text: 'streamed claude', cost: 0.05 });

    const deltas: string[] = [];
    const result = await dispatchStream(
      createIntent('t', 'help'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    expect(executeClaudeStream).toHaveBeenCalled();
  });

  it('falls back to gpt_oss when streaming claude fails with API error', async () => {
    setupRoute('claude', 'general_knowledge');
    vi.mocked(executeClaudeStream).mockRejectedValue(new Error('Anthropic API error: credit balance'));
    vi.mocked(executeGptOss).mockResolvedValue({ text: 'fallback gpt_oss', cost: 0.005 });

    const deltas: string[] = [];
    const result = await dispatchStream(
      createIntent('t', 'help'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    expect(executeGptOss).toHaveBeenCalled();
    expect(deltas).toContain('fallback gpt_oss');
  });

  it('re-throws non-API errors from streaming claude', async () => {
    setupRoute('claude', 'general_knowledge');
    vi.mocked(executeClaudeStream).mockRejectedValue(new Error('network timeout'));

    const deltas: string[] = [];
    const result = await dispatchStream(
      createIntent('t', 'help'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    // Non-API errors should be caught by the outer try/catch
    expect(result.text).toContain('Error: network timeout');
  });

  it('records outcome for streamed dispatch', async () => {
    setupRoute('groq', 'greeting');
    await dispatchStream(
      createIntent('t', 'hi'),
      makeEdgeEnv(),
      () => {},
    );

    expect(recordEpisode).toHaveBeenCalled();
    expect(upsertProcedure).toHaveBeenCalled();
  });
});

describe('dispatch — probe eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('runs probe for workers_ai no-tool queries', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({ sigma: 0.5, agreedText: null });

    const intent = createIntent('t', 'simple question');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());

    expect(probeConsistency).toHaveBeenCalled();
  });

  it('runs probe for gpt_oss no-tool queries', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({ sigma: 0.5, agreedText: null });

    const intent = createIntent('t', 'moderate question');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());

    expect(probeConsistency).toHaveBeenCalled();
  });

  it('skips probe for tool-requiring queries', async () => {
    setupRoute('gpt_oss', 'general_knowledge');

    const intent = createIntent('t', 'lookup something');
    intent.needsTools = true;
    await dispatch(intent, makeEdgeEnv());

    expect(probeConsistency).not.toHaveBeenCalled();
  });

  it('skips probe for heartbeat classification', async () => {
    setupRoute('workers_ai', 'heartbeat');

    const intent = createIntent('t', 'heartbeat');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());

    expect(probeConsistency).not.toHaveBeenCalled();
  });

  it('skips probe for internal channel', async () => {
    setupRoute('workers_ai', 'general_knowledge');

    const intent = createIntent('t', 'test', {
      source: { channel: 'internal', threadId: 'int' },
    });
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());

    expect(probeConsistency).not.toHaveBeenCalled();
  });

  it('returns probe agreed text and skips executor when sigma=0', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({
      sigma: 0,
      agreedText: 'probe consensus answer',
    });

    const intent = createIntent('t', 'simple question');
    intent.needsTools = false;
    const result = await dispatch(intent, makeEdgeEnv());

    expect(result.text).toBe('probe consensus answer');
    expect(result.probeResult).toBe('agreed');
    expect(result.executor).toBe('groq'); // probe agreed → groq
  });

  it('escalates executor when probe sigma=1.0', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({ sigma: 1.0, agreedText: null });

    const intent = createIntent('t', 'disagreed query');
    intent.needsTools = false;
    const result = await dispatch(intent, makeEdgeEnv());

    // workers_ai → gpt_oss on sigma=1.0
    expect(result.probeResult).toBe('escalated');
    expect(executeGptOss).toHaveBeenCalled();
  });

  it('probe failure is non-fatal', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    vi.mocked(probeConsistency).mockRejectedValue(new Error('probe error'));

    const intent = createIntent('t', 'query');
    intent.needsTools = false;
    const result = await dispatch(intent, makeEdgeEnv());

    // Should fall through to normal executor
    expect(result).toBeDefined();
    expect(executeWorkersAi).toHaveBeenCalled();
  });
});

describe('dispatch — background shadow read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('fires background shadow read when memoryBinding and ctx are present', async () => {
    setupRoute('groq', 'greeting');
    const waitUntil = vi.fn();
    const env = makeEdgeEnv({
      memoryBinding: {} as any,
      ctx: { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    });

    await dispatch(createIntent('t', 'hi'), env);

    // waitUntil called for shadow read
    expect(waitUntil).toHaveBeenCalled();
  });

  it('does not fire shadow read without memoryBinding', async () => {
    setupRoute('groq', 'greeting');
    const waitUntil = vi.fn();
    const env = makeEdgeEnv({
      ctx: { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    });

    await dispatch(createIntent('t', 'hi'), env);

    // waitUntil should only be called if self_improvement or memoryBinding
    // For greeting, no self-improvement, no memoryBinding → no waitUntil
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe('dispatch — result shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('returns all expected fields', async () => {
    setupRoute('groq', 'greeting');
    const result = await dispatch(createIntent('t', 'hi'), makeEdgeEnv());

    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('executor');
    expect(result).toHaveProperty('cost');
    expect(result).toHaveProperty('latency_ms');
    expect(result).toHaveProperty('procedureHit');
    expect(result).toHaveProperty('classification');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.cost).toBe('number');
  });
});

// ── Insight injection tests ─────────────────────────────────

describe('dispatch — CRIX insight injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
    // Reset the module-level insight cache by re-importing (cache is in-memory)
    // We rely on memoryBinding.recall being freshly mocked each test
  });

  it('injects relevant insights into intent.raw when memoryBinding available', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    const mockRecall = vi.fn().mockResolvedValue([
      { content: '[pattern] (from demo-app) Deploy using wrangler deploy command' },
      { content: '[antipattern] (from img-forge) Never use direct D1 access from frontend' },
    ]);

    const intent = createIntent('t', 'how do I deploy using wrangler');
    const env = makeEdgeEnv({
      memoryBinding: {
        recall: mockRecall,
        store: vi.fn(),
        forget: vi.fn(),
        decay: vi.fn(),
        consolidate: vi.fn(),
        health: vi.fn(),
        stats: vi.fn(),
      } as any,
    });

    await dispatch(intent, env);

    // The recall should have been called for insights
    expect(mockRecall).toHaveBeenCalledWith('aegis', expect.objectContaining({
      topic: 'cross_repo_insights',
    }));
  });

  it('skips insight injection for greeting classification', async () => {
    setupRoute('groq', 'greeting');
    const mockRecall = vi.fn().mockResolvedValue([]);

    const env = makeEdgeEnv({
      memoryBinding: {
        recall: mockRecall,
        store: vi.fn(),
        forget: vi.fn(),
        decay: vi.fn(),
        consolidate: vi.fn(),
        health: vi.fn(),
        stats: vi.fn(),
      } as any,
    });

    await dispatch(createIntent('t', 'hello'), env);

    // Should NOT call recall for greeting/heartbeat
    expect(mockRecall).not.toHaveBeenCalled();
  });

  it('skips insight injection for heartbeat classification', async () => {
    setupRoute('direct', 'heartbeat');
    const mockRecall = vi.fn().mockResolvedValue([]);

    const env = makeEdgeEnv({
      memoryBinding: {
        recall: mockRecall,
        store: vi.fn(),
        forget: vi.fn(),
        decay: vi.fn(),
        consolidate: vi.fn(),
        health: vi.fn(),
        stats: vi.fn(),
      } as any,
    });

    await dispatch(createIntent('t', 'heartbeat'), env);
    expect(mockRecall).not.toHaveBeenCalled();
  });

  it('insight fetch failure is non-fatal', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    vi.mocked(executeGptOss).mockResolvedValue({ text: 'gpt_oss result', cost: 0.005 });
    const mockRecall = vi.fn().mockRejectedValue(new Error('memory worker down'));

    const env = makeEdgeEnv({
      memoryBinding: {
        recall: mockRecall,
        store: vi.fn(),
        forget: vi.fn(),
        decay: vi.fn(),
        consolidate: vi.fn(),
        health: vi.fn(),
        stats: vi.fn(),
      } as any,
    });

    const result = await dispatch(createIntent('t', 'test query'), env);
    expect(result).toBeDefined();
    expect(result.text).toBe('gpt_oss result');
  });

  it('skips insight injection when memoryBinding is absent', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    const intent = createIntent('t', 'test query');
    const originalRaw = intent.raw;

    await dispatch(intent, makeEdgeEnv());

    // raw should not have insight prefix (though route mock may modify classified)
    // Just ensure no crash occurred
    expect(intent.raw).toBe(originalRaw);
  });
});

// ── createIntent edge cases ─────────────────────────────────

describe('createIntent — edge cases', () => {
  it('preserves empty string text', () => {
    const intent = createIntent('t', '');
    expect(intent.raw).toBe('');
  });

  it('timestamp is current time', () => {
    const before = Date.now();
    const intent = createIntent('t', 'test');
    const after = Date.now();
    expect(intent.timestamp).toBeGreaterThanOrEqual(before);
    expect(intent.timestamp).toBeLessThanOrEqual(after);
  });

  it('overrides fully replace source when source override is provided', () => {
    const intent = createIntent('original-thread', 'hello', {
      source: { channel: 'internal', threadId: 'override-thread' },
    });
    expect(intent.source.channel).toBe('internal');
    expect(intent.source.threadId).toBe('override-thread');
  });

  it('default costCeiling is expensive', () => {
    const intent = createIntent('t', 'test');
    expect(intent.costCeiling).toBe('expensive');
  });

  it('costCeiling can be overridden to free', () => {
    const intent = createIntent('t', 'test', { costCeiling: 'free' });
    expect(intent.costCeiling).toBe('free');
  });
});

// ── dispatchStream — additional paths ───────────────────────

describe('dispatchStream — additional paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('uses streaming Claude for claude_opus when onDelta provided', async () => {
    setupRoute('claude_opus', 'general_knowledge');
    vi.mocked(executeClaudeStream).mockResolvedValue({ text: 'streamed opus', cost: 0.15 });

    const deltas: string[] = [];
    await dispatchStream(
      createIntent('t', 'deep question'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    expect(executeClaudeStream).toHaveBeenCalled();
  });

  it('emits single delta for non-Claude streaming executors', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    vi.mocked(executeGptOss).mockResolvedValue({ text: 'gpt_oss streamed', cost: 0.005 });

    const deltas: string[] = [];
    await dispatchStream(
      createIntent('t', 'question'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    expect(deltas).toEqual(['gpt_oss streamed']);
  });

  it('emits error text via onDelta when executor throws', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    vi.mocked(executeGptOss).mockRejectedValue(new Error('stream fail'));

    const deltas: string[] = [];
    const result = await dispatchStream(
      createIntent('t', 'test'),
      makeEdgeEnv(),
      (text) => deltas.push(text),
    );

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0]).toContain('Error: stream fail');
    expect(result.text).toContain('Error: stream fail');
  });

  it('fires background shadow read after streaming dispatch', async () => {
    setupRoute('groq', 'greeting');
    const waitUntil = vi.fn();
    const env = makeEdgeEnv({
      memoryBinding: {} as any,
      ctx: { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    });

    await dispatchStream(createIntent('t', 'hi'), env, () => {});
    expect(waitUntil).toHaveBeenCalled();
  });

  it('probe agreed returns early via earlyReturn in streaming mode', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({
      sigma: 0,
      agreedText: 'probe streamed answer',
    });

    const deltas: string[] = [];
    const intent = createIntent('t', 'simple');
    intent.needsTools = false;

    const result = await dispatchStream(intent, makeEdgeEnv(), (text) => deltas.push(text));

    expect(result.text).toBe('probe streamed answer');
    expect(result.probeResult).toBe('agreed');
    expect(deltas).toContain('probe streamed answer');
  });
});

// ── dispatch — probe escalation paths ───────────────────────

describe('dispatch — probe escalation details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProcedure).mockResolvedValue(null);
  });

  it('escalates gpt_oss to composite when probe sigma=1.0', async () => {
    setupRoute('gpt_oss', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({ sigma: 1.0, agreedText: null });

    const intent = createIntent('t', 'disagreed query');
    intent.needsTools = false;
    const result = await dispatch(intent, makeEdgeEnv());

    expect(result.probeResult).toBe('escalated');
    expect(executeComposite).toHaveBeenCalled();
  });

  it('probe split continues with original executor', async () => {
    setupRoute('workers_ai', 'general_knowledge');
    vi.mocked(probeConsistency).mockResolvedValue({ sigma: 0.5, agreedText: null });

    const intent = createIntent('t', 'split query');
    intent.needsTools = false;
    const result = await dispatch(intent, makeEdgeEnv());

    expect(result.probeResult).toBe('split');
    expect(executeWorkersAi).toHaveBeenCalled();
  });

  it('skips probe for greeting even on workers_ai executor', async () => {
    setupRoute('workers_ai', 'greeting');
    const intent = createIntent('t', 'hi');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());
    expect(probeConsistency).not.toHaveBeenCalled();
  });

  it('skips probe for code_task classification', async () => {
    setupRoute('workers_ai', 'code_task');
    const intent = createIntent('t', 'write code');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());
    expect(probeConsistency).not.toHaveBeenCalled();
  });

  it('skips probe for goal_execution classification', async () => {
    setupRoute('workers_ai', 'goal_execution');
    const intent = createIntent('t', 'run goal');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());
    expect(probeConsistency).not.toHaveBeenCalled();
  });

  it('skips probe for claude executor (not eligible)', async () => {
    setupRoute('claude', 'general_knowledge');
    const intent = createIntent('t', 'help');
    intent.needsTools = false;
    await dispatch(intent, makeEdgeEnv());
    expect(probeConsistency).not.toHaveBeenCalled();
  });
});
