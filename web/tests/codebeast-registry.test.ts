// Tests for CODEBEAST service binding in MCP registry + edge env mapping

import { describe, it, expect, vi } from 'vitest';

// ─── Mock operator config ─────────────────────────────────────
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
    baseUrl: 'https://your-agent.workers.dev',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

vi.mock('../src/operator/prompt-builder.js', () => ({
  buildGroqSystemPrompt: () => 'You are a test assistant.',
  buildPersonaPreamble: () => 'AEGIS test preamble.',
  buildSystemPrompt: () => 'System prompt.',
}));

// Mock downstream modules pulled in by executor re-exports
vi.mock('../src/groq.js', () => ({
  askGroq: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('../src/claude.js', () => ({
  drainMcpToolHealth: () => new Map(),
  executeClaudeChat: vi.fn().mockResolvedValue({ text: 'ok', cost: 0 }),
  executeClaudeChatStream: vi.fn().mockResolvedValue({ text: 'ok', cost: 0 }),
  buildContext: vi.fn().mockResolvedValue({ systemPrompt: 'sys', tools: [] }),
  handleInProcessTool: vi.fn().mockResolvedValue(null),
  callMcpWithRetry: vi.fn().mockResolvedValue('{}'),
  resolveMcpTool: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/workers-ai-chat.js', () => ({
  executeWorkersAiChat: vi.fn().mockResolvedValue({ text: 'ok', cost: 0 }),
  toOpenAiTools: vi.fn().mockReturnValue([]),
  extractText: vi.fn().mockReturnValue('ok'),
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

// ─── Spy on McpClient/McpRegistry ─────────────────────────────
// We capture construction args to verify registration without mocking internals
const registeredClients: Array<{ prefix: string; rpcPath?: string; fetcher?: unknown }> = [];

vi.mock('../src/mcp-client.js', () => {
  class SpyMcpClient {
    private _prefix: string;
    constructor(config: { prefix: string; rpcPath?: string; fetcher?: unknown }) {
      this._prefix = config.prefix;
      registeredClients.push({
        prefix: config.prefix,
        rpcPath: config.rpcPath,
        fetcher: config.fetcher,
      });
    }
    getPrefix() { return this._prefix; }
  }
  class SpyMcpRegistry {
    private clients: unknown[] = [];
    register(client: unknown) { this.clients.push(client); }
    getClients() { return this.clients; }
    resolveClient() { return null; }
    async listAllTools() { return []; }
  }
  return { McpClient: SpyMcpClient, McpRegistry: SpyMcpRegistry };
});

const { buildMcpRegistry } = await import('../src/kernel/executors/index.js');
const { buildEdgeEnv } = await import('../src/edge-env.js');
import type { EdgeEnv } from '../src/kernel/dispatch.js';
import type { Env } from '../src/types.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeEdgeEnv(overrides?: Partial<EdgeEnv>): EdgeEnv {
  return {
    db: {} as D1Database,
    anthropicApiKey: 'sk-test',
    claudeModel: 'claude-sonnet',
    opusModel: 'claude-opus',
    gptOssModel: '@cf/openai/gpt-oss-120b',
    groqApiKey: 'gsk-test',
    groqModel: 'llama-70b',
    groqResponseModel: 'llama-8b',
    groqGptOssModel: 'openai/gpt-oss-120b',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'biz-tok',
    resendApiKey: 'rs',
    resendApiKeyPersonal: 'rs-p',
    githubToken: 'gh',
    githubRepo: 'test/repo',
    braveApiKey: 'brave',
    notifyEmail: 'test@test.com',
    baseUrl: 'https://test.dev',
    anthropicBaseUrl: 'https://api.anthropic.com',
    groqBaseUrl: 'https://api.groq.com',
    ...overrides,
  };
}

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

// ─── Tests ────────────────────────────────────────────────────

describe('buildMcpRegistry — CODEBEAST', () => {
  it('registers codebeast client when codebeastFetcher is present', () => {
    registeredClients.length = 0;
    const fetcher = {} as Fetcher;
    const env = makeEdgeEnv({ codebeastFetcher: fetcher });

    buildMcpRegistry(env);

    const cb = registeredClients.find(c => c.prefix === 'codebeast');
    expect(cb).toBeDefined();
    expect(cb!.fetcher).toBe(fetcher);
    expect(cb!.rpcPath).toBe('/rpc');
  });

  it('does not register codebeast client when codebeastFetcher is absent', () => {
    registeredClients.length = 0;
    const env = makeEdgeEnv(); // no codebeastFetcher

    buildMcpRegistry(env);

    const cb = registeredClients.find(c => c.prefix === 'codebeast');
    expect(cb).toBeUndefined();
  });

  it('always registers bizops regardless of codebeast presence', () => {
    registeredClients.length = 0;
    const env = makeEdgeEnv({ codebeastFetcher: {} as Fetcher });

    buildMcpRegistry(env);

    const bizops = registeredClients.find(c => c.prefix === 'bizops');
    expect(bizops).toBeDefined();
  });
});

describe('buildEdgeEnv — CODEBEAST mapping', () => {
  it('maps env.CODEBEAST to codebeastFetcher', () => {
    const codebeastBinding = {} as Fetcher;
    const edge = buildEdgeEnv(makeEnv({ CODEBEAST: codebeastBinding }));
    expect(edge.codebeastFetcher).toBe(codebeastBinding);
  });

  it('codebeastFetcher is undefined when CODEBEAST binding is absent', () => {
    const edge = buildEdgeEnv(makeEnv());
    expect(edge.codebeastFetcher).toBeUndefined();
  });
});

describe('EdgeEnv interface', () => {
  it('codebeastFetcher is optional (accepts undefined)', () => {
    // TypeScript compile-time check: EdgeEnv allows codebeastFetcher to be omitted
    const env: EdgeEnv = makeEdgeEnv();
    expect(env.codebeastFetcher).toBeUndefined();
  });

  it('codebeastFetcher accepts a Fetcher value', () => {
    const fetcher = {} as Fetcher;
    const env: EdgeEnv = makeEdgeEnv({ codebeastFetcher: fetcher });
    expect(env.codebeastFetcher).toBe(fetcher);
  });
});
