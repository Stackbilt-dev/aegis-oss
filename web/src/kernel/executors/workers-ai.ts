import { executeWorkersAiChat } from '../../workers-ai-chat.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import { buildGroqSystemPrompt } from '../../operator/prompt-builder.js';
import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';
import { buildMcpRegistry } from './index.js';

export async function executeWorkersAi(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  if (!env.ai) throw new Error('Workers AI binding not available');
  const result = await env.ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: buildGroqSystemPrompt() },
      { role: 'user', content: intent.raw },
    ],
  }) as { response?: string };
  return { text: result.response ?? '(no response)', cost: 0.005 };
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
