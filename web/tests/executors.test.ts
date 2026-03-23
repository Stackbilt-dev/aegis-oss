// Executor tests — claude, groq, workers-ai, direct
// Mocks all external dependencies to test executor wiring and return shapes

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KernelIntent } from '../src/kernel/types.js';
import type { EdgeEnv } from '../src/kernel/dispatch.js';

// ─── Shared mocks ────────────────────────────────────────────

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'AEGIS', possessive: "Alex's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['ExampleCo LLC'], memoryTopics: [] },
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

// Mock askGroq for groq executor and direct (heartbeat)
const mockAskGroq = vi.fn().mockResolvedValue('{"actionable":false,"severity":"none","summary":"All clear","checks":[]}');
vi.mock('../src/groq.js', () => ({
  askGroq: (...args: unknown[]) => mockAskGroq(...args),
}));

// Mock claude.ts exports used by direct executor
vi.mock('../src/claude.js', () => ({
  drainMcpToolHealth: () => new Map(),
  executeClaudeChat: vi.fn().mockResolvedValue({ text: 'Claude response', cost: 0.01 }),
  executeClaudeChatStream: vi.fn().mockResolvedValue({ text: 'Claude stream response', cost: 0.02 }),
  buildContext: vi.fn().mockResolvedValue({ systemPrompt: 'sys', tools: [] }),
  handleInProcessTool: vi.fn().mockResolvedValue(null),
  callMcpWithRetry: vi.fn().mockResolvedValue('{}'),
  resolveMcpTool: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/workers-ai-chat.js', () => ({
  executeWorkersAiChat: vi.fn().mockResolvedValue({ text: 'Workers AI response', cost: 0.001 }),
  toOpenAiTools: vi.fn().mockReturnValue([]),
  extractText: vi.fn().mockReturnValue('extracted'),
  extractToolCalls: vi.fn().mockReturnValue([]),
  extractUsage: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../src/kernel/memory/index.js', () => ({
  getConversationHistory: vi.fn().mockResolvedValue([]),
  budgetConversationHistory: vi.fn().mockReturnValue([]),
  PROPOSED_ACTION_PREFIX: '[PROPOSED ACTION]',
  tokenize: (t: string) => new Set(t.split(' ')),
  jaccardSimilarity: () => 1,
}));

function makeIntent(text: string, classified?: string): KernelIntent {
  return {
    source: { channel: 'web', threadId: 'test-thread' },
    raw: text,
    classified,
    timestamp: Date.now(),
    costCeiling: 'expensive',
  };
}

function makeEnv(overrides?: Partial<EdgeEnv>): EdgeEnv {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({}),
    }),
  } as unknown as D1Database;

  return {
    db: mockDb,
    anthropicApiKey: 'test-anthropic-key',
    claudeModel: 'claude-sonnet',
    opusModel: 'claude-opus',
    gptOssModel: '@cf/openai/gpt-oss-120b',
    groqApiKey: 'test-groq-key',
    groqModel: 'llama-70b',
    groqResponseModel: 'llama-8b',
    groqGptOssModel: 'openai/gpt-oss-120b',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'test-bizops-token',
    resendApiKey: 'test-resend',
    resendApiKeyPersonal: 'test-resend-personal',
    githubToken: 'test-github',
    githubRepo: 'test/repo',
    braveApiKey: 'test-brave',
    notifyEmail: 'test@test.com',
    baseUrl: 'https://test.dev',
    anthropicBaseUrl: 'https://api.anthropic.com',
    groqBaseUrl: 'https://api.groq.com',
    ai: {
      run: vi.fn().mockResolvedValue({ response: 'AI response' }),
    } as unknown as Ai,
    ...overrides,
  };
}

// ─── Import executors after mocks ─────────────────────────────

const { executeGroq } = await import('../src/kernel/executors/groq.js');
const { executeWorkersAi, executeGptOss } = await import('../src/kernel/executors/workers-ai.js');
const { executeDirect, executeCodeTask } = await import('../src/kernel/executors/direct.js');
const { executeClaude, executeClaudeStream } = await import('../src/kernel/executors/claude.js');

