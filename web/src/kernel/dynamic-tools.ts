// ─── Dynamic Tools — runtime tool creation + execution ──────
// Tools are prompt templates stored in D1, executed via LLM.
// No eval(). No code execution. Just parameterized prompts.

import { type EdgeEnv } from './dispatch.js';
import type { ToolExecutor, ToolStatus } from '../schema-enums.js';

// ─── Types ──────────────────────────────────────────────────

export interface DynamicTool {
  id: string;
  name: string;
  description: string;
  input_schema: string;
  prompt_template: string;
  executor: string;
  created_by: string;
  status: ToolStatus;
  ttl_days: number | null;
  use_count: number;
  last_used_at: string | null;
  avg_latency_ms: number;
  avg_cost: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface CreateToolOpts {
  name: string;
  description: string;
  input_schema?: string;
  prompt_template: string;
  executor?: ToolExecutor;
  created_by?: string;
  ttl_days?: number;
  status?: 'active' | 'draft';
}

export interface ToolInvocationResult {
  text: string;
  cost: number;
  latency_ms: number;
  executor: string;
}

// ─── Reserved names (cannot conflict with built-in tools) ────

const RESERVED_PREFIXES = ['aegis_', 'mcp_', 'bizops_'];

function isReservedName(name: string): boolean {
  return RESERVED_PREFIXES.some(p => name.startsWith(p));
}

// ─── CRUD ───────────────────────────────────────────────────

export async function createDynamicTool(db: D1Database, opts: CreateToolOpts): Promise<string> {
  if (isReservedName(opts.name)) {
    throw new Error(`Tool name "${opts.name}" conflicts with reserved prefix`);
  }
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(opts.name)) {
    throw new Error('Tool name must be snake_case, 2-49 chars, start with letter');
  }

  const id = crypto.randomUUID();
  const executor = opts.executor ?? 'gpt_oss';
  const status = opts.status ?? 'active';
  const expiresAt = opts.ttl_days
    ? new Date(Date.now() + opts.ttl_days * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await db.prepare(`
    INSERT INTO dynamic_tools (id, name, description, input_schema, prompt_template, executor, created_by, status, ttl_days, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    opts.name,
    opts.description,
    opts.input_schema ?? '{}',
    opts.prompt_template,
    executor,
    opts.created_by ?? 'operator',
    status,
    opts.ttl_days ?? null,
    expiresAt,
  ).run();

  return id;
}

export async function getDynamicTool(db: D1Database, nameOrId: string): Promise<DynamicTool | null> {
  return db.prepare(
    'SELECT * FROM dynamic_tools WHERE (name = ? OR id = ?) AND status != ?'
  ).bind(nameOrId, nameOrId, 'retired').first<DynamicTool>();
}

export async function listDynamicTools(
  db: D1Database,
  opts?: { status?: string; limit?: number },
): Promise<DynamicTool[]> {
  const limit = Math.min(opts?.limit ?? 50, 100);
  if (opts?.status) {
    const result = await db.prepare(
      'SELECT * FROM dynamic_tools WHERE status = ? ORDER BY use_count DESC, created_at DESC LIMIT ?'
    ).bind(opts.status, limit).all<DynamicTool>();
    return result.results;
  }
  const result = await db.prepare(
    "SELECT * FROM dynamic_tools WHERE status IN ('active', 'promoted') ORDER BY use_count DESC, created_at DESC LIMIT ?"
  ).bind(limit).all<DynamicTool>();
  return result.results;
}

export async function updateDynamicTool(
  db: D1Database,
  id: string,
  updates: Partial<Pick<DynamicTool, 'description' | 'prompt_template' | 'executor' | 'input_schema' | 'status'>>,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      binds.push(value);
    }
  }
  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  binds.push(id);

  await db.prepare(
    `UPDATE dynamic_tools SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...binds).run();
}

export async function retireDynamicTool(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    "UPDATE dynamic_tools SET status = 'retired', updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
}

// ─── Prompt Rendering ───────────────────────────────────────

export function renderPrompt(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = inputs[key];
    if (value === undefined) return match; // Leave unresolved placeholders as-is
    return String(value);
  });
}

// ─── Execution ──────────────────────────────────────────────

