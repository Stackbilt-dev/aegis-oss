// Edge-native Claude executor — Anthropic Messages API with tool loop
// Replaces the Agent SDK query() for edge deployment

import { McpClient } from './mcp-client.js';
import { budgetConversationHistory } from './kernel/memory/index.js';
import {
  buildContext,
  handleInProcessTool,
  resolveMcpTool,
  getModelCostRates,
  type ClaudeConfig,
  type ContentBlock,
  type Message,
  type ApiResponse,
} from './claude-tools/index.js';

// Re-export for external consumers
export { buildContext, handleInProcessTool, resolveMcpTool, type ClaudeConfig } from './claude-tools/index.js';

// ─── Anthropic SSE streaming ─────────────────────────────────

type StreamBlockState = {
  type: 'text' | 'tool_use';
  text: string;
  id: string;
  name: string;
  inputJson: string;
};

async function* parseAnthropicSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;

        try {
          yield JSON.parse(payload);
        } catch {
          // Malformed chunk — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function callAnthropicStream(
  apiKey: string,
  model: string,
  system: string,
  messages: Message[],
  tools: unknown[],
  onDelta: (text: string) => void,
  baseUrl?: string,
): Promise<{ content: ContentBlock[]; stopReason: string; inputTokens: number; outputTokens: number }> {
  const url = `${baseUrl || 'https://api.anthropic.com'}/v1/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      tools,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic streaming error ${response.status}: ${errText}`);
  }

  if (!response.body) throw new Error('No response body for streaming');

  const content: ContentBlock[] = [];
  let currentBlock: StreamBlockState | null = null;
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of parseAnthropicSSE(response.body)) {
    const type = event.type as string;

    if (type === 'content_block_start') {
      const cb = event.content_block as Record<string, unknown>;
      currentBlock = {
        type: ((cb.type as string) ?? 'text') as 'text' | 'tool_use',
        text: (cb.text as string) ?? '',
        id: (cb.id as string) ?? '',
        name: (cb.name as string) ?? '',
        inputJson: '',
      };
    } else if (type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type === 'text_delta' && currentBlock) {
        currentBlock.text += (delta.text as string) ?? '';
        onDelta((delta.text as string) ?? '');
      } else if (delta.type === 'input_json_delta' && currentBlock) {
        currentBlock.inputJson += (delta.partial_json as string) ?? '';
      }
    } else if (type === 'content_block_stop' && currentBlock) {
      if (currentBlock.type === 'text') {
        content.push({ type: 'text', text: currentBlock.text });
      } else {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(currentBlock.inputJson || '{}'); } catch { /* empty input */ }
        content.push({ type: 'tool_use', id: currentBlock.id, name: currentBlock.name, input });
      }
      currentBlock = null;
    } else if (type === 'message_delta') {
      const md = event.delta as Record<string, unknown> | undefined;
      if (md?.stop_reason) stopReason = md.stop_reason as string;
    } else if (type === 'message_start') {
      const msg = event.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, number> | undefined;
      if (usage) inputTokens = usage.input_tokens ?? 0;
    } else if (type === 'message_delta') {
      const usage = event.usage as Record<string, number> | undefined;
      if (usage) outputTokens = usage.output_tokens ?? 0;
    }
  }

  // Flush any remaining block
  if (currentBlock) {
    if (currentBlock.type === 'text') {
      content.push({ type: 'text', text: currentBlock.text });
    } else {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(currentBlock.inputJson || '{}'); } catch { /* empty input */ }
      content.push({ type: 'tool_use', id: currentBlock.id, name: currentBlock.name, input });
    }
  }

  return { content, stopReason, inputTokens, outputTokens };
}

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

