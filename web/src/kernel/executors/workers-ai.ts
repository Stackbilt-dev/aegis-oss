import type { LLMMessage, ToolResult as LLMToolResult } from '@stackbilt/llm-providers';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import { buildGroqSystemPrompt } from '../../operator/prompt-builder.js';
import { buildContext, handleInProcessTool, callMcpWithRetry, resolveMcpTool } from '../../claude.js';
import { toOpenAiTools } from '../../workers-ai-chat.js';
import { getConversationHistory, budgetConversationHistory } from '../memory/index.js';
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

const GPT_OSS_TOOL_ROUNDS = 8; // 10 max − 2 reserved for summary

export async function executeGptOss(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  if (!env.ai) throw new Error('Workers AI binding not available');

  const factory = buildLLMProviderFactory(env);
  const registry = buildMcpRegistry(env);
  const mcpClient = new McpClient({
    url: operatorConfig.integrations.bizops.fallbackUrl,
    token: env.bizopsToken,
    prefix: 'bizops',
    fetcher: env.bizopsFetcher,
    rpcPath: '/rpc',
  });

  const pseudoConfig = {
    apiKey: '',
    model: env.gptOssModel,
    mcpClient,
    mcpRegistry: registry,
    db: env.db,
    channel: 'web',
    conversationId: intent.source.threadId,
    githubToken: env.githubToken,
    githubRepo: env.githubRepo,
    braveApiKey: env.braveApiKey,
    userQuery: intent.raw,
  };
  const { systemPrompt, tools: anthropicTools } = await buildContext(pseudoConfig);
  // toOpenAiTools output matches factory Tool shape exactly
  const tools = toOpenAiTools(anthropicTools) as Parameters<typeof factory.generateResponse>[0]['tools'];

  const history = intent.source.threadId
    ? await getConversationHistory(env.db, intent.source.threadId, 10)
    : [];
  const priorHistory = history.length > 0 && history[history.length - 1]?.role === 'user'
    ? history.slice(0, -1)
    : history;

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...budgetConversationHistory(priorHistory).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: intent.raw },
  ];

  let totalCost = 0;

  // Phase 1: tool-calling rounds
  for (let round = 0; round < GPT_OSS_TOOL_ROUNDS; round++) {
    const result = await factory.generateResponse({
      messages,
      model: env.gptOssModel,
      tools,
      maxTokens: 4096,
      temperature: 0.2,
      topP: 0.9,
      frequencyPenalty: 0.3,
    });
    totalCost += result.usage.cost;

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { text: result.message || '(no response)', cost: totalCost };
    }

    const toolResults: LLMToolResult[] = [];
    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* empty args */ }

      let output: string;
      const inProcess = await handleInProcessTool(
        env.db, call.function.name, args,
        env.githubToken, env.githubRepo, env.braveApiKey,
        undefined, undefined, env.memoryBinding,
        { resendApiKey: env.resendApiKey, resendApiKeyPersonal: env.resendApiKeyPersonal },
      );

      if (inProcess !== null) {
        output = inProcess;
      } else {
        const resolved = resolveMcpTool(call.function.name, mcpClient, registry);
        if (resolved) {
          output = await callMcpWithRetry(resolved.client, resolved.mcpName, args);
        } else {
          output = `Unknown tool: ${call.function.name}`;
        }
      }
      toolResults.push({ id: call.id, output });
    }

    // Attach tool results to the assistant message; cloudflare provider expands
    // toolResults into separate role:'tool' messages when serializing the next request
    messages.push({
      role: 'assistant',
      content: result.message,
      toolCalls: result.toolCalls,
      toolResults,
    });
  }

  // Phase 2: condense tool history and generate a text-only summary.
  // Condensed messages carry no toolCalls/toolResults, so the factory's
  // usesTools check is false and no tool definitions are sent — preserving
  // the GPT-OSS "no tools in Phase 2" invariant.
  const condensed: LLMMessage[] = [messages[0]]; // system prompt
  const toolFindings: string[] = [];
  let lastAssistantText = '';

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      condensed.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.content?.trim().length) lastAssistantText = msg.content;
      if (msg.content) toolFindings.push(msg.content);
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          const truncated = tr.output.length > 2000
            ? tr.output.slice(0, 2000) + '... [truncated]'
            : tr.output;
          toolFindings.push(truncated);
        }
      }
    }
  }

  if (toolFindings.length > 0) {
    const BUDGET = 30_000;
    let accumulated = '';
    for (const finding of toolFindings) {
      if (accumulated.length + finding.length > BUDGET) {
        accumulated += '\n[... additional findings truncated for summary]';
        break;
      }
      accumulated += '\n' + finding;
    }
    condensed.push({ role: 'assistant', content: `Here is what I gathered:\n${accumulated.trim()}` });
  }
  condensed.push({ role: 'user', content: 'Based on everything you have gathered from the tools above, provide your complete answer now. Summarize your findings clearly and concisely.' });

  let summaryText: string | undefined;
  try {
    const summaryResult = await factory.generateResponse({
      messages: condensed,
      model: env.gptOssModel,
      maxTokens: 4096,
      temperature: 0.2,
      topP: 0.9,
      frequencyPenalty: 0.3,
    });
    totalCost += summaryResult.usage.cost;
    summaryText = summaryResult.message || undefined;
    if (!summaryText) {
      console.warn('[executeGptOss] Summary phase returned no text.');
    }
  } catch (err) {
    console.error('[executeGptOss] Summary phase failed:', err instanceof Error ? err.message : String(err));
  }

  if (!summaryText && lastAssistantText.length > 20) {
    summaryText = lastAssistantText;
  }

  return { text: summaryText ?? '(could not generate summary)', cost: totalCost };
}
