import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeEnv } from '../src/kernel/dispatch.js';
import type { DynamicTool } from '../src/kernel/dynamic-tools.js';

const mocks = vi.hoisted(() => ({
  buildLLMProviderFactory: vi.fn(),
  generateResponse: vi.fn(),
}));

vi.mock('../src/kernel/provider-factory.js', () => ({
  buildLLMProviderFactory: mocks.buildLLMProviderFactory,
}));

const { executeDynamicTool } = await import('../src/kernel/dynamic-tools.js');

function makeDb() {
  const run = vi.fn().mockResolvedValue({});
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { db: { prepare } as unknown as D1Database, prepare, bind, run };
}

function makeEnv(overrides?: Partial<EdgeEnv>): EdgeEnv {
  const { db } = makeDb();
  return {
    db,
    anthropicApiKey: 'anthropic-test',
    claudeModel: 'claude-sonnet',
    opusModel: 'claude-opus',
    gptOssModel: '@cf/openai/gpt-oss-120b',
    groqApiKey: 'groq-test',
    groqModel: 'llama-3.3-70b-versatile',
    groqResponseModel: 'llama-3.1-8b-instant',
    groqGptOssModel: 'openai/gpt-oss-120b',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'bizops-test',
    resendApiKey: 'resend-test',
    resendApiKeyPersonal: 'resend-personal-test',
    githubToken: 'github-test',
    githubRepo: 'Stackbilt-dev/aegis-oss',
    braveApiKey: 'brave-test',
    notifyEmail: 'notify@test.dev',
    baseUrl: 'https://aegis.test',
    ai: { run: vi.fn() } as unknown as Ai,
    anthropicBaseUrl: 'https://api.anthropic.com',
    groqBaseUrl: 'https://api.groq.com',
    ...overrides,
  };
}

function makeTool(overrides?: Partial<DynamicTool>): DynamicTool {
  return {
    id: 'tool-1',
    name: 'summarize_thing',
    description: 'Summarize a thing',
    input_schema: '{}',
    prompt_template: 'Summarize {{thing}}',
    executor: 'gpt_oss',
    created_by: 'test',
    status: 'active',
    ttl_days: null,
    use_count: 2,
    last_used_at: null,
    avg_latency_ms: 10,
    avg_cost: 0.001,
    created_at: '2026-06-02T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    expires_at: null,
    ...overrides,
  };
}

describe('executeDynamicTool provider execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildLLMProviderFactory.mockReturnValue({ generateResponse: mocks.generateResponse });
    mocks.generateResponse.mockResolvedValue({
      message: 'provider output',
      usage: { cost: 0.004, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: '@cf/openai/gpt-oss-120b',
      provider: 'cloudflare',
      responseTime: 50,
    });
  });

  it('executes gpt_oss dynamic tools through the provider factory', async () => {
    const db = makeDb();
    const env = makeEnv({ db: db.db });

    const result = await executeDynamicTool(makeTool(), { thing: 'AEGIS' }, env);

    expect(mocks.buildLLMProviderFactory).toHaveBeenCalledWith(env);
    expect(mocks.generateResponse).toHaveBeenCalledWith({
      model: '@cf/openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'You are a focused tool. Answer precisely. No preamble.' },
        { role: 'user', content: 'Summarize AEGIS' },
      ],
      maxTokens: 1024,
      temperature: 0.2,
    });
    expect(db.bind).toHaveBeenCalledWith(3, expect.any(Number), 0.002, 'tool-1');
    expect(result).toEqual({
      text: 'provider output',
      cost: 0.004,
      latency_ms: expect.any(Number),
      executor: 'gpt_oss',
    });
  });

  it('maps workers_ai dynamic tools to the Workers AI provider model', async () => {
    await executeDynamicTool(makeTool({ executor: 'workers_ai' }), { thing: 'AEGIS' }, makeEnv());

    expect(mocks.generateResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: '@cf/meta/llama-3.1-8b-instruct',
    }));
  });

  it('maps groq dynamic tools to the configured Groq model', async () => {
    await executeDynamicTool(makeTool({ executor: 'groq' }), { thing: 'AEGIS' }, makeEnv({ groqModel: 'llama-test' }));

    expect(mocks.generateResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'llama-test',
    }));
  });

  it('fails gpt_oss dynamic tools without an AI binding', async () => {
    await expect(executeDynamicTool(makeTool(), { thing: 'AEGIS' }, makeEnv({ ai: undefined })))
      .rejects.toThrow('Executor "gpt_oss" not available');
  });
});
