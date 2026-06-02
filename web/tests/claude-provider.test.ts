import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeConfig } from '../src/claude-tools/index.js';

const mocks = vi.hoisted(() => ({
  buildContext: vi.fn(),
  handleInProcessTool: vi.fn(),
  resolveMcpTool: vi.fn(),
  buildLLMProviderFactory: vi.fn(),
  generateResponse: vi.fn(),
}));

vi.mock('../src/kernel/memory/index.js', () => ({
  budgetConversationHistory: vi.fn((history: Array<{ role: 'user' | 'assistant'; content: string }>) => history),
}));

vi.mock('../src/kernel/provider-factory.js', () => ({
  buildLLMProviderFactory: mocks.buildLLMProviderFactory,
}));

vi.mock('../src/claude-tools/index.js', () => ({
  buildContext: mocks.buildContext,
  handleInProcessTool: mocks.handleInProcessTool,
  resolveMcpTool: mocks.resolveMcpTool,
}));

const { executeClaudeChat, executeClaudeChatStream } = await import('../src/claude.js');

function makeConfig(): ClaudeConfig {
  return {
    apiKey: 'anthropic-test-key',
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'https://anthropic.test',
    mcpClient: {} as ClaudeConfig['mcpClient'],
    db: {} as D1Database,
    channel: 'web',
    conversationId: 'thread-1',
    githubToken: 'gh-test',
    githubRepo: 'Stackbilt-dev/aegis-oss',
    braveApiKey: 'brave-test',
    memoryBinding: {} as ClaudeConfig['memoryBinding'],
    resendApiKeys: { resendApiKey: 'resend-main', resendApiKeyPersonal: 'resend-personal' },
    edgeEnv: { marker: 'edge-env' } as unknown as ClaudeConfig['edgeEnv'],
  };
}

function providerResponse(message: string, cost: number, toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>) {
  return {
    message,
    usage: { cost, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    responseTime: 10,
    toolCalls: toolCalls?.map(call => ({ ...call, type: 'function' as const })),
  };
}

describe('Claude provider executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildContext.mockResolvedValue({
      systemPrompt: 'system prompt',
      tools: [
        {
          name: 'lookup_cc_session',
          description: 'Look up session digests',
          input_schema: {
            type: 'object',
            properties: { days: { type: 'number' } },
            required: ['days'],
          },
        },
      ],
      conversationHistory: [{ role: 'assistant', content: 'prior answer' }],
    });
    mocks.buildLLMProviderFactory.mockReturnValue({ generateResponse: mocks.generateResponse });
    mocks.handleInProcessTool.mockResolvedValue('tool output');
    mocks.resolveMcpTool.mockReturnValue(null);
  });

  it('runs Claude tool rounds through the LLM provider factory', async () => {
    const config = makeConfig();
    mocks.generateResponse
      .mockResolvedValueOnce(providerResponse('', 0.01, [
        { id: 'tool-1', function: { name: 'lookup_cc_session', arguments: '{"days":1}' } },
      ]))
      .mockResolvedValueOnce(providerResponse('final answer', 0.02));

    const result = await executeClaudeChat(config, 'what happened?');

    expect(result).toEqual({ text: 'final answer', cost: 0.03 });
    expect(mocks.buildLLMProviderFactory).toHaveBeenCalledWith(config.edgeEnv);
    expect(mocks.generateResponse).toHaveBeenCalledTimes(2);
    expect(mocks.generateResponse).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'system prompt',
      maxTokens: 4096,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_cc_session',
            description: 'Look up session digests',
            parameters: {
              type: 'object',
              properties: { days: { type: 'number' } },
              required: ['days'],
            },
          },
        },
      ],
      messages: [
        { role: 'assistant', content: 'prior answer' },
        { role: 'user', content: 'what happened?' },
      ],
    }));
    expect(mocks.handleInProcessTool).toHaveBeenCalledWith(
      config.db,
      'lookup_cc_session',
      { days: 1 },
      config.githubToken,
      config.githubRepo,
      config.braveApiKey,
      config.roundtableDb,
      { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl },
      config.memoryBinding,
      config.resendApiKeys,
      config.edgeEnv,
    );
    expect(mocks.generateResponse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [
            {
              id: 'tool-1',
              type: 'function',
              function: { name: 'lookup_cc_session', arguments: '{"days":1}' },
            },
          ],
        }),
        { role: 'user', content: '', toolResults: [{ id: 'tool-1', output: 'tool output' }] },
      ]),
    }));
  });

  it('emits the provider final response through the streaming callback', async () => {
    const deltas: string[] = [];
    mocks.generateResponse.mockResolvedValueOnce(providerResponse('streamed final', 0.04));

    const result = await executeClaudeChatStream(makeConfig(), 'stream this', delta => deltas.push(delta));

    expect(result).toEqual({ text: 'streamed final', cost: 0.04 });
    expect(deltas).toEqual(['streamed final']);
  });
});
