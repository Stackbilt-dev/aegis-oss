// Claude in-process tool definitions + context builder + delegating dispatcher
// Core module — re-exports domain handlers, owns memory/agenda/session tools
// Extracted from claude-tools.ts for LOC governance

import { McpClient, McpRegistry } from '../mcp-client.js';
import { getConversationHistory, getAgendaContext, getRecentHeartbeatContext, addAgendaItem, resolveAgendaItem, budgetConversationHistory } from '../kernel/memory/index.js';
import { getAllMemoryForContext, recallMemory, recordMemory } from '../kernel/memory-adapter.js';
import { getCognitiveState, formatCognitiveContext } from '../kernel/cognition.js';
import { getAttachedBlocks, assembleBlockContext, seedBlocks } from '../kernel/memory/blocks.js';
import { operatorConfig } from '../operator/index.js';
import { buildSystemPrompt } from '../operator/prompt-builder.js';

import { GITHUB_TOOLS, handleGithubTool } from './github.js';
import { GOAL_TOOLS, handleGoalTool } from './goals.js';
import { ROUNDTABLE_TOOLS, DISPATCH_TOOLS, handleContentTool } from './content.js';
import { WEB_TOOLS, handleWebTool } from './web.js';
import { SEND_EMAIL_TOOL, handleEmailTool } from './email.js';
import { getCachedActiveTools, toChatToolDef, createDynamicTool, getDynamicTool, executeDynamicTool, invalidateToolCache, type CreateToolOpts } from '../kernel/dynamic-tools.js';

// ─── Types ─────────────────────────────────────────────────────

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  baseUrl?: string; // AI Gateway URL or default https://api.anthropic.com
  mcpClient: McpClient;
  mcpRegistry?: McpRegistry;
  db: D1Database;
  channel: string;
  conversationId?: string;
  githubToken?: string;
  githubRepo?: string;
  braveApiKey?: string;
  roundtableDb?: D1Database;
  memoryBinding?: import('../types.js').MemoryServiceBinding;
  resendApiKeys?: { resendApiKey: string; resendApiKeyPersonal: string };
  userQuery?: string;
  edgeEnv?: import('../kernel/dispatch.js').EdgeEnv;
}

// ─── Multi-MCP resolution ────────────────────────────────────

export function resolveMcpTool(
  name: string,
  mcpClient: McpClient,
  mcpRegistry?: McpRegistry,
): { client: McpClient; mcpName: string } | null {
  if (mcpRegistry) return mcpRegistry.resolveClient(name);
  const mcpName = mcpClient.toMcpToolName(name);
  return mcpName ? { client: mcpClient, mcpName } : null;
}

// ─── Shared types ─────────────────────────────────────────────

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ApiResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const SYSTEM_PROMPT = buildSystemPrompt();

export function getModelCostRates(model: string): { input: number; output: number } {
  if (model.includes('opus')) return { input: 15, output: 75 };
  return { input: 3, output: 15 }; // Sonnet default
}

// ─── Core in-process tool definitions (memory, agenda, session) ──

const MEMORY_TOOL = {
  name: 'record_memory_entry',
  description: `Record a durable fact to long-term semantic memory. Call this whenever you learn something about ${operatorConfig.identity.name}, his businesses, projects, or preferences that should persist across sessions. Be specific — record facts, not summaries.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      topic: { type: 'string', description: `Category (e.g., ${operatorConfig.entities.memoryTopics.map(t => `"${t}"`).join(', ')})` },
      fact: { type: 'string', description: 'The specific durable fact to remember' },
      confidence: { type: 'number', description: 'Confidence 0-1' },
      source: { type: 'string', description: 'Where this came from' },
    },
    required: ['topic', 'fact', 'confidence', 'source'],
  },
};

const ADD_AGENDA_TOOL = {
  name: 'add_agenda_item',
  description: `Add a pending action or follow-up to the persistent agenda. Use when a conversation surfaces something that needs to happen — a decision ${operatorConfig.identity.name} is considering, something you offered to do, or an open question needing follow-up. The agenda surfaces in every future conversation.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      item: { type: 'string', description: 'The action item — concise and actionable' },
      context: { type: 'string', description: 'Brief context: why this was added' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level' },
    },
    required: ['item', 'priority'],
  },
};

const RESOLVE_AGENDA_TOOL = {
  name: 'resolve_agenda_item',
  description: 'Mark an agenda item as done or dismissed. Call when an action has been completed or is no longer relevant.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The agenda item ID (shown in your context as #N)' },
      status: { type: 'string', enum: ['done', 'dismissed'], description: 'How it resolved' },
    },
    required: ['id', 'status'],
  },
};

const CC_SESSION_TOOL = {
  name: 'lookup_cc_session',
  description: 'Look up Claude Code session digests. Query by session ID or list recent sessions. These contain structured summaries of what was shipped, decided, and discussed in Claude Code sessions.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Specific session UUID to look up. Omit to list recent sessions.' },
      days: { type: 'number', description: 'Number of days to look back when listing (default 7)' },
    },
  },
};

