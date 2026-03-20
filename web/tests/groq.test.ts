// Groq client tests — askGroq, askGroqJson, askGroqWithLogprobs, probeConsistency
// Mocks fetch() to test API interaction without real calls

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function groqResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  beforeEach(() => vi.clearAllMocks());

  it('returns content from Groq API', async () => {
    mockFetch.mockResolvedValue(groqResponse('Hello!'));
    const result = await askGroq('key', 'model', 'system', 'user');
    expect(result).toBe('Hello!');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('sends correct request shape', async () => {
    mockFetch.mockResolvedValue(groqResponse('ok'));
    await askGroq('test-key', 'llama-70b', 'sys prompt', 'user prompt', 'https://custom.api');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://custom.api/openai/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('llama-70b');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue(new Response('rate limited', { status: 429 }));
    await expect(askGroq('key', 'model', 'sys', 'user')).rejects.toThrow('Groq API error 429');
  });

  it('returns empty string when no content', async () => {
    mockFetch.mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: null } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const result = await askGroq('key', 'model', 'sys', 'user');
    expect(result).toBe('');
  });
});

describe('askGroqJson', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses JSON response', async () => {
    mockFetch.mockResolvedValue(groqResponse(
      '{"name":"test","value":42}',
      { prompt_tokens: 100, completion_tokens: 50 },
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
    mockFetch.mockResolvedValue(groqResponse(
      'hello","done":true}',
      { prompt_tokens: 50, completion_tokens: 20 },
    ));
    const { parsed } = await askGroqJson<{ greeting: string; done: boolean }>(
      'key', 'model', 'sys', 'user', undefined,
      { prefill: '{"greeting":"' },
    );
    expect(parsed.greeting).toBe('hello');
    expect(parsed.done).toBe(true);
  });

  it('sends json_object response_format', async () => {
    mockFetch.mockResolvedValue(groqResponse('{}'));
    await askGroqJson('key', 'model', 'sys', 'user');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue(new Response('server error', { status: 500 }));
    await expect(askGroqJson('key', 'model', 'sys', 'user')).rejects.toThrow('Groq API error 500');
  });
});

describe('askGroqWithLogprobs', () => {
  beforeEach(() => vi.clearAllMocks());

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
  beforeEach(() => vi.clearAllMocks());

  it('returns sigma=0 when all responses agree', async () => {
    // Each call needs a fresh Response (body can only be read once)
    mockFetch.mockImplementation(() => Promise.resolve(groqResponse('The answer is 42')));
    const result = await probeConsistency('key', 'model', 'sys', 'user');
    expect(result.sigma).toBe(0);
    expect(result.agreedText).toBe('The answer is 42');
    expect(result.responses).toHaveLength(3);
  });

  it('returns sigma=1.0 when responses completely disagree', async () => {
    mockFetch
      .mockResolvedValueOnce(groqResponse('alpha beta gamma delta epsilon'))
      .mockResolvedValueOnce(groqResponse('one two three four five six seven'))
      .mockResolvedValueOnce(groqResponse('red green blue purple orange yellow'));
    const result = await probeConsistency('key', 'model', 'sys', 'user');
    expect(result.sigma).toBe(1.0);
    expect(result.agreedText).toBeNull();
  });

  it('makes exactly 3 parallel calls', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(groqResponse('same')));
    await probeConsistency('key', 'model', 'sys', 'user');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
