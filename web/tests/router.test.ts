// Router tests — verifies classification JSON parsing, complexity-aware routing,
// confidence thresholds, composite eligibility, procedural lookup, and fallback paths
// Mocks Groq API + D1 to test pure routing logic without external calls

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock operator config before importing router
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
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

// Mock askGroq — returns controlled classification responses
const mockAskGroq = vi.fn();
const mockAskGroqWithLogprobs = vi.fn();
vi.mock('../src/groq.js', () => ({
  askGroq: (...args: unknown[]) => mockAskGroq(...args),
  askGroqWithLogprobs: (...args: unknown[]) => mockAskGroqWithLogprobs(...args),
}));

// Mock memory functions
vi.mock('../src/kernel/memory/index.js', () => ({
  getProcedure: vi.fn().mockResolvedValue(null),
  findNearMiss: vi.fn().mockResolvedValue(null),
  getConversationHistory: vi.fn().mockResolvedValue([]),
  procedureKey: (classification: string, complexity: number | undefined) => {
    const c = complexity ?? 2;
    const tier = c <= 1 ? 'low' : c >= 3 ? 'high' : 'mid';
    return `${classification}:${tier}`;
  },
  complexityTier: (complexity: number | undefined) => {
    const c = complexity ?? 2;
    return c <= 1 ? 'low' : c >= 3 ? 'high' : 'mid';
  },
  PROCEDURE_MIN_SUCCESSES: 3,
  PROCEDURE_MIN_SUCCESS_RATE: 0.7,
}));

// Import after mocks are set up
const { route } = await import('../src/kernel/router.js');
const { getProcedure, findNearMiss, getConversationHistory } = await import('../src/kernel/memory/index.js');

const mockDb = {} as D1Database;

function makeIntent(text: string, overrides: Record<string, unknown> = {}) {
  return {
    source: { channel: 'web' as const, threadId: 'test-thread' },
    raw: text,
    timestamp: Date.now(),
    costCeiling: 'expensive' as const,
    ...overrides,
  };
}

function jsonClass(pattern: string, complexity = 2, needsTools = false, confidence = 0.9) {
  return JSON.stringify({ pattern, complexity, needs_tools: needsTools, confidence });
}

