import { describe, it, expect } from 'vitest';
import { buildLLMProviderFactory } from '../src/kernel/provider-factory.js';
import type { EdgeEnv } from '../src/kernel/dispatch.js';

function makeEdgeEnv(overrides: Partial<EdgeEnv> = {}): EdgeEnv {
  return {
    db: {} as D1Database,
    anthropicApiKey: 'sk-ant-test',
    claudeModel: 'claude-sonnet-4-6',
    opusModel: 'claude-opus-4-7',
    gptOssModel: '@cf/openai/gpt-oss-120b',
    groqApiKey: 'gsk-test',
    groqModel: 'llama-3.3-70b-versatile',
    groqResponseModel: 'llama-3.1-8b-instant',
    groqGptOssModel: 'openai/gpt-oss-120b',
    anthropicBaseUrl: 'https://api.anthropic.com',
    groqBaseUrl: 'https://api.groq.com',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'biz-tok',
    resendApiKey: 'rs-key',
    resendApiKeyPersonal: 'rs-p-key',
    githubToken: 'gh-tok',
    githubRepo: 'ExampleOrg/aegis',
    braveApiKey: 'brave-key',
    notifyEmail: 'test@test.com',
    baseUrl: 'https://your-agent.workers.dev',
    ...overrides,
  } as unknown as EdgeEnv;
}

describe('buildLLMProviderFactory', () => {
  it('constructs without throwing', () => {
    const env = makeEdgeEnv();
    expect(() => buildLLMProviderFactory(env)).not.toThrow();
  });

  it('wires anthropic and groq providers', () => {
    const factory = buildLLMProviderFactory(makeEdgeEnv());
    const available = factory.getAvailableProviders();
    expect(available).toContain('anthropic');
    expect(available).toContain('groq');
  });

  it('wires cloudflare when ai binding is present', () => {
    const factory = buildLLMProviderFactory(makeEdgeEnv({ ai: {} as Ai }));
    expect(factory.getAvailableProviders()).toContain('cloudflare');
  });

  it('omits cloudflare when ai binding is absent', () => {
    const factory = buildLLMProviderFactory(makeEdgeEnv({ ai: undefined }));
    expect(factory.getAvailableProviders()).not.toContain('cloudflare');
  });

  it('returns an anthropic provider instance', () => {
    const factory = buildLLMProviderFactory(makeEdgeEnv());
    const provider = factory.getProvider('anthropic');
    expect(provider).toBeDefined();
    expect(provider?.name).toBe('anthropic');
  });

  it('returns a groq provider instance', () => {
    const factory = buildLLMProviderFactory(makeEdgeEnv());
    const provider = factory.getProvider('groq');
    expect(provider).toBeDefined();
    expect(provider?.name).toBe('groq');
  });
});