const CREATE_DYNAMIC_TOOL = {
  name: 'create_dynamic_tool',
  description: 'Create a reusable dynamic tool — a prompt template stored in D1 and executed via LLM. The tool becomes available in future conversations with a dt_ prefix.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Tool name (snake_case, 2-49 chars, no aegis_/mcp_/bizops_ prefix)' },
      description: { type: 'string', description: 'What the tool does' },
      input_schema: { type: 'string', description: 'JSON Schema for inputs (default: empty object)' },
      prompt_template: { type: 'string', description: 'Prompt template with {{variable}} placeholders' },
      executor: { type: 'string', enum: ['gpt_oss', 'workers_ai', 'groq'], description: 'LLM executor (default: gpt_oss)' },
      ttl_days: { type: 'number', description: 'Auto-expire after N days (optional)' },
    },
    required: ['name', 'description', 'prompt_template'],
  },
};

// ─── Context builder ─────────────────────────────────────────

export async function buildContext(config: ClaudeConfig, roundtableDb?: D1Database): Promise<{ systemPrompt: string; tools: unknown[]; conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> }> {
  const { integrations } = operatorConfig;

  // MCP tools — registry (multi-server) or single BizOps client
  let mcpTools: unknown[] = [];
  if (config.mcpRegistry) {
    mcpTools = await config.mcpRegistry.listAllTools();
  } else if (integrations.bizops.enabled) {
    await config.mcpClient.listTools();
    mcpTools = config.mcpClient.toAnthropicTools();
  }

  // Seed blocks on first run (no-op if already seeded)
  await seedBlocks(config.db).catch(err => {
    console.error('[buildContext] seedBlocks failed:', err instanceof Error ? err.message : String(err));
  });

  // Parallel: blocks + memory + agenda + heartbeat + conversation history + cognitive state — 6 reads
  const [blocks, memoryResult, agendaContext, heartbeatContext, rawHistory, cogState] = await Promise.all([
    getAttachedBlocks(config.db, 'claude'),
    config.memoryBinding ? getAllMemoryForContext(config.memoryBinding, config.userQuery) : Promise.resolve({ text: '', ids: [] as string[] }),
    getAgendaContext(config.db),
    getRecentHeartbeatContext(config.db),
    config.conversationId ? getConversationHistory(config.db, config.conversationId, 10) : Promise.resolve([] as Array<{ role: 'user' | 'assistant'; content: string }>),
    getCognitiveState(config.db),
  ]);

  // Batch recall: single UPDATE IN (...) instead of N individual queries
  if (memoryResult.ids.length > 0) {
    if (config.memoryBinding) await recallMemory(config.memoryBinding, memoryResult.ids).catch(() => {});
  }

  // Block context (priority-ordered, always-visible state)
  const blockContext = blocks.length > 0 ? '\n\n' + assembleBlockContext(blocks) : '';

  // Cognitive context — fallback for narratives/pulse when active_context block hasn't been populated yet.
  // Once consolidation refreshes active_context, blocks are canonical and CogState is redundant.
  const hasActiveContextBlock = blocks.some(b => b.id === 'active_context' && b.version > 1);
  const cognitiveContext = (!hasActiveContextBlock && cogState) ? formatCognitiveContext(cogState) : '';
  const systemPrompt = SYSTEM_PROMPT + blockContext + cognitiveContext + heartbeatContext + agendaContext + memoryResult.text;

  // Trim history: exclude trailing user message to avoid duplication
  const conversationHistory = rawHistory.length > 0 && rawHistory[rawHistory.length - 1]?.role === 'user'
    ? rawHistory.slice(0, -1)
    : rawHistory;

  const tools: unknown[] = [
    ...mcpTools,
    MEMORY_TOOL, ADD_AGENDA_TOOL, RESOLVE_AGENDA_TOOL, CC_SESSION_TOOL,
  ];

  if (integrations.github.enabled && config.githubToken && config.githubRepo) {
    tools.push(...GITHUB_TOOLS);
  }
  if (integrations.brave.enabled && config.braveApiKey) {
    tools.push(...WEB_TOOLS);
  }
  if (integrations.goals.enabled) {
    tools.push(...GOAL_TOOLS);
  }
  if (roundtableDb) {
    tools.push(...ROUNDTABLE_TOOLS);
    tools.push(...DISPATCH_TOOLS);
  }
  if (config.resendApiKeys?.resendApiKey) {
    tools.push(SEND_EMAIL_TOOL);
  }

  // Dynamic tools: runtime-created prompt templates (dt_ prefix)
  tools.push(CREATE_DYNAMIC_TOOL);
  try {
    const dynamicTools = await getCachedActiveTools(config.db);
    for (const dt of dynamicTools) {
      tools.push(toChatToolDef(dt));
    }
  } catch {
    // Non-fatal — dynamic tools table may not exist yet
  }

  return { systemPrompt, tools, conversationHistory };
}

