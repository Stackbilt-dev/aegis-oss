// Phase 1: Fact Extraction — analyze conversation threads + CC sessions,
// extract durable facts, routing failures, BizOps drift, preferences.

import type { EdgeEnv } from '../../dispatch.js';
import { recordMemory as recordMemoryAdapter, recordMemoryWithAutoTopic } from '../../memory-adapter.js';
import { validateMemoryWrite } from '../../memory-guardrails.js';
import { McpClient } from '../../../mcp-client.js';
import { operatorConfig } from '../../../operator/index.js';
import { askWorkersAiOrGroq, parseJsonResponse } from './llm.js';

// ─── Types ───────────────────────────────────────────────────

export interface DreamingResult {
  facts?: Array<{ topic: string; fact: string; confidence: number }>;
  routing_failures?: Array<{ thread_id: string; description: string }>;
  bizops_drift?: Array<{ entity: string; field: string; actual_value: string }>;
  preferences?: Array<{ preference: string; evidence: string }>;
  proposed_tasks?: Array<{ title: string; repo: string; prompt: string; category: string; rationale: string }>;
  proposed_tools?: Array<{ name: string; description: string; prompt_template: string; rationale: string }>;
}

// ─── Prompts ─────────────────────────────────────────────────

const DREAMING_SYSTEM = `You are AEGIS's memory consolidation system. You review full conversation threads from the past day and extract durable knowledge.

Your job:
1. Identify NEW FACTS that should be remembered (business decisions, user preferences, architectural changes, pricing changes, entity updates)
2. Identify ROUTING FAILURES where the agent misunderstood the user or gave an irrelevant response
3. Identify STALE FACTS that contradict what's in the current BizOps state
4. Identify USER PREFERENCES revealed through the conversation (communication style, priorities, workflow patterns)

Return ONLY valid JSON (no markdown):
{
  "facts": [
    { "topic": "category", "fact": "specific durable fact with concrete details", "confidence": 0.8 }
  ],
  "routing_failures": [
    { "thread_id": "id", "description": "what went wrong", "user_intent": "what the user actually wanted", "agent_response": "what the agent did instead" }
  ],
  "bizops_drift": [
    { "entity": "name", "field": "what's stale", "current_value": "what BizOps says", "actual_value": "what the conversation revealed" }
  ],
  "preferences": [
    { "preference": "description of user preference", "evidence": "quote or paraphrase from conversation" }
  ],
  "proposed_tasks": [
    { "title": "short task title", "repo": "aegis", "prompt": "detailed instructions for a Claude Code session to execute this task", "category": "docs|tests|research|bugfix|feature|refactor", "rationale": "why this task is needed based on the conversations" }
  ],
  "proposed_tools": [
    { "name": "snake_case_tool_name", "description": "what this reusable tool does", "prompt_template": "prompt with {{variable}} placeholders", "rationale": "why this recurring pattern deserves a tool" }
  ]
}

Rules:
- Only extract facts with concrete details (names, numbers, dates, IDs). Skip vague observations.
- A routing failure is when the user had to redirect or correct the agent.
- BizOps drift is when conversation reveals information newer than BizOps records.
- Return empty arrays if nothing notable happened.
- TOPIC RULES: Use ONLY established topics relevant to your deployment. Do NOT invent new topics. Do NOT use "synthesis_*" or "cross_repo_insights" prefixes. If a fact spans projects, file it under the primary project topic.
- Do NOT record vague "synthesis" observations. Only record concrete, actionable facts with specific details.
- proposed_tasks: up to 3 concrete, well-scoped tasks that would improve the system based on what the conversations reveal. Each must have a clear prompt with specific files/changes. Categories: docs (documentation gaps), tests (missing test coverage), research (investigation needed), bugfix (concrete bugs), feature (new functionality), refactor (code quality). Do NOT propose deploy tasks. Only propose tasks with clear evidence from the conversations.
- proposed_tasks repo should match repos configured in your taskrunner aliases. Use the LOCAL DIRECTORY name, not the GitHub repo name.
- proposed_tasks MUST reference specific files or modules to change. Do NOT propose vague tasks like "add tests for X project" — name the exact source files to test. BizOps project records are metadata, not codebases — never generate tasks about BizOps project entries themselves.
- proposed_tools: up to 2 reusable dynamic tools if you notice the operator repeatedly asking for the same kind of analysis/query/summary. Each tool is a prompt template with {{variable}} placeholders that gets executed via LLM. Only propose if there's clear evidence of a recurring pattern. Name must be snake_case, 2-49 chars.`;

