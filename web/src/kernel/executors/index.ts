import { McpClient, McpRegistry } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import type { Executor } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';
import { executeGptOss } from './workers-ai.js';

// Re-export all executors
export { executeClaude, executeClaudeOpus, executeClaudeStream } from './claude.js';
export { executeGroq } from './groq.js';
export { executeWorkersAi, executeGptOss } from './workers-ai.js';
export { executeDirect, executeCodeTask } from './direct.js';
export { executeTarotScript } from './tarotscript.js';

// ─── MCP Registry ────────────────────────────────────────────

const CF_OBSERVABILITY_MCP_URL = 'https://observability.mcp.cloudflare.com/mcp';

export function buildMcpRegistry(env: EdgeEnv): McpRegistry {
  const registry = new McpRegistry();

  // BizOps MCP — optional integration. Register only when configured.
  if (env.bizopsToken && operatorConfig.integrations.bizops.enabled) {
    registry.register(new McpClient({
      url: operatorConfig.integrations.bizops.fallbackUrl,
      token: env.bizopsToken,
      prefix: 'bizops',
      fetcher: env.bizopsFetcher,
      rpcPath: '/rpc',
    }));
  }

  // Colony OS MARA — Service Binding (Governor MCP, 8 tools)
  if (env.maraToken) {
    registry.register(new McpClient({
      url: 'https://mara.example.com/mara/mcp', // Replace with your MARA endpoint
      token: env.maraToken,
      prefix: 'mara',
      fetcher: env.maraFetcher,
    }));
  }

  // CodeBeast — adversarial code review + fix drain (Service Binding, stateless RPC)
  if (env.codebeastFetcher) {
    registry.register(new McpClient({
      url: 'https://codebeast.example.com', // Replace with your CodeBeast endpoint
      token: '',  // Service Binding — no auth needed
      prefix: 'codebeast',
      fetcher: env.codebeastFetcher,
      rpcPath: '/rpc',
    }));
  }

  // CF Observability — direct fetch (no Service Binding, external MCP server)
  if (env.cfAnalyticsToken && operatorConfig.integrations.cfObservability.enabled) {
    registry.register(new McpClient({
      url: CF_OBSERVABILITY_MCP_URL,
      token: env.cfAnalyticsToken,
      prefix: 'cf_obs',
    }));
  }

  return registry;
}

// ─── Anthropic Failover ─────────────────────────────────────
// When Anthropic API is unavailable (billing, auth, rate limit),
// fall back to GPT-OSS-120B which has tool-calling capability.

export async function executeWithAnthropicFailover(
  executor: 'claude' | 'claude_opus',
  intent: import('../types.js').KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number; meta?: unknown; actualExecutor: Executor }> {
  try {
    const { executeClaude, executeClaudeOpus } = await import('./claude.js');
    const result = executor === 'claude_opus'
      ? await executeClaudeOpus(intent, env)
      : await executeClaude(intent, env);
    return { ...result, actualExecutor: executor };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Anthropic API error') || msg.includes('credit balance')) {
      console.warn(`[dispatch] ${executor} failed, failover → gpt_oss: ${msg.slice(0, 120)}`);
      const result = await executeGptOss(intent, env);
      return { ...result, actualExecutor: 'gpt_oss' };
    }
    throw err;
  }
}
