// edge-env tests — buildEdgeEnv binding resolution, AI Gateway routing, defaults

import { describe, it, expect, vi } from 'vitest';

// Mock operator config
vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'AEGIS', possessive: "Kurt's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['StackBilt LLC'], memoryTopics: [] },
    integrations: {
      bizops: { enabled: true, toolPrefix: 'bizops', fallbackUrl: '' },
      github: { enabled: false },
      brave: { enabled: false },
      goals: { enabled: false },
    },
    baseUrl: 'https://your-agent.workers.dev',
  },
  renderTemplate: (s: string) => s,
}));

const { buildEdgeEnv } = await import('../src/edge-env.js');
import type { Env } from '../src/types.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    AEGIS_TOKEN: 'tok',
    OAUTH_PROVIDER: {} as any,
    OAUTH_KV: {} as KVNamespace,
    AEGIS_ENV: 'test',
    ANTHROPIC_API_KEY: 'sk-ant-test',
    CLAUDE_MODEL: '',
    CLAUDE_OPUS_MODEL: '',
    GPT_OSS_MODEL: '',
    GROQ_API_KEY: 'gsk-test',
    GROQ_MODEL: '',
    GROQ_RESPONSE_MODEL: '',
    GROQ_GPT_OSS_MODEL: '',
    AI_GATEWAY_ID: '',
    BIZOPS: {} as Fetcher,
    BIZOPS_TOKEN: 'biz-tok',
    RESEND_API_KEY: 'rs-key',
    RESEND_API_KEY_PERSONAL: 'rs-p-key',
    GITHUB_TOKEN: 'gh-tok',
    GITHUB_REPO: 'Stackbilt-dev/aegis',
    BRAVE_API_KEY: 'brave-key',
    AEGIS_NOTIFY_EMAIL: 'test@test.com',
    AEGIS_BASE_URL: '',
    ROUNDTABLE_DB: {} as D1Database,
    CF_ANALYTICS_TOKEN: '',
    IMG_FORGE: {} as Fetcher,
    IMG_FORGE_SB_SECRET: '',
    MEMORY: {} as any,
    TAROTSCRIPT: {} as Fetcher,
    ELEVENLABS_WEBHOOK_SECRET: '',
    ...overrides,
  } as unknown as Env;
}

