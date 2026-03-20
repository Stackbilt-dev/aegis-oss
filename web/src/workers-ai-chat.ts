// Workers AI executor with OpenAI-compatible tool calling
// Uses GPT-OSS-120B (or any tool-capable Workers AI model) for standard queries

import { McpClient, McpRegistry } from './mcp-client.js';
import { handleInProcessTool, callMcpWithRetry, buildContext, resolveMcpTool } from './claude.js';
import { getConversationHistory, budgetConversationHistory } from './kernel/memory/index.js';

// Re-export ClaudeConfig shape so dispatch can construct it
export interface WorkersAiChatConfig {
  ai: Ai;
  model: string; // e.g. '@cf/openai/gpt-oss-120b'
  mcpClient: McpClient;
  mcpRegistry?: McpRegistry;
  db: D1Database;
  channel: string;
  conversationId?: string;
  githubToken?: string;
  githubRepo?: string;
  braveApiKey?: string;
  memoryBinding?: import('./types.js').MemoryServiceBinding;
  resendApiKeys?: { resendApiKey: string; resendApiKeyPersonal: string };
}

// ─── Tool format conversion ─────────────────────────────────

interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

// Responses API output item types
interface ResponsesOutputMessage {
  type: 'message';
  content: Array<{ type: string; text: string }>;
}

interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

type ResponsesOutputItem = ResponsesOutputMessage | ResponsesOutputFunctionCall | { type: string; [k: string]: unknown };

// ai.run() may return standard Workers AI, OpenAI Chat Completions, or Responses API format
export interface AiChatResponse {
  // Standard Workers AI format
  response?: string;
  tool_calls?: ToolCall[];
  // OpenAI Chat Completions format (GPT-OSS-120B actual format)
  choices?: unknown[];
  // Responses API format
  output?: ResponsesOutputItem[];
  // Usage (present in all formats)
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
  [key: string]: unknown;
}

// OpenAI Chat Completions format (what GPT-OSS actually returns via ai.run())
interface ChatCompletionsChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

// Parse text from any response format (standard Workers AI, Chat Completions, or Responses API)
export function extractText(result: AiChatResponse): string | undefined {
  // Standard Workers AI format
  if (result.response) return result.response;
  // OpenAI Chat Completions format (GPT-OSS-120B)
  if (result.choices) {
    const choices = result.choices as ChatCompletionsChoice[];
    if (choices.length > 0 && choices[0].message?.content != null && choices[0].message.content !== '') {
      return choices[0].message.content;
    }
  }
  // Responses API format — find message items
  if (result.output) {
    for (const item of result.output) {
      if (item.type === 'message' && 'content' in item) {
        const msg = item as ResponsesOutputMessage;
        const texts = msg.content.filter(c => c.type === 'output_text' || c.type === 'text').map(c => c.text);
        if (texts.length > 0) return texts.join('');
      }
    }
  }
  return undefined;
}

// Extract tool calls from any response format
export function extractToolCalls(result: AiChatResponse): ToolCall[] {
  // Standard Workers AI format
  if (result.tool_calls && result.tool_calls.length > 0) return result.tool_calls;
  // OpenAI Chat Completions format (GPT-OSS-120B)
  if (result.choices) {
    const choices = result.choices as ChatCompletionsChoice[];
    if (choices.length > 0 && choices[0].message?.tool_calls) {
      return choices[0].message.tool_calls.filter(tc => tc.id && tc.function);
    }
  }
  // Responses API format — find function_call items
  if (result.output) {
    return result.output
      .filter((item): item is ResponsesOutputFunctionCall => item.type === 'function_call')
      .map(item => ({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      }));
  }
  return [];
}

