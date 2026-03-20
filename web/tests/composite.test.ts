// Composite executor tests — orchestration, gather, analyze, synthesize, fallback
// Heavily mocked: tests wiring, DAG validation, and fallback behavior

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KernelIntent } from '../src/kernel/types.js';
import type { EdgeEnv } from '../src/kernel/dispatch.js';

// ─── Mocks ───────────────────────────────────────────────────

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'AEGIS', possessive: "Kurt's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['StackBilt LLC'], memoryTopics: [] },
    integrations: {
      bizops: { enabled: true, toolPrefix: 'bizops', fallbackUrl: 'https://bizops.test' },
      github: { enabled: false },
      brave: { enabled: false },
      goals: { enabled: false },
      cfObservability: { enabled: false },
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

vi.mock('../src/operator/prompt-builder.js', () => ({
  buildGroqSystemPrompt: () => 'You are a test assistant.',
  buildPersonaPreamble: () => 'AEGIS test preamble.',
}));

vi.mock('../src/mcp-client.js', () => {
  class MockMcpClient {
    constructor(_config: unknown) {}
    async callTool(_name: string, _args: unknown) { return '{}'; }
  }
  class MockMcpRegistry {
    register(_client: unknown) {}
    async listAllTools() { return []; }
    resolveClient(_name: string) { return null; }
  }
  return { McpClient: MockMcpClient, McpRegistry: MockMcpRegistry };
});

// Mock buildContext to return minimal tools
vi.mock('../src/claude.js', () => ({
  buildContext: vi.fn().mockResolvedValue({
    systemPrompt: 'Test system prompt',
    tools: [
      { name: 'dashboard_summary', description: 'Get BizOps dashboard', input_schema: { type: 'object', properties: {} } },
    ],
  }),
  handleInProcessTool: vi.fn().mockResolvedValue(null),
  callMcpWithRetry: vi.fn().mockResolvedValue('{"data":"test"}'),
  resolveMcpTool: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/kernel/memory/index.js', () => ({
  getConversationHistory: vi.fn().mockResolvedValue([]),
  budgetConversationHistory: vi.fn().mockReturnValue([]),
  PROPOSED_ACTION_PREFIX: '[PROPOSED ACTION]',
  tokenize: (t: string) => new Set(t.split(' ')),
  jaccardSimilarity: () => 1,
}));

vi.mock('../src/kernel/cognition.js', () => ({
  getCognitiveState: vi.fn().mockResolvedValue(null),
  formatCognitiveContext: vi.fn().mockReturnValue(''),
}));

// Mock askGroqJson for orchestrator + analyzer
const mockAskGroqJson = vi.fn();
vi.mock('../src/groq.js', () => ({
  askGroqJson: (...args: unknown[]) => mockAskGroqJson(...args),
}));

// Mock Workers AI chat for gather fallback and DAG drift fallback
const mockExecuteWorkersAiChat = vi.fn().mockResolvedValue({ text: 'Workers AI fallback', cost: 0.002 });
vi.mock('../src/workers-ai-chat.js', () => ({
  executeWorkersAiChat: (...args: unknown[]) => mockExecuteWorkersAiChat(...args),
  toOpenAiTools: (tools: unknown[]) => (tools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  })),
  extractText: vi.fn().mockReturnValue('gathered data'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractUsage: vi.fn().mockReturnValue({ prompt_tokens: 100, completion_tokens: 50 }),
}));

// Mock global fetch for Claude synthesis
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { executeComposite } = await import('../src/composite.js');

function makeIntent(text: string): KernelIntent {
  return {
    source: { channel: 'web', threadId: 'test-thread' },
    raw: text,
    timestamp: Date.now(),
    costCeiling: 'expensive',
  };
}

function makeEnv(overrides?: Partial<EdgeEnv>): EdgeEnv {
  return {
    db: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({}),
        }),
        first: vi.fn().mockResolvedValue(null),
      }),
    } as unknown as D1Database,
    anthropicApiKey: 'test-key',
    claudeModel: 'claude-sonnet',
    opusModel: 'claude-opus',
    gptOssModel: '@cf/openai/gpt-oss-120b',
    groqApiKey: 'test-groq',
    groqModel: 'llama-70b',
    groqResponseModel: 'llama-8b',
    groqGptOssModel: 'openai/gpt-oss-120b',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'test-token',
    resendApiKey: 'test',
    resendApiKeyPersonal: 'test',
    githubToken: 'test',
    githubRepo: 'test/repo',
    braveApiKey: 'test',
    notifyEmail: 'test@test.com',
    baseUrl: 'https://test.dev',
    anthropicBaseUrl: 'https://api.anthropic.com',
    groqBaseUrl: 'https://api.groq.com',
    ai: {
      run: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'gathered data', tool_calls: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    } as unknown as Ai,
    ...overrides,
  };
}