describe('buildEdgeEnv', () => {
  it('maps Env bindings to EdgeEnv fields', () => {
    const env = makeEnv();
    const edge = buildEdgeEnv(env);

    expect(edge.db).toBe(env.DB);
    expect(edge.anthropicApiKey).toBe('sk-ant-test');
    expect(edge.groqApiKey).toBe('gsk-test');
    expect(edge.bizopsFetcher).toBe(env.BIZOPS);
    expect(edge.bizopsToken).toBe('biz-tok');
    expect(edge.githubToken).toBe('gh-tok');
    expect(edge.githubRepo).toBe('Stackbilt-dev/aegis');
    expect(edge.braveApiKey).toBe('brave-key');
    expect(edge.resendApiKey).toBe('rs-key');
    expect(edge.resendApiKeyPersonal).toBe('rs-p-key');
    expect(edge.notifyEmail).toBe('test@test.com');
    expect(edge.memoryBinding).toBe(env.MEMORY);
    expect(edge.tarotscriptFetcher).toBe(env.TAROTSCRIPT);
    expect(edge.ai).toBe(env.AI);
  });

  it('applies default model values when env vars are empty', () => {
    const edge = buildEdgeEnv(makeEnv());

    expect(edge.claudeModel).toBe('claude-sonnet-4-6');
    expect(edge.opusModel).toBe('claude-opus-4-6');
    expect(edge.gptOssModel).toBe('@cf/openai/gpt-oss-120b');
    expect(edge.groqModel).toBe('llama-3.3-70b-versatile');
    expect(edge.groqResponseModel).toBe('llama-3.1-8b-instant');
    expect(edge.groqGptOssModel).toBe('openai/gpt-oss-120b');
  });

  it('uses provided model values over defaults', () => {
    const edge = buildEdgeEnv(makeEnv({
      CLAUDE_MODEL: 'claude-custom',
      CLAUDE_OPUS_MODEL: 'opus-custom',
      GPT_OSS_MODEL: 'gpt-custom',
      GROQ_MODEL: 'groq-custom',
      GROQ_RESPONSE_MODEL: 'groq-resp-custom',
      GROQ_GPT_OSS_MODEL: 'groq-gpt-custom',
    }));

    expect(edge.claudeModel).toBe('claude-custom');
    expect(edge.opusModel).toBe('opus-custom');
    expect(edge.gptOssModel).toBe('gpt-custom');
    expect(edge.groqModel).toBe('groq-custom');
    expect(edge.groqResponseModel).toBe('groq-resp-custom');
    expect(edge.groqGptOssModel).toBe('groq-gpt-custom');
  });

  it('uses default Anthropic/Groq base URLs without AI Gateway', () => {
    const edge = buildEdgeEnv(makeEnv());

    expect(edge.anthropicBaseUrl).toBe('https://api.anthropic.com');
    expect(edge.groqBaseUrl).toBe('https://api.groq.com');
    expect(edge.aiGatewayId).toBeUndefined();
  });

  it('routes through AI Gateway when configured', () => {
    const edge = buildEdgeEnv(makeEnv({ AI_GATEWAY_ID: 'my-gateway' }));

    expect(edge.aiGatewayId).toBe('my-gateway');
    expect(edge.anthropicBaseUrl).toContain('gateway.ai.cloudflare.com');
    expect(edge.anthropicBaseUrl).toContain('my-gateway');
    expect(edge.anthropicBaseUrl).toMatch(/\/anthropic$/);
    expect(edge.groqBaseUrl).toContain('gateway.ai.cloudflare.com');
    expect(edge.groqBaseUrl).toContain('my-gateway');
    expect(edge.groqBaseUrl).toMatch(/\/groq$/);
  });

  it('falls back to operatorConfig.baseUrl when AEGIS_BASE_URL is empty', () => {
    const edge = buildEdgeEnv(makeEnv({ AEGIS_BASE_URL: '' }));
    expect(edge.baseUrl).toBe('https://your-agent.workers.dev');
  });

  it('uses AEGIS_BASE_URL when provided', () => {
    const edge = buildEdgeEnv(makeEnv({ AEGIS_BASE_URL: 'https://custom.dev' }));
    expect(edge.baseUrl).toBe('https://custom.dev');
  });

  it('passes ExecutionContext through', () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const edge = buildEdgeEnv(makeEnv(), ctx);
    expect(edge.ctx).toBe(ctx);
  });

  it('sets ctx to undefined when not provided', () => {
    const edge = buildEdgeEnv(makeEnv());
    expect(edge.ctx).toBeUndefined();
  });

  it('maps optional bindings (roundtableDb, imgForge, memory, tarotscript)', () => {
    const roundtableDb = {} as D1Database;
    const imgForge = {} as Fetcher;
    const memory = {} as unknown;
    const tarotscript = {} as Fetcher;

    const edge = buildEdgeEnv(makeEnv({
      ROUNDTABLE_DB: roundtableDb,
      IMG_FORGE: imgForge,
      MEMORY: memory,
      TAROTSCRIPT: tarotscript,
    }));

    expect(edge.roundtableDb).toBe(roundtableDb);
    expect(edge.imgForgeFetcher).toBe(imgForge);
    expect(edge.memoryBinding).toBe(memory);
    expect(edge.tarotscriptFetcher).toBe(tarotscript);
  });

  it('converts empty CF_ANALYTICS_TOKEN to undefined', () => {
    const edge = buildEdgeEnv(makeEnv({ CF_ANALYTICS_TOKEN: '' }));
    expect(edge.cfAnalyticsToken).toBeUndefined();
  });

  it('preserves CF_ANALYTICS_TOKEN when set', () => {
    const edge = buildEdgeEnv(makeEnv({ CF_ANALYTICS_TOKEN: 'cf-tok-123' }));
    expect(edge.cfAnalyticsToken).toBe('cf-tok-123');
  });

  it('converts empty IMG_FORGE_SB_SECRET to undefined', () => {
    const edge = buildEdgeEnv(makeEnv({ IMG_FORGE_SB_SECRET: '' }));
    expect(edge.imgForgeSbSecret).toBeUndefined();
  });

  it('preserves IMG_FORGE_SB_SECRET when set', () => {
    const edge = buildEdgeEnv(makeEnv({ IMG_FORGE_SB_SECRET: 'sb-secret-abc' }));
    expect(edge.imgForgeSbSecret).toBe('sb-secret-abc');
  });

  it('maps MARA fetcher and MARA_TOKEN', () => {
    const maraFetcher = {} as Fetcher;
    const edge = buildEdgeEnv(makeEnv({ MARA: maraFetcher, MARA_TOKEN: 'mara-tok' }));
    expect(edge.maraFetcher).toBe(maraFetcher);
    expect(edge.maraToken).toBe('mara-tok');
  });

  it('AI Gateway URL structure has correct path segments', () => {
    const edge = buildEdgeEnv(makeEnv({ AI_GATEWAY_ID: 'aegis-gw' }));
    // Expected format: https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/{provider}
    const anthropicParts = edge.anthropicBaseUrl.split('/');
    const groqParts = edge.groqBaseUrl.split('/');

    // Last segment should be the provider name
    expect(anthropicParts[anthropicParts.length - 1]).toBe('anthropic');
    expect(groqParts[groqParts.length - 1]).toBe('groq');

    // Gateway ID should be second to last
    expect(anthropicParts[anthropicParts.length - 2]).toBe('aegis-gw');
    expect(groqParts[groqParts.length - 2]).toBe('aegis-gw');
  });

  it('all model defaults are non-empty strings', () => {
    const edge = buildEdgeEnv(makeEnv());
    expect(edge.claudeModel.length).toBeGreaterThan(0);
    expect(edge.opusModel.length).toBeGreaterThan(0);
    expect(edge.gptOssModel.length).toBeGreaterThan(0);
    expect(edge.groqModel.length).toBeGreaterThan(0);
    expect(edge.groqResponseModel.length).toBeGreaterThan(0);
    expect(edge.groqGptOssModel.length).toBeGreaterThan(0);
  });
});