// Extract usage from any format
export function extractUsage(result: AiChatResponse): { prompt_tokens: number; completion_tokens: number } | undefined {
  if (result.usage) {
    const u = result.usage as Record<string, number>;
    return {
      prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    };
  }
  return undefined;
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiTools(anthropicTools: unknown[]): OpenAiFunctionTool[] {
  return (anthropicTools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ─── Cost rates ─────────────────────────────────────────────

const GPT_OSS_RATES = { input: 0.35, output: 0.75 }; // $/MTok

// ─── Main executor ──────────────────────────────────────────

const MAX_TOOL_ROUNDS = 10;

export async function executeWorkersAiChat(
  config: WorkersAiChatConfig,
  userText: string,
): Promise<{ text: string; cost: number }> {
  // Build context reusing Claude's buildContext (needs a ClaudeConfig-shaped object)
  const pseudoConfig = {
    apiKey: '',
    model: config.model,
    mcpClient: config.mcpClient,
    mcpRegistry: config.mcpRegistry,
    db: config.db,
    channel: config.channel,
    conversationId: config.conversationId,
    githubToken: config.githubToken,
    githubRepo: config.githubRepo,
    braveApiKey: config.braveApiKey,
    userQuery: userText,
  };
  const { systemPrompt, tools: anthropicTools } = await buildContext(pseudoConfig);
  const tools = toOpenAiTools(anthropicTools);

  // Load conversation history
  const history = config.conversationId
    ? await getConversationHistory(config.db, config.conversationId, 10)
    : [];
  const priorHistory = history.length > 0 && history[history.length - 1]?.role === 'user'
    ? history.slice(0, -1)
    : history;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...budgetConversationHistory(priorHistory).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: userText },
  ];

  let totalCost = 0;
  const TOOL_ROUNDS = MAX_TOOL_ROUNDS - 2; // Reserve 2 rounds for wrap-up

  // Phase 1: Tool execution rounds (0 to TOOL_ROUNDS-1)
  for (let round = 0; round < TOOL_ROUNDS; round++) {
    const result = await config.ai.run(config.model as Parameters<Ai['run']>[0], {
      messages,
      tools,
      max_tokens: 4096,
      temperature: 0.2,
      top_p: 0.9,
      frequency_penalty: 0.3,
    } as Record<string, unknown>) as AiChatResponse;

    const usage = extractUsage(result);
    if (usage) {
      totalCost += (usage.prompt_tokens * GPT_OSS_RATES.input
        + usage.completion_tokens * GPT_OSS_RATES.output) / 1_000_000;
    }

    const toolCalls = extractToolCalls(result);
    const responseText = extractText(result);

    // No tool calls → model is done
    if (toolCalls.length === 0) {
      return { text: responseText ?? '(no response)', cost: totalCost };
    }

    // Add assistant + tool results to conversation
    messages.push({ role: 'assistant', content: responseText ?? '', tool_calls: toolCalls });

    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* empty args */ }

      let toolResult: string;
      const inProcess = await handleInProcessTool(
        config.db, call.function.name, args,
        config.githubToken, config.githubRepo, config.braveApiKey,
        undefined, undefined, config.memoryBinding,
        config.resendApiKeys,
      );

      if (inProcess !== null) {
        toolResult = inProcess;
      } else {
        const resolved = resolveMcpTool(call.function.name, config.mcpClient, config.mcpRegistry);
        if (resolved) {
          toolResult = await callMcpWithRetry(resolved.client, resolved.mcpName, args);
        } else {
          toolResult = `Unknown tool: ${call.function.name}`;
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
    }
  }

  // Phase 2: Force a text-only summary — NO tools provided, ignore any tool_calls
  // Condense messages to avoid context overflow: strip tool_calls metadata and
  // collapse tool results into a single assistant message. GPT-OSS can choke when
  // the full tool-call conversation is sent without a tools definition.
  const condensed: ChatMessage[] = [messages[0]]; // system prompt
  const toolFindings: string[] = [];
  let lastAssistantText = '';
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && !('tool_call_id' in msg)) {
      condensed.push(msg);
    } else if (msg.role === 'assistant') {
      if (msg.content && msg.content.trim().length > 0) lastAssistantText = msg.content;
      // Collect assistant text, skip tool_calls metadata
      if (msg.content) toolFindings.push(msg.content);
    } else if (msg.role === 'tool') {
      // Truncate long tool results to keep context budget
      const truncated = msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '... [truncated]'
        : msg.content;
      toolFindings.push(truncated);
    }
  }
  // Inject condensed tool findings as a single assistant message
  if (toolFindings.length > 0) {
    const totalBudget = 30000; // ~30K chars ≈ ~10K tokens — safe for summary
    let accumulated = '';
    for (const finding of toolFindings) {
      if (accumulated.length + finding.length > totalBudget) {
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
    const summaryResult = await config.ai.run(config.model as Parameters<Ai['run']>[0], {
      messages: condensed,
      max_tokens: 4096,
      temperature: 0.2,
      top_p: 0.9,
      frequency_penalty: 0.3,
    } as Record<string, unknown>) as AiChatResponse;

    const summaryUsage = extractUsage(summaryResult);
    if (summaryUsage) {
      totalCost += (summaryUsage.prompt_tokens * GPT_OSS_RATES.input
        + summaryUsage.completion_tokens * GPT_OSS_RATES.output) / 1_000_000;
    }

    summaryText = extractText(summaryResult);
    if (!summaryText) {
      console.warn('[workers-ai-chat] Summary phase returned no extractable text. Response keys:', Object.keys(summaryResult), 'Raw:', JSON.stringify(summaryResult).slice(0, 500));
    }
  } catch (err) {
    console.error('[workers-ai-chat] Summary phase AI call failed:', err instanceof Error ? err.message : String(err));
  }

  // Fallback: if summary phase failed, use the last meaningful assistant text
  // from the tool-calling phase rather than returning a useless error string
  if (!summaryText && lastAssistantText.length > 20) {
    console.warn('[workers-ai-chat] Using last assistant text as fallback summary');
    summaryText = lastAssistantText;
  }

  return { text: summaryText ?? '(could not generate summary)', cost: totalCost };
}