export async function executeClaudeChat(
  config: ClaudeConfig,
  userText: string,
): Promise<{ text: string; cost: number }> {
  config.userQuery = userText;
  const { systemPrompt, tools, conversationHistory } = await buildContext(config, config.roundtableDb);
  const anthropicBase = config.baseUrl || 'https://api.anthropic.com';
  const anthropicConfig = { apiKey: config.apiKey, model: config.model, baseUrl: anthropicBase };

  const messages: Message[] = [
    ...budgetConversationHistory(conversationHistory),
    { role: 'user', content: userText },
  ];

  let totalCost = 0;
  const MAX_TOOL_ROUNDS = 10;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch(`${anthropicBase}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = await response.json<ApiResponse>();

    const rates = getModelCostRates(config.model);
    totalCost += (data.usage.input_tokens * rates.input + data.usage.output_tokens * rates.output) / 1_000_000;

    // Check if we're done (no tool use)
    if (data.stop_reason === 'end_turn' || data.stop_reason === 'max_tokens') {
      const textBlocks = data.content.filter(b => b.type === 'text');
      return {
        text: textBlocks.map(b => b.text ?? '').join('') || '(no response)',
        cost: totalCost,
      };
    }

    // Handle tool use
    if (data.stop_reason === 'tool_use') {
      // Add assistant message with all content blocks
      messages.push({ role: 'assistant', content: data.content });

      // Process each tool use
      const toolResults: ContentBlock[] = [];

      for (const block of data.content) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue;

        let result: string;
        const inProcess = await handleInProcessTool(config.db, block.name, block.input ?? {}, config.githubToken, config.githubRepo, config.braveApiKey, config.roundtableDb, anthropicConfig, config.memoryBinding, config.resendApiKeys);
        if (inProcess !== null) {
          result = inProcess;
        } else {
          const resolved = resolveMcpTool(block.name, config.mcpClient, config.mcpRegistry);
          if (resolved) {
            result = await callMcpWithRetry(resolved.client, resolved.mcpName, block.input ?? {});
          } else {
            result = `Unknown tool: ${block.name}`;
          }
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result } as unknown as ContentBlock);
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const textBlocks = data.content.filter(b => b.type === 'text');
    return { text: textBlocks.map(b => b.text ?? '').join('') || '(no response)', cost: totalCost };
  }

  return { text: '(reached maximum tool rounds)', cost: totalCost };
}

// ─── Streaming variant ───────────────────────────────────────
// Tool-use rounds are non-streaming (fast); only the final end_turn text streams.
// onDelta is buffered per round and flushed only on end_turn, so intermediate
// "I'll check the dashboard..." text never leaks to the UI.

export async function executeClaudeChatStream(
  config: ClaudeConfig,
  userText: string,
  onDelta: (text: string) => void,
): Promise<{ text: string; cost: number }> {
  config.userQuery = userText;
  const { systemPrompt, tools, conversationHistory } = await buildContext(config, config.roundtableDb);
  const anthropicBaseStream = config.baseUrl || 'https://api.anthropic.com';
  const anthropicConfigStream = { apiKey: config.apiKey, model: config.model, baseUrl: anthropicBaseStream };

  const messages: Message[] = [...budgetConversationHistory(conversationHistory), { role: 'user', content: userText }];

  let totalCost = 0;
  const MAX_TOOL_ROUNDS = 10;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // Buffer deltas — only flush to onDelta if this round ends with end_turn
    const roundBuffer: string[] = [];

    const { content, stopReason, inputTokens, outputTokens } = await callAnthropicStream(
      config.apiKey, config.model, systemPrompt, messages, tools,
      (delta) => roundBuffer.push(delta),
      config.baseUrl,
    );

    const rates = getModelCostRates(config.model);
    totalCost += (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

    if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
      // Flush buffered deltas to caller now that we know it's the final round
      for (const delta of roundBuffer) onDelta(delta);
      const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('') || '(no response)';
      return { text, cost: totalCost };
    }

    if (stopReason === 'tool_use') {
      // Discard roundBuffer — tool-use intermediate text stays invisible
      messages.push({ role: 'assistant', content });
      const toolResults: ContentBlock[] = [];

      for (const block of content) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue;
        let result: string;

        const inProcess = await handleInProcessTool(config.db, block.name, block.input ?? {}, config.githubToken, config.githubRepo, config.braveApiKey, config.roundtableDb, anthropicConfigStream, config.memoryBinding);
        if (inProcess !== null) {
          result = inProcess;
        } else {
          const resolved = resolveMcpTool(block.name, config.mcpClient, config.mcpRegistry);
          if (resolved) {
            result = await callMcpWithRetry(resolved.client, resolved.mcpName, block.input ?? {});
          } else {
            result = `Unknown tool: ${block.name}`;
          }
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result } as unknown as ContentBlock);
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason — flush whatever we have
    for (const delta of roundBuffer) onDelta(delta);
    const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('') || '(no response)';
    return { text, cost: totalCost };
  }

  return { text: '(reached maximum tool rounds)', cost: totalCost };
}