// ─── Delegating in-process tool dispatcher ───────────────────

export async function handleInProcessTool(
  db: D1Database,
  name: string,
  input: Record<string, unknown>,
  githubToken?: string,
  githubRepo?: string,
  braveApiKey?: string,
  roundtableDb?: D1Database,
  anthropicConfig?: { apiKey: string; model: string; baseUrl: string },
  memoryBinding?: import('../types.js').MemoryServiceBinding,
  resendApiKeys?: { resendApiKey: string; resendApiKeyPersonal: string },
  edgeEnv?: import('../kernel/dispatch.js').EdgeEnv,
): Promise<string | null> {
  // Core tools: memory, agenda, session
  if (name === 'record_memory_entry') {
    const i = input as { topic: string; fact: string; confidence: number; source: string };
    if (!memoryBinding) {
      console.warn('[tools] record_memory_entry failed: Memory Worker binding unavailable');
      return 'Error: Memory Worker binding unavailable — cannot record memory';
    }
    try {
      const result = await recordMemory(memoryBinding, i.topic, i.fact, i.confidence, i.source);
      // Surface upsert distinction (#437) — callers relying on the string
      // response need to be able to tell that an existing entry was replaced.
      return result.updated
        ? `Updated: "${i.fact}" → ${i.topic} (new id: ${result.fragment_id}, superseded: ${result.superseded_id})`
        : `Recorded: "${i.fact}" → ${i.topic}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools] record_memory_entry write failed:', msg);
      return `Error: Memory write failed — ${msg}`;
    }
  }
  if (name === 'add_agenda_item') {
    const i = input as { item: string; context?: string; priority: 'low' | 'medium' | 'high' };
    const id = await addAgendaItem(db, i.item, i.context, i.priority);
    return `Added agenda item #${id}: "${i.item}" (${i.priority})`;
  }
  if (name === 'resolve_agenda_item') {
    const i = input as { id: number; status: 'done' | 'dismissed' };
    await resolveAgendaItem(db, i.id, i.status);
    return `Resolved agenda item #${i.id} as ${i.status}`;
  }
  if (name === 'lookup_cc_session') {
    const i = input as { id?: string; days?: number };
    if (i.id) {
      const session = await db.prepare('SELECT * FROM cc_sessions WHERE id = ?').bind(i.id).first();
      if (!session) return `No session found with ID ${i.id}`;
      return JSON.stringify(session, null, 2);
    }
    const days = i.days ?? 7;
    const sessions = await db.prepare(
      "SELECT * FROM cc_sessions WHERE created_at > datetime('now', '-' || ? || ' days') ORDER BY created_at DESC LIMIT 20"
    ).bind(days).all();
    if (sessions.results.length === 0) return `No sessions found in the last ${days} days`;
    return JSON.stringify(sessions.results, null, 2);
  }

  // Dynamic tool creation
  if (name === 'create_dynamic_tool') {
    const opts = input as unknown as CreateToolOpts;
    if (!opts.name || !opts.description || !opts.prompt_template) {
      return 'Error: name, description, and prompt_template are required';
    }
    try {
      const id = await createDynamicTool(db, { ...opts, created_by: 'chat' });
      invalidateToolCache();
      return `Created dynamic tool "${opts.name}" (id: ${id}). It will appear as dt_${opts.name} in future conversations.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Dynamic tool invocation (dt_* prefix)
  if (name.startsWith('dt_')) {
    const toolName = name.slice(3);
    const tool = await getDynamicTool(db, toolName);
    if (!tool) return `Error: dynamic tool "${toolName}" not found`;
    if (tool.status === 'draft') return 'Error: tool is in draft status — activate it first';
    if (!edgeEnv) return 'Error: edgeEnv not available for dynamic tool execution';
    try {
      const result = await executeDynamicTool(tool, input, edgeEnv);
      return result.text;
    } catch (err) {
      return `Error executing dynamic tool: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Delegate to domain handlers
  if (githubToken && githubRepo) {
    const result = await handleGithubTool(db, name, input, githubToken, githubRepo);
    if (result !== null) return result;
  }

  const goalResult = await handleGoalTool(db, name, input);
  if (goalResult !== null) return goalResult;

  if (braveApiKey) {
    const webResult = await handleWebTool(name, input, braveApiKey);
    if (webResult !== null) return webResult;
  }

  if (roundtableDb) {
    const contentResult = await handleContentTool(name, input, roundtableDb, db, anthropicConfig, githubToken, githubRepo);
    if (contentResult !== null) return contentResult;
  }

  if (name === 'send_email' && resendApiKeys) {
    return handleEmailTool(name, input, resendApiKeys);
  }

  return null;
}
