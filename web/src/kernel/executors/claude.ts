import { executeClaudeChat, executeClaudeChatStream } from '../../claude.js';
import { McpClient, McpRegistry } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';
import { buildMcpRegistry } from './index.js';

function buildClaudeConfig(env: EdgeEnv, intent: KernelIntent, model: string, registry: McpRegistry) {
  // BizOps MCP client — optional, only created when token is available
  const mcpClient = env.bizopsToken ? new McpClient({
    url: operatorConfig.integrations.bizops.fallbackUrl,
    token: env.bizopsToken,
    prefix: 'bizops',
    fetcher: env.bizopsFetcher,
    rpcPath: '/rpc',
  }) : undefined;

  return {
    apiKey: env.anthropicApiKey,
    model,
    baseUrl: env.anthropicBaseUrl,
    mcpClient: mcpClient as McpClient, // type assertion — handled downstream
    mcpRegistry: registry,
    db: env.db,
    channel: 'web' as const,
    conversationId: intent.source.threadId,
    githubToken: env.githubToken,
    githubRepo: env.githubRepo,
    braveApiKey: env.braveApiKey,
    roundtableDb: env.roundtableDb,
    memoryBinding: env.memoryBinding,
  };
}

export async function executeClaude(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  const registry = buildMcpRegistry(env);
  return executeClaudeChat(buildClaudeConfig(env, intent, env.claudeModel, registry), intent.raw);
}

export async function executeClaudeOpus(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  const registry = buildMcpRegistry(env);
  return executeClaudeChat(buildClaudeConfig(env, intent, env.opusModel, registry), intent.raw);
}

export async function executeClaudeStream(
  intent: KernelIntent,
  env: EdgeEnv,
  onDelta: (text: string) => void,
): Promise<{ text: string; cost: number }> {
  const registry = buildMcpRegistry(env);
  // BizOps MCP client — optional, only created when token is available
  const mcpClient = env.bizopsToken ? new McpClient({
    url: operatorConfig.integrations.bizops.fallbackUrl,
    token: env.bizopsToken,
    prefix: 'bizops',
    fetcher: env.bizopsFetcher,
    rpcPath: '/rpc',
  }) : undefined;

  return executeClaudeChatStream(
    {
      ...buildClaudeConfig(env, intent, intent.classified === 'claude_opus' ? env.opusModel : env.claudeModel, registry),
      mcpClient: mcpClient as McpClient, // type assertion — handled downstream
      resendApiKeys: { resendApiKey: env.resendApiKey, resendApiKeyPersonal: env.resendApiKeyPersonal },
    },
    intent.raw,
    onDelta,
  );
}