describe('Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default mock implementations (clearAllMocks strips them)
    vi.mocked(getProcedure).mockResolvedValue(null);
    vi.mocked(findNearMiss).mockResolvedValue(null);
    vi.mocked(getConversationHistory).mockResolvedValue([]);
    mockAskGroqWithLogprobs.mockResolvedValue({
      pattern: 'general_knowledge',
      complexity: 2,
      needs_tools: false,
      selfReportedConfidence: 0.9,
      tokenConfidence: 0.9,
    });
  });

  // ── Basic classification + routing ─────────────────────────

  describe('classification parsing', () => {
    it('parses JSON classification and routes greeting to groq', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('greeting', 0, false, 0.99));

      const intent = makeIntent('hi there');
      const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

      expect(intent.classified).toBe('greeting');
      expect(plan.executor).toBe('gpt_oss');
      expect(intent.complexity).toBe(0);
      expect(intent.needsTools).toBe(false);
    });

    it('falls back to plain string when Groq returns non-JSON', async () => {
      mockAskGroq.mockResolvedValue('heartbeat');

      const intent = makeIntent('run a heartbeat');
      const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

      expect(intent.classified).toBe('heartbeat');
      expect(plan.executor).toBe('direct');
      expect(intent.complexity).toBeUndefined();
    });

    it('falls back to general_knowledge on unrecognized classification', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('nonexistent_category', 1));

      const intent = makeIntent('something weird');
      const { nearMiss } = await route(intent, mockDb, 'fake-key', 'fake-model');

      expect(intent.classified).toBe('general_knowledge');
      expect(nearMiss).toContain('router_fallback');
    });

    it('falls back to general_knowledge on Groq error', async () => {
      mockAskGroq.mockRejectedValue(new Error('Groq API timeout'));

      const intent = makeIntent('hello');
      const { nearMiss } = await route(intent, mockDb, 'fake-key', 'fake-model');

      expect(intent.classified).toBe('general_knowledge');
      expect(nearMiss).toBe('router_fallback:groq_error');
    });
  });

  // ── selectDefaultExecutor — fixed routes ───────────────────

  describe('selectDefaultExecutor — fixed routes', () => {
    it('heartbeat → direct', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('heartbeat', 1, false, 0.95));
      const { plan } = await route(makeIntent('heartbeat'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('direct');
    });

    it('greeting → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('greeting', 0, false, 0.95));
      const { plan } = await route(makeIntent('hi'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('code_task → claude_code', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('code_task', 2, true, 0.9));
      const { plan } = await route(makeIntent('write a function'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude_code');
    });

    it('user_correction → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('user_correction', 2, false, 0.85));
      const { plan } = await route(makeIntent('no that is wrong'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('memory_recall → gpt_oss (never workers_ai)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('memory_recall', 1, false, 0.9));
      const { plan } = await route(makeIntent('what do you know about X'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('self_improvement → composite', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('self_improvement', 2, true, 0.85));
      const { plan } = await route(makeIntent('analyze codebase'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('composite');
    });
  });

  // ── selectDefaultExecutor — goal_execution ─────────────────

  describe('selectDefaultExecutor — goal_execution', () => {
    it('simple goal with tools → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('goal_execution', 1, true, 0.9));
      const { plan } = await route(makeIntent('run goal'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('complex goal → composite', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('goal_execution', 2, true, 0.85));
      const { plan } = await route(makeIntent('complex goal'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('composite');
    });
  });

  // ── selectDefaultExecutor — complexity / tools / trust zone ─

  describe('selectDefaultExecutor — trust zone routing', () => {
    it('tool-requiring in trust zone → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, true, 0.9));
      const { plan } = await route(makeIntent('lookup something'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('bizops_read → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('bizops_read', 1, false, 0.9));
      const { plan } = await route(makeIntent('compliance status'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('web_research → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('web_research', 2, false, 0.9));
      const { plan } = await route(makeIntent('search for info'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('bizops_mutate → gpt_oss (not composite)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('bizops_mutate', 2, true, 0.9));
      const { plan } = await route(makeIntent('update org'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('simple no-tool in trust zone → workers_ai', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 1, false, 0.85));
      const { plan } = await route(makeIntent('what is CORS'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('workers_ai');
    });

    it('moderate no-tool in trust zone → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      const { plan } = await route(makeIntent('explain REST vs GraphQL'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('high complexity (≥ 3) → claude_opus', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 3, false, 0.85));
      const { plan } = await route(makeIntent('design an architecture'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude_opus');
    });
  });

  // ── Confidence thresholds ──────────────────────────────────

  describe('confidence thresholds', () => {
    it('escalate zone (< 0.50) → sends directly to claude, skips procedure lookup', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.3));
      const { plan } = await route(makeIntent('ambiguous query'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude');
      expect(plan.reasoning).toContain('Low-confidence');
      // Should NOT have called getProcedure
      expect(getProcedure).not.toHaveBeenCalled();
    });

    it('escalate zone for heartbeat still returns direct (fixed route)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('heartbeat', 1, false, 0.3));
      const { plan } = await route(makeIntent('heartbeat?'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('direct');
    });

    it('verify zone (0.50-0.79) triggers Groq logprobs re-classification', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'bizops_read',
        complexity: 2,
        needs_tools: true,
        selfReportedConfidence: 0.9,
        tokenConfidence: 0.85,
      });

      const intent = makeIntent('check compliance');
      const { plan, reclassified } = await route(intent, mockDb, 'k', 'm');

      expect(mockAskGroqWithLogprobs).toHaveBeenCalled();
      expect(reclassified).toBe(true);
      expect(intent.classified).toBe('bizops_read');
    });

    it('verify zone keeps original when Groq logprobs also uncertain', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'general_knowledge',
        complexity: 2,
        needs_tools: false,
        selfReportedConfidence: 0.65,
        tokenConfidence: 0.5,
      });

      const intent = makeIntent('some query');
      const { reclassified } = await route(intent, mockDb, 'k', 'm');
      expect(reclassified).toBe(false);
    });

    it('verify zone with tools → gpt_oss', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, true, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'general_knowledge',
        complexity: 2,
        needs_tools: true,
        selfReportedConfidence: 0.65,
        tokenConfidence: 0.5,
      });

      const { plan } = await route(makeIntent('lookup with tools'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('verify zone no-tool low complexity → gpt_oss (bumped from workers_ai)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 1, false, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'general_knowledge',
        complexity: 1,
        needs_tools: false,
        selfReportedConfidence: 0.65,
        tokenConfidence: 0.5,
      });

      const { plan } = await route(makeIntent('simple uncertain'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('verify zone moderate no-tool → claude', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'general_knowledge',
        complexity: 2,
        needs_tools: false,
        selfReportedConfidence: 0.65,
        tokenConfidence: 0.5,
      });

      const { plan } = await route(makeIntent('moderate uncertain'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude');
    });

    it('trust zone (≥ 0.80) does NOT trigger logprobs', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      await route(makeIntent('confident query'), mockDb, 'k', 'm');
      expect(mockAskGroqWithLogprobs).not.toHaveBeenCalled();
    });

    it('verify zone logprobs failure is non-fatal', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.65));
      mockAskGroqWithLogprobs.mockRejectedValue(new Error('logprobs API error'));

      // Should still return a valid plan
      const { plan } = await route(makeIntent('uncertain'), mockDb, 'k', 'm');
      expect(plan).toBeDefined();
      expect(plan.executor).toBeDefined();
    });
  });

  // ── Internal channel bypass ────────────────────────────────

  describe('internal channel bypass', () => {
    it('skips classification for internal triggers with classified intent', async () => {
      const intent = makeIntent('heartbeat check', {
        source: { channel: 'internal', threadId: 'int-1' },
        classified: 'heartbeat',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(plan.executor).toBe('direct');
      expect(mockAskGroq).not.toHaveBeenCalled();
    });

    it('uses mature procedure for internal triggers', async () => {
      vi.mocked(getProcedure).mockResolvedValue({
        id: 1,
        task_pattern: 'heartbeat:low',
        executor: 'direct',
        executor_config: '{}',
        success_count: 5,
        fail_count: 0,
        avg_latency_ms: 10,
        avg_cost: 0,
        status: 'learned',
        consecutive_failures: 0,
        refinements: '[]',
      });

      const intent = makeIntent('heartbeat', {
        source: { channel: 'internal', threadId: 'int-1' },
        classified: 'heartbeat',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(plan.procedureId).toBe(1);
    });

    it('replans when internal procedure is degraded', async () => {
      vi.mocked(getProcedure).mockResolvedValue({
        id: 2,
        task_pattern: 'heartbeat:low',
        executor: 'direct',
        executor_config: '{}',
        success_count: 5,
        fail_count: 3,
        avg_latency_ms: 10,
        avg_cost: 0,
        status: 'degraded',
        consecutive_failures: 2,
        refinements: '[]',
      });

      const intent = makeIntent('heartbeat', {
        source: { channel: 'internal', threadId: 'int-1' },
        classified: 'heartbeat',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(plan.reasoning).toContain('replanning');
    });

    it('uses default route when internal trigger has no procedure', async () => {
      const intent = makeIntent('self improve', {
        source: { channel: 'internal', threadId: 'int-1' },
        classified: 'self_improvement',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(plan.executor).toBe('composite');
      expect(plan.reasoning).toContain('no mature procedure');
    });

    it('falls back to direct for unknown internal classification', async () => {
      const intent = makeIntent('unknown', {
        source: { channel: 'internal', threadId: 'int-1' },
        classified: 'totally_unknown_class',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(plan.executor).toBe('direct');
    });
  });

  // ── Procedural lookup (Phase 2) ────────────────────────────

  describe('procedural lookup', () => {
    it('uses mature procedure when success count and rate meet thresholds', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(getProcedure).mockResolvedValue({
        id: 10,
        task_pattern: 'general_knowledge:mid',
        executor: 'gpt_oss',
        executor_config: '{}',
        success_count: 5,
        fail_count: 1,
        avg_latency_ms: 200,
        avg_cost: 0.01,
        status: 'learned',
        consecutive_failures: 0,
        refinements: '[]',
      });

      const { plan } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
      expect(plan.procedureId).toBe(10);
      expect(plan.reasoning).toContain('Matched procedure');
    });

    it('replans degraded procedure via DEFAULT_ROUTES', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(getProcedure).mockResolvedValue({
        id: 11,
        task_pattern: 'general_knowledge:mid',
        executor: 'workers_ai',
        executor_config: '{}',
        success_count: 3,
        fail_count: 3,
        avg_latency_ms: 500,
        avg_cost: 0,
        status: 'degraded',
        consecutive_failures: 2,
        refinements: '[]',
      });

      const { plan } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(plan.reasoning).toContain('degraded');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('replans broken procedure', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('greeting', 1, false, 0.95));
      vi.mocked(getProcedure).mockResolvedValue({
        id: 12,
        task_pattern: 'greeting:low',
        executor: 'groq',
        executor_config: '{}',
        success_count: 5,
        fail_count: 5,
        avg_latency_ms: 200,
        avg_cost: 0,
        status: 'broken',
        consecutive_failures: 5,
        refinements: '[]',
      });

      const { plan } = await route(makeIntent('hi'), mockDb, 'k', 'm');
      expect(plan.reasoning).toContain('broken');
      expect(plan.executor).toBe('gpt_oss'); // DEFAULT_ROUTES['greeting']
    });

    it('falls to Phase 3 when procedure has insufficient successes', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(getProcedure).mockResolvedValue({
        id: 13,
        task_pattern: 'general_knowledge:mid',
        executor: 'workers_ai',
        executor_config: '{}',
        success_count: 1,
        fail_count: 0,
        avg_latency_ms: 100,
        avg_cost: 0,
        status: 'learning',
        consecutive_failures: 0,
        refinements: '[]',
      });

      const { plan } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(plan.procedureId).toBeUndefined();
      expect(plan.reasoning).toContain('First-time routing');
    });

    it('falls to Phase 3 when procedure success rate below threshold', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(getProcedure).mockResolvedValue({
        id: 14,
        task_pattern: 'general_knowledge:mid',
        executor: 'gpt_oss',
        executor_config: '{}',
        success_count: 3,
        fail_count: 5, // rate = 3/8 = 0.375 < 0.7
        avg_latency_ms: 200,
        avg_cost: 0.01,
        status: 'learning',
        consecutive_failures: 0,
        refinements: '[]',
      });

      const { plan } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(plan.procedureId).toBeUndefined();
    });

    it('records near-miss when no procedure found', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(findNearMiss).mockResolvedValue('general_knowledge:high');

      const { nearMiss } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(nearMiss).toBe('general_knowledge:high');
    });

    it('uses complexity-tiered procedure keys', async () => {
      // Low complexity → :low tier
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 1, false, 0.95));
      await route(makeIntent('what is CORS?'), mockDb, 'k', 'm');
      expect(getProcedure).toHaveBeenCalledWith(mockDb, 'general_knowledge:low');

      vi.mocked(getProcedure).mockClear();

      // High complexity → :high tier
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 3, false, 0.85));
      await route(makeIntent('design an architecture'), mockDb, 'k', 'm');
      expect(getProcedure).toHaveBeenCalledWith(mockDb, 'general_knowledge:high');
    });
  });

  // ── Workers AI classification ──────────────────────────────

  describe('Workers AI classification', () => {
    it('uses Workers AI when available before falling back to Groq', async () => {
      const mockAi = {
        run: vi.fn().mockResolvedValue({
          response: jsonClass('greeting', 1, false, 0.95),
        }),
      } as unknown as Ai;

      const { plan } = await route(makeIntent('hello'), mockDb, 'k', 'm', undefined, mockAi);
      expect(mockAi.run).toHaveBeenCalled();
      expect(plan.executor).toBe('gpt_oss'); // greeting → gpt_oss
      expect(mockAskGroq).not.toHaveBeenCalled();
    });

    it('falls back to Groq when Workers AI returns empty response', async () => {
      const mockAi = {
        run: vi.fn().mockResolvedValue({ response: '' }),
      } as unknown as Ai;

      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      await route(makeIntent('test'), mockDb, 'k', 'm', undefined, mockAi);
      expect(mockAskGroq).toHaveBeenCalled();
    });

    it('falls back to Groq when Workers AI throws', async () => {
      const mockAi = {
        run: vi.fn().mockRejectedValue(new Error('Workers AI unavailable')),
      } as unknown as Ai;

      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      await route(makeIntent('test'), mockDb, 'k', 'm', undefined, mockAi);
      expect(mockAskGroq).toHaveBeenCalled();
    });
  });

  // ── Conversation context ───────────────────────────────────

  describe('conversation context', () => {
    it('prepends conversation history for web channel', async () => {
      vi.mocked(getConversationHistory).mockResolvedValue([
        { role: 'user', content: 'What is AEGIS?' },
        { role: 'assistant', content: 'AEGIS is a personal AI agent.' },
      ]);
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));

      await route(makeIntent('tell me more'), mockDb, 'k', 'm');

      const classifyInput = mockAskGroq.mock.calls[0]?.[3] as string;
      expect(classifyInput).toContain('[Conversation context]');
      expect(classifyInput).toContain('What is AEGIS?');
    });

    it('does not fetch history for non-web channels', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));

      await route(makeIntent('test', { source: { channel: 'cli', threadId: 'cli-1' } }), mockDb, 'k', 'm');
      expect(getConversationHistory).not.toHaveBeenCalled();
    });

    it('classifies without context when history fetch fails', async () => {
      vi.mocked(getConversationHistory).mockRejectedValue(new Error('D1 error'));
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));

      // Should not throw
      const { plan } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(plan).toBeDefined();
    });
  });

  // ── Cost ceiling in plan ───────────────────────────────────

  describe('cost ceiling', () => {
    it('sets free cost ceiling for direct executor', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('heartbeat', 1, false, 0.95));
      const { plan } = await route(makeIntent('heartbeat'), mockDb, 'k', 'm');
      expect(plan.costCeiling).toBe('free');
    });

    it('sets cheap cost ceiling for groq executor', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('greeting', 0, false, 0.95));
      const { plan } = await route(makeIntent('hi'), mockDb, 'k', 'm');
      expect(plan.costCeiling).toBe('cheap');
    });

    it('sets expensive cost ceiling for claude_opus', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 3, false, 0.85));
      const { plan } = await route(makeIntent('deep analysis'), mockDb, 'k', 'm');
      expect(plan.costCeiling).toBe('expensive');
    });
  });

  // ─── Phase 0: Internal channel bypass ──────────────────────

  it('bypasses classification for internal channel with pre-classified intent', async () => {
    const intent = {
      ...makeIntent('heartbeat check'),
      source: { channel: 'internal' as const, threadId: 'int-1' },
      classified: 'heartbeat',
    };

    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

    expect(plan.executor).toBe('direct'); // default route for heartbeat
    expect(plan.reasoning).toContain('Internal trigger');
    // askGroq should NOT have been called — internal bypasses classification
    expect(mockAskGroq).not.toHaveBeenCalled();
  });

  it('uses mature procedure for internal trigger when available', async () => {
    const { getProcedure } = await import('../src/kernel/memory/index.js');
    vi.mocked(getProcedure).mockResolvedValueOnce({
      id: 10,
      task_pattern: 'heartbeat:low',
      executor: 'direct',
      executor_config: '{}',
      success_count: 5,
      fail_count: 0,
      avg_latency_ms: 50,
      avg_cost: 0,
      status: 'learned',
      consecutive_failures: 0,
      refinements: '[]',
    } as import('../src/kernel/types.js').ProceduralEntry);

    const intent = {
      ...makeIntent('heartbeat'),
      source: { channel: 'internal' as const, threadId: 'int-2' },
      classified: 'heartbeat',
      complexity: 0,
    };

    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

    expect(plan.procedureId).toBe(10);
    expect(plan.executor).toBe('direct');
  });

  it('replans when internal trigger has degraded procedure', async () => {
    const { getProcedure } = await import('../src/kernel/memory/index.js');
    vi.mocked(getProcedure).mockResolvedValueOnce({
      id: 11,
      task_pattern: 'bizops_read:mid',
      executor: 'gpt_oss',
      executor_config: '{}',
      success_count: 3,
      fail_count: 5,
      avg_latency_ms: 2000,
      avg_cost: 0.05,
      status: 'degraded',
      consecutive_failures: 2,
      refinements: '[]',
    } as import('../src/kernel/types.js').ProceduralEntry);

    const intent = {
      ...makeIntent('check compliance'),
      source: { channel: 'internal' as const, threadId: 'int-3' },
      classified: 'bizops_read',
    };

    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

    expect(plan.reasoning).toContain('degraded');
    expect(plan.reasoning).toContain('replanning');
    expect(plan.executor).toBe('gpt_oss'); // DEFAULT_ROUTES[bizops_read]
  });

  // ─── Phase 1.5: Confidence thresholds ─────────────────────

  it('escalates to claude on low confidence (<0.50)', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"general_knowledge","complexity":2,"needs_tools":false,"confidence":0.35}');

    const intent = makeIntent('ambiguous query');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

    expect(plan.executor).toBe('claude');
    expect(plan.reasoning).toContain('Low-confidence');
  });

  it('triggers Groq re-classification in verify zone (0.50-0.79)', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"general_knowledge","complexity":2,"needs_tools":false,"confidence":0.65}');

    const intent = makeIntent('somewhat ambiguous');
    await route(intent, mockDb, 'fake-key', 'fake-model');

    expect(mockAskGroqWithLogprobs).toHaveBeenCalled();
  });

  // ─── Phase 2: Procedure matching ──────────────────────────

  it('uses learned procedure when success count and rate meet thresholds', async () => {
    const { getProcedure } = await import('../src/kernel/memory/index.js');
    vi.mocked(getProcedure).mockResolvedValueOnce({
      id: 20,
      task_pattern: 'general_knowledge:mid',
      executor: 'gpt_oss',
      executor_config: '{}',
      success_count: 5,
      fail_count: 1,
      avg_latency_ms: 300,
      avg_cost: 0.002,
      status: 'learned',
      consecutive_failures: 0,
      refinements: '[]',
    } as import('../src/kernel/types.js').ProceduralEntry);

    mockAskGroq.mockResolvedValue('{"pattern":"general_knowledge","complexity":2,"needs_tools":false,"confidence":0.95}');

    const intent = makeIntent('familiar question');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');

    expect(plan.procedureId).toBe(20);
    expect(plan.executor).toBe('gpt_oss');
    expect(plan.reasoning).toContain('Matched procedure');
  });

  // ─── Phase 3: selectDefaultExecutor edge cases ────────────

  it('routes code_task to claude_code regardless of complexity', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"code_task","complexity":1,"needs_tools":true,"confidence":0.95}');
    const intent = makeIntent('write a function');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('claude_code');
  });

  it('routes user_correction to gpt_oss', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"user_correction","complexity":1,"needs_tools":false,"confidence":0.90}');
    const intent = makeIntent('no that was wrong');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('gpt_oss');
  });

  it('routes memory_recall to gpt_oss (never workers_ai)', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"memory_recall","complexity":1,"needs_tools":false,"confidence":0.95}');
    const intent = makeIntent('what do you remember about X');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('gpt_oss');
  });

  it('routes simple goal_execution to gpt_oss (not composite)', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"goal_execution","complexity":1,"needs_tools":true,"confidence":0.90}');
    const intent = makeIntent('check a goal');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('gpt_oss');
  });

  it('routes complex goal_execution to composite', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"goal_execution","complexity":2,"needs_tools":true,"confidence":0.90}');
    const intent = makeIntent('execute multi-step goal');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('composite');
  });

  it('routes bizops_mutate to gpt_oss in trust zone', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"bizops_mutate","complexity":2,"needs_tools":true,"confidence":0.95}');
    const intent = makeIntent('update the compliance status');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('gpt_oss');
  });

  it('routes web_research to gpt_oss', async () => {
    mockAskGroq.mockResolvedValue('{"pattern":"web_research","complexity":2,"needs_tools":true,"confidence":0.90}');
    const intent = makeIntent('search for pricing data');
    const { plan } = await route(intent, mockDb, 'fake-key', 'fake-model');
    expect(plan.executor).toBe('gpt_oss');
  });

  // ── Composite eligibility ──────────────────────────────────

  describe('composite eligibility', () => {
    it('self_improvement always routes to composite regardless of complexity', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('self_improvement', 1, false, 0.9));
      const { plan } = await route(makeIntent('improve'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('composite');
    });

    it('goal_execution complexity=0 with tools → gpt_oss not composite', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('goal_execution', 0, true, 0.9));
      const { plan } = await route(makeIntent('simple goal'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
    });

    it('goal_execution complexity=3 → composite', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('goal_execution', 3, true, 0.85));
      const { plan } = await route(makeIntent('complex goal'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('composite');
    });

    it('general_knowledge with tools does NOT route to composite', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, true, 0.9));
      const { plan } = await route(makeIntent('lookup something'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('gpt_oss');
      expect(plan.executor).not.toBe('composite');
    });

    it('bizops_read does NOT route to composite', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('bizops_read', 2, true, 0.9));
      const { plan } = await route(makeIntent('check sales'), mockDb, 'k', 'm');
      expect(plan.executor).not.toBe('composite');
    });
  });

  // ── selectDefaultExecutor — verify zone (0.50-0.79) ────────

  describe('selectDefaultExecutor — verify zone edge cases', () => {
    it('confidence exactly at 0.50 enters verify zone (not escalate)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.50));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'general_knowledge',
        complexity: 2,
        needs_tools: false,
        selfReportedConfidence: 0.5,
        tokenConfidence: 0.5,
      });

      const intent = makeIntent('borderline');
      const { plan } = await route(intent, mockDb, 'k', 'm');
      // Should trigger logprobs (verify zone), not escalate
      expect(mockAskGroqWithLogprobs).toHaveBeenCalled();
    });

    it('confidence exactly at 0.80 enters trust zone (no logprobs)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.80));
      await route(makeIntent('confident'), mockDb, 'k', 'm');
      expect(mockAskGroqWithLogprobs).not.toHaveBeenCalled();
    });

    it('confidence at 0.49 enters escalate zone', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.49));
      const { plan } = await route(makeIntent('uncertain'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude');
      expect(getProcedure).not.toHaveBeenCalled();
    });

    it('reclassification adopts new classification from high-confidence logprobs', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'memory_recall',
        complexity: 1,
        needs_tools: false,
        selfReportedConfidence: 0.92,
        tokenConfidence: 0.88,
      });

      const intent = makeIntent('what do you remember');
      const { reclassified } = await route(intent, mockDb, 'k', 'm');
      expect(reclassified).toBe(true);
      expect(intent.classified).toBe('memory_recall');
    });

    it('reclassification rejects invalid pattern from logprobs', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.65));
      mockAskGroqWithLogprobs.mockResolvedValue({
        pattern: 'totally_invalid_pattern',
        complexity: 2,
        needs_tools: false,
        selfReportedConfidence: 0.9,
        tokenConfidence: 0.9,
      });

      const intent = makeIntent('some query');
      const { reclassified } = await route(intent, mockDb, 'k', 'm');
      // Should keep original since pattern is not in getTaskPatterns()
      expect(reclassified).toBe(false);
      expect(intent.classified).toBe('general_knowledge');
    });
  });

  // ── selectDefaultExecutor — high complexity escalation ─────

  describe('selectDefaultExecutor — high complexity', () => {
    it('complexity=3 no-tool → claude_opus even in trust zone', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 3, false, 0.95));
      const { plan } = await route(makeIntent('deep analysis'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude_opus');
    });

    it('complexity=3 with tools → claude_opus', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 3, true, 0.95));
      const { plan } = await route(makeIntent('deep tool task'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude_opus');
    });

    it('complexity=4 → claude_opus', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 4, false, 0.85));
      const { plan } = await route(makeIntent('extremely complex'), mockDb, 'k', 'm');
      expect(plan.executor).toBe('claude_opus');
    });
  });

  // ── Procedural lookup — near miss detection ────────────────

  describe('procedural lookup — near miss', () => {
    it('does not look for near-miss when procedure exists (even immature)', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(getProcedure).mockResolvedValue({
        id: 30,
        task_pattern: 'general_knowledge:mid',
        executor: 'gpt_oss',
        executor_config: '{}',
        success_count: 1,
        fail_count: 0,
        avg_latency_ms: 100,
        avg_cost: 0,
        status: 'learning',
        consecutive_failures: 0,
        refinements: '[]',
      });

      await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(findNearMiss).not.toHaveBeenCalled();
    });

    it('searches for near-miss when no procedure exists', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));
      vi.mocked(getProcedure).mockResolvedValue(null);
      vi.mocked(findNearMiss).mockResolvedValue('general_knowledge:low');

      const { nearMiss } = await route(makeIntent('test'), mockDb, 'k', 'm');
      expect(findNearMiss).toHaveBeenCalled();
      expect(nearMiss).toBe('general_knowledge:low');
    });
  });

  // ── Internal channel — edge cases ──────────────────────────

  describe('internal channel — additional edge cases', () => {
    it('internal channel without classified falls through to normal classification', async () => {
      mockAskGroq.mockResolvedValue(jsonClass('general_knowledge', 2, false, 0.9));

      const intent = makeIntent('unclassified internal', {
        source: { channel: 'internal', threadId: 'int-x' },
        // no classified field
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');

      // Without classified, internal channel does NOT bypass — falls through to Groq
      expect(mockAskGroq).toHaveBeenCalled();
      expect(plan).toBeDefined();
    });

    it('internal trigger with immature procedure falls back to default route', async () => {
      vi.mocked(getProcedure).mockResolvedValue({
        id: 40,
        task_pattern: 'bizops_read:mid',
        executor: 'gpt_oss',
        executor_config: '{}',
        success_count: 2,  // below PROCEDURE_MIN_SUCCESSES (3)
        fail_count: 0,
        avg_latency_ms: 100,
        avg_cost: 0.01,
        status: 'learning',
        consecutive_failures: 0,
        refinements: '[]',
      });

      const intent = makeIntent('check compliance', {
        source: { channel: 'internal', threadId: 'int-y' },
        classified: 'bizops_read',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');

      // Immature procedure should fall through to default route
      expect(plan.executor).toBe('gpt_oss'); // DEFAULT_ROUTES['bizops_read']
      expect(plan.reasoning).toContain('no mature procedure');
    });

    it('internal broken procedure replans to DEFAULT_ROUTES', async () => {
      vi.mocked(getProcedure).mockResolvedValue({
        id: 41,
        task_pattern: 'goal_execution:mid',
        executor: 'composite',
        executor_config: '{}',
        success_count: 5,
        fail_count: 10,
        avg_latency_ms: 5000,
        avg_cost: 0.1,
        status: 'broken',
        consecutive_failures: 5,
        refinements: '[]',
      });

      const intent = makeIntent('run goal', {
        source: { channel: 'internal', threadId: 'int-z' },
        classified: 'goal_execution',
      });
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(plan.executor).toBe('composite'); // DEFAULT_ROUTES['goal_execution']
      expect(plan.reasoning).toContain('broken');
    });
  });

  // ── Classification parsing edge cases ─────────────────────

  describe('classification parsing — edge cases', () => {
    it('strips non-alpha characters from plain text classification', async () => {
      mockAskGroq.mockResolvedValue('  GREETING!!!  ');
      const intent = makeIntent('hi');
      await route(intent, mockDb, 'k', 'm');
      expect(intent.classified).toBe('greeting');
    });

    it('handles JSON with missing fields gracefully', async () => {
      mockAskGroq.mockResolvedValue('{"pattern":"general_knowledge"}');
      const intent = makeIntent('test');
      const { plan } = await route(intent, mockDb, 'k', 'm');
      expect(intent.classified).toBe('general_knowledge');
      // Missing fields default: complexity=2, needsTools=false, confidence=0.8
      expect(intent.complexity).toBe(2);
      expect(intent.needsTools).toBe(false);
      expect(intent.confidence).toBe(0.8);
    });

    it('empty Groq response falls back to general_knowledge', async () => {
      mockAskGroq.mockResolvedValue('');
      const intent = makeIntent('test');
      await route(intent, mockDb, 'k', 'm');
      expect(intent.classified).toBe('general_knowledge');
    });
  });
});