describe('executeComposite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to gpt_oss when orchestration fails', async () => {
    mockAskGroqJson.mockRejectedValue(new Error('Groq orchestration timeout'));
    const result = await executeComposite(makeIntent('test query'), makeEnv());
    expect(result.text).toBe('Workers AI fallback');
    expect(mockExecuteWorkersAiChat).toHaveBeenCalled();
  });

  it('falls back to gpt_oss when DAG is empty', async () => {
    mockAskGroqJson.mockResolvedValue({
      parsed: { subtasks: [], synthesis_instruction: 'combine' },
      raw: '{}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const result = await executeComposite(makeIntent('test'), makeEnv());
    // Empty DAG → should throw from orchestrate → falls back to gpt_oss
    expect(result.text).toBe('Workers AI fallback');
  });

  it('runs full pipeline: orchestrate → gather → analyze → synthesize', async () => {
    // Phase 1: Orchestrate
    mockAskGroqJson
      // First call: orchestrate
      .mockResolvedValueOnce({
        parsed: {
          subtasks: [
            { id: 'sub_1', description: 'Check compliance status', tools_needed: ['dashboard_summary'], analysis_prompt: 'What items are overdue?' },
            { id: 'sub_2', description: 'Review recent changes', tools_needed: [], analysis_prompt: 'Summarize activity' },
          ],
          synthesis_instruction: 'Combine compliance check and activity review',
        },
        raw: '{}',
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      })
      // Phase 3: Analyze subtask 1
      .mockResolvedValueOnce({
        parsed: { analysis: 'No overdue compliance items found.' },
        raw: '{}',
        usage: { prompt_tokens: 150, completion_tokens: 75 },
      })
      // Phase 3: Analyze subtask 2
      .mockResolvedValueOnce({
        parsed: { analysis: 'Recent activity includes routine operations.' },
        raw: '{}',
        usage: { prompt_tokens: 150, completion_tokens: 75 },
      });

    // Phase 4: Claude synthesis
    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Everything looks good. No overdue items and routine activity.' }],
      usage: { input_tokens: 500, output_tokens: 200 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await executeComposite(makeIntent('check compliance and review activity'), makeEnv());

    expect(result.text).toBe('Everything looks good. No overdue items and routine activity.');
    expect(result.cost).toBeGreaterThan(0);
    expect(result.meta).toBeDefined();
    expect(result.meta!.subtasksPlanned).toBe(2);
    expect(result.meta!.subtasksExecuted).toBe(2);
    expect(result.meta!.partialFailure).toBe(false);
  });

  it('uses Groq fallback when Claude synthesis fails', async () => {
    // Phase 1: Orchestrate — 2 subtasks, second has no tools → goes to full pipeline
    mockAskGroqJson
      .mockResolvedValueOnce({
        parsed: {
          subtasks: [
            { id: 'sub_1', description: 'Analyze data trends', tools_needed: ['dashboard_summary'], analysis_prompt: 'What patterns?' },
            { id: 'sub_2', description: 'Check metrics overview', tools_needed: [], analysis_prompt: 'Overview?' },
          ],
          synthesis_instruction: 'Combine data trends and metrics',
        },
        raw: '{}',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      })
      // Analyze 1
      .mockResolvedValueOnce({
        parsed: { analysis: 'Trend data' },
        raw: '{}',
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      })
      // Analyze 2
      .mockResolvedValueOnce({
        parsed: { analysis: 'Metrics data' },
        raw: '{}',
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      })
      // Groq synthesis fallback
      .mockResolvedValueOnce({
        parsed: { response: 'Groq synthesized result' },
        raw: '{}',
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      });

    // Claude synthesis fails with credit error
    mockFetch.mockResolvedValue(new Response('Your credit balance is too low', { status: 400 }));

    const result = await executeComposite(makeIntent('analyze data and check metrics'), makeEnv());
    expect(result.text).toBe('Groq synthesized result');
  });

  it('respects cost ceiling and reports budget exhaustion', async () => {
    // Orchestrate returns 2 subtasks
    mockAskGroqJson.mockResolvedValueOnce({
      parsed: {
        subtasks: [
          { id: 'sub_1', description: 'Task one', tools_needed: ['dashboard_summary'], analysis_prompt: 'Analyze task 1' },
          { id: 'sub_2', description: 'Task two', tools_needed: ['dashboard_summary'], analysis_prompt: 'Analyze task 2' },
        ],
        synthesis_instruction: 'Combine task one and task two results',
      },
      raw: '{}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })
    // Analyze subtask 1
    .mockResolvedValueOnce({
      parsed: { analysis: 'Analysis 1' }, raw: '{}',
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    })
    // Synthesis fallback (Groq)
    .mockResolvedValueOnce({
      parsed: { response: 'Budget-limited synthesis' }, raw: '{}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    mockFetch.mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Synthesized' }],
      usage: { input_tokens: 300, output_tokens: 100 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    // Set maxCost very low to trigger budget exhaustion
    const result = await executeComposite(makeIntent('do task one and task two'), makeEnv(), undefined, 0.0001);
    expect(result.meta).toBeDefined();
    expect(result.meta!.budgetExhausted).toBe(true);
  });

  it('fast-path: single subtask with tools skips analyze+synthesize', async () => {
    mockAskGroqJson.mockResolvedValueOnce({
      parsed: {
        subtasks: [
          { id: 'sub_1', description: 'Get dashboard data', tools_needed: ['dashboard_summary'], analysis_prompt: 'What does dashboard show?' },
        ],
        synthesis_instruction: 'Return the dashboard data',
      },
      raw: '{}',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const result = await executeComposite(makeIntent('show me the dashboard'), makeEnv());
    expect(result.meta).toBeDefined();
    expect(result.meta!.subtasksPlanned).toBe(1);
    expect(result.meta!.subtasksExecuted).toBe(1);
    // No analyze or synthesize calls — just the orchestrate + 1 gather
    // askGroqJson called only once (for orchestrate)
    expect(mockAskGroqJson).toHaveBeenCalledOnce();
    // No Claude fetch (no synthesis)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