export async function executeDynamicTool(
  tool: DynamicTool,
  inputs: Record<string, unknown>,
  env: EdgeEnv,
): Promise<ToolInvocationResult> {
  const rendered = renderPrompt(tool.prompt_template, inputs);
  const start = Date.now();
  let text = '';
  let cost = 0;

  if (tool.executor === 'workers_ai' && env.ai) {
    // Workers AI — free inference
    const result = await env.ai.run('@cf/meta/llama-3.1-8b-instruct' as Parameters<Ai['run']>[0], {
      messages: [
        { role: 'system', content: 'You are a focused tool. Answer precisely. No preamble.' },
        { role: 'user', content: rendered },
      ],
      max_tokens: 1024,
    }) as { response?: string };
    text = result.response ?? '';
    cost = 0;
  } else if (tool.executor === 'groq' && env.groqApiKey) {
    // Groq — fast, cheap
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.groqModel ?? 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a focused tool. Answer precisely. No preamble.' },
          { role: 'user', content: rendered },
        ],
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Groq error: ${res.status}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    text = data.choices[0]?.message?.content ?? '';
    cost = 0.001; // ~$0.001 per Groq call
  } else {
    // Default: Workers AI fallback (always available on CF Workers)
    if (env.ai) {
      const result = await env.ai.run('@cf/meta/llama-3.1-8b-instruct' as Parameters<Ai['run']>[0], {
        messages: [
          { role: 'system', content: 'You are a focused tool. Answer precisely. No preamble.' },
          { role: 'user', content: rendered },
        ],
        max_tokens: 1024,
      }) as { response?: string };
      text = result.response ?? '';
      cost = 0;
    } else {
      throw new Error(`Executor "${tool.executor}" not available — no API key or binding`);
    }
  }

  const latencyMs = Date.now() - start;

  // Update usage stats (running average for latency/cost)
  const newCount = tool.use_count + 1;
  const newAvgLatency = ((tool.avg_latency_ms * tool.use_count) + latencyMs) / newCount;
  const newAvgCost = ((tool.avg_cost * tool.use_count) + cost) / newCount;

  await env.db.prepare(`
    UPDATE dynamic_tools
    SET use_count = ?, last_used_at = datetime('now'), avg_latency_ms = ?, avg_cost = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(newCount, newAvgLatency, newAvgCost, tool.id).run();

  return { text, cost, latency_ms: latencyMs, executor: tool.executor };
}

// ─── Lifecycle (GC + Promotion) ─────────────────────────────

const MAX_ACTIVE_TOOLS = 50;
const PROMOTION_THRESHOLD = 20; // use_count to auto-promote
const UNUSED_EXPIRY_DAYS = 30;  // retire if never used after 30d

export async function garbageCollectTools(db: D1Database): Promise<{ expired: number; unused: number }> {
  // 1. Expire tools past TTL
  const expiredResult = await db.prepare(`
    UPDATE dynamic_tools SET status = 'retired', updated_at = datetime('now')
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')
  `).run();

  // 2. Retire tools never used after 30 days
  const unusedResult = await db.prepare(`
    UPDATE dynamic_tools SET status = 'retired', updated_at = datetime('now')
    WHERE status = 'active' AND use_count = 0 AND created_by != 'operator'
      AND created_at < datetime('now', '-${UNUSED_EXPIRY_DAYS} days')
  `).run();

  // 3. Enforce ceiling — retire lowest-use active tools over cap
  const activeCount = await db.prepare(
    "SELECT COUNT(*) as cnt FROM dynamic_tools WHERE status IN ('active', 'promoted')"
  ).first<{ cnt: number }>();

  let overflowRetired = 0;
  if (activeCount && activeCount.cnt > MAX_ACTIVE_TOOLS) {
    const excess = activeCount.cnt - MAX_ACTIVE_TOOLS;
    await db.prepare(`
      UPDATE dynamic_tools SET status = 'retired', updated_at = datetime('now')
      WHERE id IN (
        SELECT id FROM dynamic_tools
        WHERE status = 'active' AND created_by != 'operator'
        ORDER BY use_count ASC, created_at ASC
        LIMIT ?
      )
    `).bind(excess).run();
    overflowRetired = excess;
  }

  return {
    expired: expiredResult.meta.changes,
    unused: unusedResult.meta.changes + overflowRetired,
  };
}

export async function promoteHighUsageTools(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    UPDATE dynamic_tools SET status = 'promoted', updated_at = datetime('now')
    WHERE status = 'active' AND use_count >= ?
  `).bind(PROMOTION_THRESHOLD).run();

  return result.meta.changes;
}

// ─── Tool Definition Formatters (for Claude tool loop) ──────

export function toChatToolDef(tool: DynamicTool): { name: string; description: string; input_schema: Record<string, unknown> } {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(tool.input_schema);
  } catch {
    schema = { type: 'object', properties: {} };
  }
  // Ensure it has a type
  if (!schema.type) schema.type = 'object';

  return {
    name: `dt_${tool.name}`,
    description: `[Dynamic Tool] ${tool.description}`,
    input_schema: schema,
  };
}

// ─── Cache ──────────────────────────────────────────────────

let toolCache: { tools: DynamicTool[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getCachedActiveTools(db: D1Database): Promise<DynamicTool[]> {
  if (toolCache && Date.now() < toolCache.expiresAt) {
    return toolCache.tools;
  }
  const tools = await listDynamicTools(db);
  toolCache = { tools, expiresAt: Date.now() + CACHE_TTL_MS };
  return tools;
}

export function invalidateToolCache(): void {
  toolCache = null;
}
