import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  askFreeLlm,
  askWorkersAiOrGroq,
  groqChatCompletionsUrl,
} from '../../src/kernel/scheduled/dreaming/llm.js';

const GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/aegis';

// Production-shaped env: Anthropic is configured, and must never be called.
function makeEnv(aiRun: (model: string, input: unknown) => Promise<unknown>) {
  return {
    groqApiKey: 'gk',
    groqModel: 'llama-3.3-70b-versatile',
    groqResponseModel: 'llama-3.1-8b-instant',
    groqBaseUrl: `${GATEWAY}/groq`,
    anthropicApiKey: 'sk-ant',
    anthropicBaseUrl: `${GATEWAY}/anthropic`,
    ai: { run: vi.fn(aiRun) },
  } as never as Parameters<typeof askWorkersAiOrGroq>[0] & { ai: { run: ReturnType<typeof vi.fn> } };
}

const fetchMock = vi.fn<typeof fetch>();
const urls = () => fetchMock.mock.calls.map(c => String(c[0]));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const groqOk = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('askWorkersAiOrGroq', () => {
  it('returns the Groq answer via the gateway path, without Workers AI', async () => {
    fetchMock.mockResolvedValue(groqOk('from groq'));
    const env = makeEnv(async () => ({ response: 'unused' }));

    await expect(askWorkersAiOrGroq(env, 'sys', 'user')).resolves.toBe('from groq');
    expect(urls()).toEqual([`${GATEWAY}/groq/chat/completions`]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }],
    });
    expect(env.ai.run).not.toHaveBeenCalled();
  });

  it('falls back to Workers AI only — no Anthropic (or second Groq) request', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"Request too large"}}', { status: 413 }));
    const env = makeEnv(async () => ({ response: 'from workers ai' }));

    await expect(askWorkersAiOrGroq(env, 'sys', 'user')).resolves.toBe('from workers ai');
    expect(urls()).toEqual([`${GATEWAY}/groq/chat/completions`]);
    expect(urls().some(u => u.includes('anthropic'))).toBe(false);
    expect(env.ai.run.mock.calls[0][0]).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('names both real causes when both fail — on every call, not a breaker message', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"Request too large"}', { status: 413 }));
    const env = makeEnv(async () => { throw new Error('AiError: 3036: daily free allocation exceeded'); });

    for (let i = 0; i < 3; i++) {
      const err = await askWorkersAiOrGroq(env, 'sys', 'user').catch(e => e as Error);
      expect(err.message).toBe(
        '[dreaming] All free providers failed (prompt 7 chars): '
        + 'groq (llama-3.3-70b-versatile): HTTP 413: {"error":"Request too large"}; '
        + 'workers_ai (@cf/meta/llama-3.3-70b-instruct-fp8-fast): AiError: 3036: daily free allocation exceeded',
      );
    }
    expect(urls().some(u => u.includes('anthropic'))).toBe(false);
  });

  it('truncates long provider error bodies', async () => {
    fetchMock.mockResolvedValue(new Response(`<html>${'x'.repeat(5000)}</html>`, { status: 502 }));
    const env = makeEnv(async () => { throw new Error('y'.repeat(5000)); });

    const err = await askWorkersAiOrGroq(env, 's', 'u').catch(e => e as Error);
    expect(err.message.length).toBeLessThan(900);
    expect(err.message).toContain('workers_ai (');
  });

  it('uses the response model when asked', async () => {
    fetchMock.mockResolvedValue(groqOk('ok'));
    await askWorkersAiOrGroq(makeEnv(async () => ({})), 'sys', 'user', true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('llama-3.1-8b-instant');
  });

  it('reports missing providers', async () => {
    await expect(askWorkersAiOrGroq({} as never, 's', 'u')).rejects.toThrow(/No LLM provider available/);
  });
});

describe('askFreeLlm', () => {
  it('passes the caller model, token cap and label through (conv-facts shape)', async () => {
    fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
    const env = makeEnv(async () => ({ choices: [{ message: { content: 'chat-completions shape' } }] }));

    const out = await askFreeLlm(env, 's', 'u', {
      groqModel: 'llama-3.1-8b-instant',
      workersAiModel: '@cf/meta/llama-3.1-8b-instruct',
      workersAiMaxTokens: 1024,
      label: 'conv-facts',
    });

    expect(out).toBe('chat-completions shape');
    expect(env.ai.run.mock.calls[0][0]).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(env.ai.run.mock.calls[0][1]).toMatchObject({ max_tokens: 1024 });
    expect(String((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/^\[conv-facts\] Groq failed/);
  });
});

describe('groqChatCompletionsUrl', () => {
  it.each([
    [undefined, 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://api.groq.com', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://api.groq.com/', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    [`${GATEWAY}/groq`, `${GATEWAY}/groq/chat/completions`],
  ])('%s -> %s', (base, expected) => {
    expect(groqChatCompletionsUrl(base)).toBe(expected);
  });
});