// ─── Thread Loading ──────────────────────────────────────────

export async function fetchConversationThreads(env: EdgeEnv): Promise<string[]> {
  const threads = await env.db.prepare(`
    SELECT DISTINCT conversation_id FROM messages
    WHERE created_at > datetime('now', '-24 hours')
    AND conversation_id IN (
      SELECT conversation_id FROM messages WHERE role = 'user'
      GROUP BY conversation_id HAVING COUNT(*) >= 2
    )
    ORDER BY created_at DESC
    LIMIT 10
  `).all<{ conversation_id: string }>();

  const threadContents: string[] = [];
  for (const { conversation_id } of threads.results) {
    const messages = await env.db.prepare(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 40'
    ).bind(conversation_id).all<{ role: string; content: string }>();

    if (messages.results.length < 2) continue;

    const threadText = messages.results.map(m =>
      `${m.role === 'user' ? 'User' : 'AEGIS'}: ${m.content.slice(0, 1500)}`
    ).join('\n');

    threadContents.push(`--- Thread ${conversation_id} ---\n${threadText}`);
  }

  // Load Claude Code session digests
  const ccSessions = await env.db.prepare(
    "SELECT id, summary, commits, decisions, repos FROM cc_sessions WHERE created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 5"
  ).all<{ id: string; summary: string; commits: string | null; decisions: string | null; repos: string | null }>();

  for (const session of ccSessions.results) {
    const parts = [`Summary: ${session.summary}`];
    if (session.commits) {
      try {
        const commits = JSON.parse(session.commits) as Array<{ hash?: string; message?: string }>;
        if (commits.length > 0) parts.push(`Commits: ${commits.map(c => c.message ?? c.hash).join('; ')}`);
      } catch { /* skip malformed */ }
    }
    if (session.decisions) {
      try {
        const decisions = JSON.parse(session.decisions) as string[];
        if (decisions.length > 0) parts.push(`Decisions: ${decisions.join('; ')}`);
      } catch { /* skip malformed */ }
    }
    threadContents.push(`--- CC Session ${session.id} ---\n${parts.join('\n')}`);
  }

  return threadContents;
}

// ─── Context Gathering ───────────────────────────────────────

async function fetchBizopsContext(env: EdgeEnv): Promise<string> {
  try {
    const client = new McpClient({
      url: operatorConfig.integrations.bizops.fallbackUrl,
      token: env.bizopsToken,
      prefix: 'bizops',
      fetcher: env.bizopsFetcher,
      rpcPath: '/rpc',
    });

    const orgs = await client.callTool('list_organizations', {});
    const projects = await client.callTool('list_projects', {});
    return `\n\nCurrent BizOps state (compare against conversations):\nOrganizations: ${typeof orgs === 'string' ? orgs.slice(0, 2000) : JSON.stringify(orgs).slice(0, 2000)}\nProjects: ${typeof projects === 'string' ? projects.slice(0, 2000) : JSON.stringify(projects).slice(0, 2000)}`;
  } catch {
    return '';
  }
}

async function fetchTaskHealthContext(db: D1Database): Promise<string> {
  try {
    const taskStats = await db.prepare(
      `SELECT category, status, COUNT(*) as c FROM cc_tasks t1
       WHERE t1.completed_at > datetime('now', '-7 days')
       AND NOT (
         t1.status = 'failed'
         AND EXISTS (
           SELECT 1 FROM cc_tasks t2
           WHERE t2.status = 'completed'
           AND t2.repo = t1.repo
           AND t2.title LIKE substr(t1.title, 1, 40) || '%'
           AND t2.completed_at > t1.completed_at
         )
       )
       GROUP BY category, status`
    ).all<{ category: string; status: string; c: number }>();

    if (taskStats.results.length > 0) {
      const byCat: Record<string, { ok: number; total: number }> = {};
      for (const row of taskStats.results) {
        if (!byCat[row.category]) byCat[row.category] = { ok: 0, total: 0 };
        byCat[row.category].total += row.c;
        if (row.status === 'completed') byCat[row.category].ok += row.c;
      }
      const parts = Object.entries(byCat).map(([cat, { ok, total }]) => `${cat} ${ok}/${total} ok`);
      return `\n\nRecent task results (7d): ${parts.join(', ')}`;
    }
  } catch { /* non-fatal */ }
  return '';
}

