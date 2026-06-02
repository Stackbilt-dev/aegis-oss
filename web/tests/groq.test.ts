// Groq helper tests — askGroq, askGroqJson, askGroqWithLogprobs, probeConsistency
// Mocks provider factory and fetch() to test API interaction without real calls

import { describe, it, expect, vi, beforeEach } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  createLLMProviderFactory: vi.fn(),
  generateResponse: vi.fn(),
}));

vi.mock('@stackbilt/llm-providers', () => ({
  createLLMProviderFactory: providerMocks.createLLMProviderFactory,
}));

// Mock tokenize/jaccardSimilarity before importing groq.ts
vi.mock('../src/kernel/memory/index.js', () => ({
  tokenize: (text: string) => new Set(text.toLowerCase().split(/\s+/)),
  jaccardSimilarity: (a: Set<string>, b: Set<string>) => {
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 1 : intersection.size / union.size;
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { askGroq, askGroqJson, askGroqWithLogprobs, probeConsistency } = await import('../src/groq.js');

function providerResponse(content: unknown, usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001 }) {
  return {
    message: content,
    usage,
    model: 'llama-test',
    provider: 'groq',
    responseTime: 10,
  };
}

function groqLogprobResponse(content: string, logprobs: Array<{ token: string; logprob: number }>) {
  return new Response(JSON.stringify({
    choices: [{
      message: { content },
      logprobs: { content: logprobs },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('askGroq', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.createLLMProviderFactory.mockReturnValue({ generateResponse: providerMocks.generateResponse });
  });

  it('returns content from Groq API', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse('Hello!'));
    const result = await askGroq('key', 'model', 'system', 'user');
    expect(result).toBe('Hello!');
    expect(providerMocks.generateResponse).toHaveBeenCalledOnce();
  });

  it('sends correct request shape', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse('ok'));
    await askGroq('test-key', 'llama-70b', 'sys prompt', 'user prompt', 'https://custom.api');

    expect(providerMocks.createLLMProviderFactory).toHaveBeenCalledWith({
      groq: { apiKey: 'test-key', baseUrl: 'https://custom.api' },
      fallbackRules: [],
      enableCircuitBreaker: true,
      enableRetries: true,
    });
    expect(providerMocks.generateResponse).toHaveBeenCalledWith({
      model: 'llama-70b',
      systemPrompt: 'sys prompt',
      temperature: 0.3,
      maxTokens: 500,
      messages: [{ role: 'user', content: 'user prompt' }],
    });
  });

  it('throws on API error', async () => {
    providerMocks.generateResponse.mockRejectedValue(new Error('rate limited'));
    await expect(askGroq('key', 'model', 'sys', 'user')).rejects.toThrow('Groq API error: rate limited');
  });

  it('returns empty string when no content', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse(null));
    const result = await askGroq('key', 'model', 'sys', 'user');
    expect(result).toBe('');
  });
});

describe('askGroqJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.createLLMProviderFactory.mockReturnValue({ generateResponse: providerMocks.generateResponse });
  });

  it('parses JSON response', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse(
      '{"name":"test","value":42}',
      { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001 },
    ));
    const { parsed, raw, usage } = await askGroqJson<{ name: string; value: number }>(
      'key', 'model', 'sys', 'user',
    );
    expect(parsed.name).toBe('test');
    expect(parsed.value).toBe(42);
    expect(raw).toBe('{"name":"test","value":42}');
    expect(usage?.prompt_tokens).toBe(100);
  });

  it('handles prefill by concatenating', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse(
      'hello","done":true}',
      { inputTokens: 50, outputTokens: 20, totalTokens: 70, cost: 0.001 },
    ));
    const { parsed } = await askGroqJson<{ greeting: string; done: boolean }>(
      'key', 'model', 'sys', 'user', undefined,
      { prefill: '{"greeting":"' },
    );
    expect(parsed.greeting).toBe('hello');
    expect(parsed.done).toBe(true);
  });

  it('sends json_object response_format', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse('{}'));
    await askGroqJson('key', 'model', 'sys', 'user');
    expect(providerMocks.generateResponse).toHaveBeenCalledWith(expect.objectContaining({
      response_format: { type: 'json_object' },
    }));
  });

  it('throws on API error', async () => {
    providerMocks.generateResponse.mockRejectedValue(new Error('server error'));
    await expect(askGroqJson('key', 'model', 'sys', 'user')).rejects.toThrow('Groq API error: server error');
  });
});

describe('askGroqWithLogprobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.createLLMProviderFactory.mockReturnValue({ generateResponse: providerMocks.generateResponse });
  });

  it('parses classification with token confidence', async () => {
    mockFetch.mockResolvedValue(groqLogprobResponse(
      '{"pattern":"greeting","complexity":0,"needs_tools":false,"confidence":0.99}',
      [
        { token: '{"', logprob: -0.01 },
        { token: 'pattern', logprob: -0.02 },
        { token: '":"', logprob: -0.01 },
        { token: 'greeting', logprob: -0.05 },
      ],
    ));
    const result = await askGroqWithLogprobs('key', 'model', 'sys', 'user');
    expect(result.pattern).toBe('greeting');
    expect(result.complexity).toBe(0);
    expect(result.needs_tools).toBe(false);
    expect(result.selfReportedConfidence).toBe(0.99);
    expect(result.tokenConfidence).toBeGreaterThan(0);
    expect(result.tokenConfidence).toBeLessThanOrEqual(1);
  });

  it('defaults missing fields', async () => {
    mockFetch.mockResolvedValue(groqLogprobResponse('{}', []));
    const result = await askGroqWithLogprobs('key', 'model', 'sys', 'user');
    expect(result.pattern).toBe('general_knowledge');
    expect(result.complexity).toBe(2);
    expect(result.needs_tools).toBe(false);
    expect(result.selfReportedConfidence).toBe(0.5);
    expect(result.tokenConfidence).toBe(0.5); // fallback when no logprobs
  });

  it('sanitizes pattern string', async () => {
    mockFetch.mockResolvedValue(groqLogprobResponse(
      '{"pattern":"Greeting!123"}',
      [{ token: 'x', logprob: -0.1 }],
    ));
    const result = await askGroqWithLogprobs('key', 'model', 'sys', 'user');
    expect(result.pattern).toBe('greeting');
  });
});

describe('probeConsistency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.createLLMProviderFactory.mockReturnValue({ generateResponse: providerMocks.generateResponse });
  });

  it('returns sigma=0 when all responses agree', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse('The answer is 42'));
    const result = await probeConsistency('key', 'model', 'sys', 'user');
    expect(result.sigma).toBe(0);
    expect(result.agreedText).toBe('The answer is 42');
    expect(result.responses).toHaveLength(3);
  });

  it('returns sigma=1.0 when responses completely disagree', async () => {
    providerMocks.generateResponse
      .mockResolvedValueOnce(providerResponse('alpha beta gamma delta epsilon'))
      .mockResolvedValueOnce(providerResponse('one two three four five six seven'))
      .mockResolvedValueOnce(providerResponse('red green blue purple orange yellow'));
    const result = await probeConsistency('key', 'model', 'sys', 'user');
    expect(result.sigma).toBe(1.0);
    expect(result.agreedText).toBeNull();
  });

  it('makes exactly 3 parallel calls', async () => {
    providerMocks.generateResponse.mockResolvedValue(providerResponse('same'));
    await probeConsistency('key', 'model', 'sys', 'user');
    expect(providerMocks.generateResponse).toHaveBeenCalledTimes(3);
  });
});
