import { executeWorkersAiChat } from '../../workers-ai-chat.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import { buildGroqSystemPrompt } from '../../operator/prompt-builder.js';
import { buildLLMProviderFactory } from '../provider-factory.js';
import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';
import { buildMcpRegistry } from './index.js';

export async function executeWorkersAi(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  if (!env.ai) throw new Error('Workers AI binding not available');
  const factory = buildLLMProviderFactory(env);
  const result = await factory.generateResponse({
    messages: [{ role: 'user', content: intent.raw }],
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    systemPrompt: buildGroqSystemPrompt(),
  });
  return { text: result.message || '(no response)', cost: result.usage.cost };
}

export async function executeGptOss(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  if (!env.ai) throw new Error('Workers AI binding not available');
  const registry = buildMcpRegistry(env);
  const mcpClient = new McpClient({
    url: operatorConfig.integrations.bizops.fallbackUrl,
    token: env.bizopsToken,
    prefix: 'bizops',
    fetcher: env.bizopsFetcher,
    rpcPath: '/rpc',
  });

  return executeWorkersAiChat(
    {
      ai: env.ai,
      model: env.gptOssModel,
      mcpClient,
      mcpRegistry: registry,
      db: env.db,
      channel: 'web',
      conversationId: intent.source.threadId,
      githubToken: env.githubToken,
      githubRepo: env.githubRepo,
      braveApiKey: env.braveApiKey,
      memoryBinding: env.memoryBinding,
      resendApiKeys: { resendApiKey: env.resendApiKey, resendApiKeyPersonal: env.resendApiKeyPersonal },
    },
    intent.raw,
  );
}