// ─── Main Fact Extraction ────────────────────────────────────

export async function extractFacts(env: EdgeEnv, threadContents: string[]): Promise<DreamingResult | null> {
  const bizopsContext = await fetchBizopsContext(env);
  const taskHealthContext = await fetchTaskHealthContext(env.db);
  const userPrompt = `${threadContents.join('\n\n').slice(0, 25000)}${bizopsContext}${taskHealthContext}`;

  let rawResponse: string;
  try {
    rawResponse = await askWorkersAiOrGroq(env, DREAMING_SYSTEM, userPrompt);
  } catch (err) {
    console.warn('[dreaming] LLM call failed:', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (!rawResponse) {
    console.warn('[dreaming] LLM returned empty response');
    return null;
  }

  return parseJsonResponse<DreamingResult>(rawResponse);
}

// ─── Fact Processing ─────────────────────────────────────────

export async function processFacts(env: EdgeEnv, result: DreamingResult): Promise<number> {
  let factsRecorded = 0;

  const useAutoTopic = !!env.tarotscriptFetcher;
  for (const fact of (result.facts ?? []).slice(0, 5)) {
    const guard = validateMemoryWrite(fact.topic, fact.fact, { enforceAllowlist: !useAutoTopic });
    if (!guard.allowed) {
      console.log(`[dreaming] Blocked: ${guard.reason}`);
      continue;
    }

    try {
      if (!env.memoryBinding) continue;
      if (useAutoTopic) {
        const res = await recordMemoryWithAutoTopic(env.memoryBinding, env.tarotscriptFetcher!, fact.fact, fact.confidence ?? 0.8, 'dreaming_cycle');
        factsRecorded++;
        console.log(`[dreaming] Fact: [${res.classification.topic}] (${res.classification.confidence}, ${res.classification.source}) ${fact.fact.slice(0, 80)}`);
      } else {
        await recordMemoryAdapter(env.memoryBinding, fact.topic, fact.fact, fact.confidence ?? 0.8, 'dreaming_cycle');
        factsRecorded++;
        console.log(`[dreaming] Fact: [${fact.topic}] ${fact.fact.slice(0, 80)}`);
      }
    } catch (err) {
      console.warn('[dreaming] Failed to record fact:', err instanceof Error ? err.message : String(err));
    }
  }

  // Log routing failures
  for (const failure of (result.routing_failures ?? []).slice(0, 3)) {
    console.warn(`[dreaming] Routing failure detected: ${failure.description}`);
  }

  // Log BizOps drift
  for (const drift of (result.bizops_drift ?? []).slice(0, 3)) {
    console.warn(`[dreaming] BizOps drift: ${drift.entity}.${drift.field} should be "${drift.actual_value}"`);
  }

  // Record preferences
  for (const pref of (result.preferences ?? []).slice(0, 3)) {
    if (!pref.preference || pref.preference.length < 15) continue;
    try {
      if (!env.memoryBinding) continue;
      if (useAutoTopic) {
        const res = await recordMemoryWithAutoTopic(env.memoryBinding, env.tarotscriptFetcher!, pref.preference, 0.85, 'dreaming_cycle');
        console.log(`[dreaming] Preference: [${res.classification.topic}] (${res.classification.confidence}, ${res.classification.source}) ${pref.preference.slice(0, 80)}`);
      } else {
        await recordMemoryAdapter(env.memoryBinding, 'operator_preferences', pref.preference, 0.85, 'dreaming_cycle');
        console.log(`[dreaming] Preference: ${pref.preference.slice(0, 80)}`);
      }
    } catch { /* non-fatal */ }
  }

  console.log(`[dreaming] Extraction complete: ${factsRecorded} facts, ${(result.routing_failures ?? []).length} failures, ${(result.bizops_drift ?? []).length} drift items`);
  return factsRecorded;
}
