import { describe, it, expect, vi, beforeEach } from 'vitest';

const askGroq = vi.fn();
const generateResponse = vi.fn();
const createLLMProviderFactory = vi.fn(() => ({ generateResponse }));

vi.mock('../../src/groq.js', () => ({ askGroq: (...a: unknown[]) => askGroq(...a) }));
vi.mock('@stackbilt/llm-providers', () => ({
  createLLMProviderFactory: (cfg: unknown) => createLLMProviderFactory(cfg),
}));

const { askWorkersAiOrGroq } = await import('../../src/kernel/scheduled/dreaming/llm.js');

// Env with a paid provider configured, as in production.
const env = {
  groqApiKey: 'gk',
  groqModel: 'llama-3.3-70b-versatile',
  groqResponseModel: 'llama-3.1-8b-instant',
  groqBaseUrl: 'https://gw/groq',
  ai: { run: vi.fn() },
  anthropicApiKey: 'sk-ant',
} as never;

describe('askWorkersAiOrGroq', () => {
  beforeEach(() => {
    askGroq.mockReset();
    generateResponse.mockReset();
    createLLMProviderFactory.mockClear();
  });

  it('returns the Groq answer without touching Workers AI', async () => {
    askGroq.mockResolvedValue('from groq');
    await expect(askWorkersAiOrGroq(env, 'sys', 'user')).resolves.toBe('from groq');
    expect(createLLMProviderFactory).not.toHaveBeenCalled();
  });

  it('falls back to a Cloudflare-only factory — never Anthropic or Groq again', async () => {
    askGroq.mockRejectedValue(new Error('Groq API error: 413 too large'));
    generateResponse.mockResolvedValue({ message: 'from workers ai' });

    await expect(askWorkersAiOrGroq(env, 'sys', 'user')).resolves.toBe('from workers ai');

    const cfg = createLLMProviderFactory.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(cfg).filter(k => ['anthropic', 'groq', 'cerebras', 'openai'].includes(k))).toEqual([]);
    expect(cfg.cloudflare).toEqual({ ai: (env as { ai: unknown }).ai });
    expect(generateResponse.mock.calls[0][0]).toMatchObject({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' });
  });

  it('throws an error naming both provider failures when both fail', async () => {
    askGroq.mockRejectedValue(new Error('Groq API error: 413 too large'));
    generateResponse.mockRejectedValue(new Error('AiError: 3036 daily free allocation exceeded'));

    await expect(askWorkersAiOrGroq(env, 'sys', 'user')).rejects.toThrow(
      /All free providers failed \(prompt 7 chars\): groq \(llama-3\.3-70b-versatile\): Groq API error: 413 too large; workers_ai \(@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast\): AiError: 3036/,
    );
  });

  it('uses the response model when asked', async () => {
    askGroq.mockResolvedValue('ok');
    await askWorkersAiOrGroq(env, 'sys', 'user', true);
    expect(askGroq.mock.calls[0][1]).toBe('llama-3.1-8b-instant');
  });

  it('still reports missing providers', async () => {
    await expect(askWorkersAiOrGroq({} as never, 's', 'u')).rejects.toThrow(/No LLM provider available/);
  });
});
