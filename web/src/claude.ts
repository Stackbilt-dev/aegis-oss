// Edge-native Claude executor — provider-backed tool loop
// Replaces direct Anthropic transport with @stackbilt/llm-providers.

import { createLLMProviderFactory, type LLMMessage, type Tool, type ToolCall, type ToolResult as LLMToolResult } from '@stackbilt/llm-providers';
import { McpClient } from './mcp-client.js';
import { budgetConversationHistory } from './kernel/memory/index.js';
import { buildLLMProviderFactory } from './kernel/provider-factory.js';
import {
  buildContext,
  handleInProcessTool,
  resolveMcpTool,
  type ClaudeConfig,
} from './claude-tools/index.js';

// Re-export for external consumers
export { buildContext, handleInProcessTool, resolveMcpTool, type ClaudeConfig } from './claude-tools/index.js';

// ─── MCP Tool Health Tracker ─────────────────────────────────
// Tracks per-tool call outcomes so the heartbeat can surface degradation.

export interface McpToolStats {
  calls: number;
  failures: number;     // threw or timed out
  degraded: number;     // returned '(no output)' — data loss without crash
  lastFailure?: string; // error message (sanitised — no tokens/URLs)
  lastDegradedAt?: number;
  lastSuccessAt?: number;
}

const mcpToolHealth = new Map<string, McpToolStats>();

function sanitizeErrorForLog(msg: string): string {
  // Strip anything that looks like a token, key, or full URL with credentials
  return msg
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s)]+/g, '[URL]')
    .slice(0, 200);
}

function recordMcpOutcome(tool: string, outcome: 'success' | 'degraded' | 'failure', errMsg?: string): void {
  const stats = mcpToolHealth.get(tool) ?? { calls: 0, failures: 0, degraded: 0 };
  stats.calls++;
  if (outcome === 'failure') {
    stats.failures++;
    stats.lastFailure = errMsg ? sanitizeErrorForLog(errMsg) : 'unknown';
  } else if (outcome === 'degraded') {
    stats.degraded++;
    stats.lastDegradedAt = Date.now();
  } else {
    stats.lastSuccessAt = Date.now();
  }
  mcpToolHealth.set(tool, stats);
}

/** Snapshot of MCP tool health for heartbeat consumption. Resets counters after read. */
export function drainMcpToolHealth(): Map<string, McpToolStats> {
  const snapshot = new Map(mcpToolHealth);
  mcpToolHealth.clear();
  return snapshot;
}

// ─── MCP retry helper (#3) ───────────────────────────────────
// Wraps mcpClient.callTool with exponential backoff + 15s per-call timeout.
// On final failure returns a structured error string so Claude can reason about it.
export async function callMcpWithRetry(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  retries = 2,
  delayMs = 500,
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        client.callTool(name, args),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`MCP tool timeout after 15s: ${name}`)), 15_000)
        ),
      ]);
      if (result === '(no output)') {
        recordMcpOutcome(name, 'degraded');
      } else {
        recordMcpOutcome(name, 'success');
      }
      return result;
    } catch (err) {
      if (attempt === retries) {
        const msg = err instanceof Error ? err.message : String(err);
        recordMcpOutcome(name, 'failure', msg);
        return `Tool unavailable (${name}): ${msg}`;
      }
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  recordMcpOutcome(name, 'failure', 'exhausted retries');
  return `Tool unavailable: ${name}`;
}

type AnthropicToolDef = {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
};

function toolParameters(inputSchema: unknown): Tool['function']['parameters'] {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    const schema = inputSchema as Record<string, unknown>;
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      return {
        type: 'object',
        properties: schema.properties as Record<string, unknown>,
        required: Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === 'string') : undefined,
      };
    }
  }

  return { type: 'object', properties: {} };
}

function toProviderTools(tools: unknown[]): Tool[] {
  return (tools as AnthropicToolDef[])
    .filter(tool => typeof tool.name === 'string')
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name as string,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: toolParameters(tool.input_schema),
      },
    }));
}