describe('executeGroq', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns text and cost from Groq', async () => {
    mockAskGroq.mockResolvedValue('Hello!');
    const result = await executeGroq(makeIntent('hi'), makeEnv());
    expect(result.text).toBe('Hello!');
    expect(result.cost).toBe(0.0001);
  });

  it('passes correct parameters to askGroq', async () => {
    mockAskGroq.mockResolvedValue('ok');
    const env = makeEnv();
    await executeGroq(makeIntent('test'), env);
    expect(mockAskGroq).toHaveBeenCalledWith(
      'test-groq-key', 'llama-8b', expect.any(String), 'test', 'https://api.groq.com',
    );
  });
});

describe('executeWorkersAi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns text and cost from Workers AI', async () => {
    const env = makeEnv();
    (env.ai!.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: 'Llama says hi' });
    const result = await executeWorkersAi(makeIntent('hello'), env);
    expect(result.text).toBe('Llama says hi');
    expect(result.cost).toBe(0.005);
  });

  it('handles missing response field', async () => {
    const env = makeEnv();
    (env.ai!.run as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const result = await executeWorkersAi(makeIntent('hello'), env);
    expect(result.text).toBe('(no response)');
  });

  it('throws when AI binding unavailable', async () => {
    const env = makeEnv({ ai: undefined });
    await expect(executeWorkersAi(makeIntent('hello'), env))
      .rejects.toThrow('Workers AI binding not available');
  });
});

describe('executeDirect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles heartbeat classification', async () => {
    mockAskGroq.mockResolvedValue('{"actionable":false,"severity":"none","summary":"All systems nominal","checks":[]}');
    const env = makeEnv();
    const result = await executeDirect(makeIntent('heartbeat', 'heartbeat'), env);
    expect(result.text).toBe('All systems nominal');
    expect(result.cost).toBe(0.002);
    expect(result.meta).toBeDefined();
    const meta = result.meta as Record<string, unknown>;
    expect(meta.source).toBe('edge_heartbeat');
  });

  it('returns error meta on heartbeat failure', async () => {
    // Make the MCP client throw by failing askGroq after dashboard call
    const env = makeEnv();
    vi.mocked((await import('../src/mcp-client.js')).McpClient).prototype.callTool = vi.fn().mockRejectedValue(new Error('MCP down'));
    const result = await executeDirect(makeIntent('heartbeat', 'heartbeat'), env);
    expect(result.text).toContain('Heartbeat error');
    expect(result.cost).toBe(0);
  });

  it('throws for unknown direct patterns', async () => {
    await expect(executeDirect(makeIntent('test', 'unknown_pattern'), makeEnv()))
      .rejects.toThrow('No direct handler for pattern');
  });
});

describe('executeCodeTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to Claude when github token available', async () => {
    const env = makeEnv();
    const result = await executeCodeTask(makeIntent('list files', 'code_task'), env);
    expect(result.text).toBe('Claude response');
    expect(result.cost).toBe(0.01);
  });

  it('returns graceful message when no github token', async () => {
    const env = makeEnv({ githubToken: '', githubRepo: '' });
    const result = await executeCodeTask(makeIntent('run code', 'code_task'), env);
    expect(result.text).toContain('can\'t execute code tasks');
    expect(result.cost).toBe(0);
  });
});

describe('executeClaude', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns text and cost from Claude', async () => {
    const result = await executeClaude(makeIntent('explain X'), makeEnv());
    expect(result.text).toBe('Claude response');
    expect(result.cost).toBe(0.01);
  });
});

describe('executeClaudeStream', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns text and cost with streaming', async () => {
    const deltas: string[] = [];
    const result = await executeClaudeStream(makeIntent('explain Y'), makeEnv(), (d) => deltas.push(d));
    expect(result.text).toBe('Claude stream response');
    expect(result.cost).toBe(0.02);
  });
});