function buildClaudeProviderFactory(config: ClaudeConfig) {
  if (config.edgeEnv) return buildLLMProviderFactory(config.edgeEnv);
  return createLLMProviderFactory({
    anthropic: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    },
    fallbackRules: [],
    enableCircuitBreaker: true,
    enableRetries: true,
  });
}

function initialMessages(conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>, userText: string): LLMMessage[] {
  return [
    ...budgetConversationHistory(conversationHistory).map(message => ({
      role: message.role,
      content: message.content,
    })),
    { role: 'user', content: userText },
  ];
}

function parseToolArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function executeToolCall(config: ClaudeConfig, anthropicConfig: { apiKey: string; model: string; baseUrl: string }, call: ToolCall): Promise<LLMToolResult> {
  const args = parseToolArgs(call);
  const inProcess = await handleInProcessTool(
    config.db,
    call.function.name,
    args,
    config.githubToken,
    config.githubRepo,
    config.braveApiKey,
    config.roundtableDb,
    anthropicConfig,
    config.memoryBinding,
    config.resendApiKeys,
    config.edgeEnv,
  );

  if (inProcess !== null) return { id: call.id, output: inProcess };

  const resolved = resolveMcpTool(call.function.name, config.mcpClient, config.mcpRegistry);
  if (resolved) {
    return { id: call.id, output: await callMcpWithRetry(resolved.client, resolved.mcpName, args) };
  }

  return { id: call.id, output: `Unknown tool: ${call.function.name}` };
}

export async function executeClaudeChat(
  config: ClaudeConfig,
  userText: string,
): Promise<{ text: string; cost: number }> {
  config.userQuery = userText;
  const { systemPrompt, tools, conversationHistory } = await buildContext(config, config.roundtableDb);
  const anthropicConfig = { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl || 'https://api.anthropic.com' };
  const factory = buildClaudeProviderFactory(config);
  const providerTools = toProviderTools(tools);
  const messages = initialMessages(conversationHistory, userText);

  let totalCost = 0;
  const MAX_TOOL_ROUNDS = 10;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await factory.generateResponse({
      messages: [...messages],
      model: config.model,
      systemPrompt,
      tools: providerTools,
      maxTokens: 4096,
    });

    totalCost += result.usage.cost;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { text: result.message || '(no response)', cost: totalCost };
    }

    const toolResults = await Promise.all(result.toolCalls.map(call => executeToolCall(config, anthropicConfig, call)));
    messages.push({ role: 'assistant', content: result.message, toolCalls: result.toolCalls });
    messages.push({ role: 'user', content: '', toolResults });
  }

  return { text: '(reached maximum tool rounds)', cost: totalCost };
}

// ─── Streaming variant ───────────────────────────────────────
// Tool-use rounds use the provider factory. The final answer is emitted as one
// delta so intermediate tool-planning text stays invisible to the UI.

export async function executeClaudeChatStream(
  config: ClaudeConfig,
  userText: string,
  onDelta: (text: string) => void,
): Promise<{ text: string; cost: number }> {
  config.userQuery = userText;
  const { systemPrompt, tools, conversationHistory } = await buildContext(config, config.roundtableDb);
  const anthropicConfig = { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl || 'https://api.anthropic.com' };
  const factory = buildClaudeProviderFactory(config);
  const providerTools = toProviderTools(tools);
  const messages = initialMessages(conversationHistory, userText);

  let totalCost = 0;
  const MAX_TOOL_ROUNDS = 10;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await factory.generateResponse({
      messages: [...messages],
      model: config.model,
      systemPrompt,
      tools: providerTools,
      maxTokens: 4096,
    });

    totalCost += result.usage.cost;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      const text = result.message || '(no response)';
      onDelta(text);
      return { text, cost: totalCost };
    }

    const toolResults = await Promise.all(result.toolCalls.map(call => executeToolCall(config, anthropicConfig, call)));
    messages.push({ role: 'assistant', content: result.message, toolCalls: result.toolCalls });
    messages.push({ role: 'user', content: '', toolResults });
  }

  return { text: '(reached maximum tool rounds)', cost: totalCost };
}
