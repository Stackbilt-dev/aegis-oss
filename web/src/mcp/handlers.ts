import { createIntent, dispatch, type EdgeEnv } from '../kernel/dispatch.js';
import { getAllProcedures, getActiveAgendaItems, addAgendaItem, resolveAgendaItem, addGoal, updateGoalStatus, getActiveGoals } from '../kernel/memory/index.js';
import { getMemoryEntries, recordMemory } from '../kernel/memory-adapter.js';
import { collectContractAlerts, parseTaskPreflight } from '../task-intelligence.js';
import { generateDecisionDoc } from '../decision-docs.js';
import type { MessageMetadata } from '../types.js';

// ─── Tool Handler Types ──────────────────────────────────────

export type McpContent = Array<{ type: 'text'; text: string }>;
export type ToolResult = { content: McpContent; isError?: boolean };

// ─── Tool Handlers ──────────────────────────────────────────

export async function toolAegisChat(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const message = args.message as string;
  if (!message?.trim()) {
    return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true };
  }

  const conversationId = (args.conversation_id as string) || crypto.randomUUID();

  // Persist user message
  await env.db.prepare('INSERT OR IGNORE INTO conversations (id, title) VALUES (?, ?)').bind(conversationId, message.slice(0, 100)).run();
  await env.db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), conversationId, 'user', message.trim()).run();

  // Full kernel dispatch
  const intent = createIntent(conversationId, message.trim());
  const result = await dispatch(intent, env);

  // Persist assistant message
  const metadata: MessageMetadata = {
    classification: result.classification,
    executor: result.executor,
    procHit: result.procedureHit,
    latencyMs: result.latency_ms,
    cost: result.cost,
  };
  await env.db.prepare('INSERT INTO messages (id, conversation_id, role, content, metadata) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), conversationId, 'assistant', result.text, JSON.stringify(metadata)).run();
  await env.db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").bind(conversationId).run();

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        conversation_id: conversationId,
        response: result.text,
        classification: result.classification,
        executor: result.executor,
        cost: result.cost,
        latency_ms: result.latency_ms,
        procedure_hit: result.procedureHit,
      }, null, 2),
    }],
  };
}

// Internal conversation prefixes that should not be exposed via MCP
const INTERNAL_CONVERSATION_PREFIXES = ['goal-', 'scheduled', 'security-', 'dreaming', 'mara-', 'colony-'];

function isInternalConversation(id: string, title?: string): boolean {
  if (INTERNAL_CONVERSATION_PREFIXES.some(p => id.startsWith(p))) return true;
  if (title && INTERNAL_CONVERSATION_PREFIXES.some(p => title.toLowerCase().startsWith(p))) return true;
  return false;
}

export async function toolAegisConversations(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  // Fetch extra to account for filtered internal conversations
  const rows = await env.db.prepare('SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?').bind(limit * 2).all();
  const visible = (rows.results as Array<{ id: string; title?: string }>)
    .filter(r => !isInternalConversation(r.id, r.title))
    .slice(0, limit);
  return { content: [{ type: 'text', text: JSON.stringify(visible, null, 2) }] };
}

export async function toolAegisConversationHistory(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const id = args.conversation_id as string;
  if (!id) return { content: [{ type: 'text', text: 'Error: conversation_id is required' }], isError: true };

  // Block access to internal system conversations via MCP
  if (isInternalConversation(id)) {
    return { content: [{ type: 'text', text: 'Error: access denied — internal system conversation' }], isError: true };
  }

  const rows = await env.db.prepare('SELECT id, role, content, metadata, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').bind(id).all();
  const messages = rows.results.map((m: Record<string, unknown>) => ({
    ...m,
    metadata: m.metadata ? JSON.parse(m.metadata as string) : null,
  }));
  return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] };
}

export async function toolAegisAgenda(env: EdgeEnv): Promise<ToolResult> {
  const items = await getActiveAgendaItems(env.db);
  return { content: [{ type: 'text', text: JSON.stringify({ count: items.length, items }, null, 2) }] };
}

export async function toolAegisHealth(env: EdgeEnv): Promise<ToolResult> {
  const procedures = await getAllProcedures(env.db);
  const result = {
    status: 'ok',
    service: 'aegis-web',
    timestamp: new Date().toISOString(),
    kernel: {
      learned: procedures.filter(p => p.status === 'learned').length,
      learning: procedures.filter(p => p.status === 'learning').length,
      degraded: procedures.filter(p => p.status === 'degraded').length,
      broken: procedures.filter(p => p.status === 'broken').length,
    },
    procedures: procedures.map(p => ({
      pattern: p.task_pattern,
      executor: p.executor,
      status: p.status,
      successes: p.success_count,
      failures: p.fail_count,
      successRate: (p.success_count + p.fail_count) > 0
        ? Number((p.success_count / (p.success_count + p.fail_count)).toFixed(2))
        : 0,
    })),
  };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export async function toolAegisMemory(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  if (!env.memoryBinding) {
    return { content: [{ type: 'text', text: 'Error: Memory Worker binding unavailable — memory operations are offline' }], isError: true };
  }

  const id = args.id as string | undefined;

  // Direct ID lookup — bypasses search entirely
  if (id) {
    const results = await env.memoryBinding.recall('aegis', { id });
    if (results.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ count: 0, entries: [], note: 'Fragment not found by ID' }, null, 2) }] };
    }
    const f = results[0];
    return { content: [{ type: 'text', text: JSON.stringify({ count: 1, entries: [{ id: f.id, topic: f.topic, fact: f.content, confidence: f.confidence, lifecycle: f.lifecycle, strength: f.strength, access_count: f.access_count, created_at: f.created_at }] }, null, 2) }] };
  }

  const topic = args.topic as string | undefined;
  const query = args.query as string | undefined;
  const limit = Math.min(Math.max(1, (args.limit as number) || 25), 100);

  let fragments: Array<{ id: string; topic: string; content: string; confidence: number }>;

  if (query) {
    // Keyword search — most targeted, least context waste
    fragments = await env.memoryBinding.recall('aegis', { keywords: query, topic, limit });
  } else {
    fragments = await getMemoryEntries(env.memoryBinding, topic);
  }

  // Apply limit
  const sliced = fragments.slice(0, limit);

  // Slim response: only fields the caller needs
  const entries = sliced.map(f => ({
    id: f.id,
    topic: f.topic,
    fact: f.content,
    confidence: f.confidence,
  }));

  return { content: [{ type: 'text', text: JSON.stringify({ count: entries.length, total: fragments.length, entries }, null, 2) }] };
}

// ─── Memory write guardrails (#244, #245, #248) ─────────────
// Prevent credential leaks and prompt injection via semantic memory.

const SECRET_PATTERNS = [
  /\b[a-zA-Z0-9_]*(?:token|key|secret|password|credential)[_:]?\s*[:=]\s*\S{16,}/i,
  /\b(?:sk|pk|api|bearer|auth|token|secret|memory_admin|imgf|sb)_[a-zA-Z0-9]{16,}/,
  /\bghp_[a-zA-Z0-9]{36}\b/,
  /\bre_[a-zA-Z0-9]{20,}\b/,
];

const BLOCKED_TOPIC_PATTERNS = [
  /^system[_-]?prompt/i,
  /^system[_-]?override/i,
  /^system[_-]?instruction/i,
  /^instruction[_-]?override/i,
  /^admin[_-]?override/i,
];

const MAX_FACT_LENGTH = 2000;

function validateMemoryWrite(topic: string, fact: string): string | null {
  if (fact.length > MAX_FACT_LENGTH) return `Fact exceeds max length (${fact.length}/${MAX_FACT_LENGTH})`;
  if (BLOCKED_TOPIC_PATTERNS.some(p => p.test(topic))) return `Topic "${topic}" is not allowed — reserved namespace`;
  if (SECRET_PATTERNS.some(p => p.test(fact))) return 'Fact appears to contain a secret/credential — refusing to store. Use wrangler secrets for sensitive values.';
  return null;
}

export async function toolAegisRecordMemory(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  if (!env.memoryBinding) {
    return { content: [{ type: 'text', text: 'Error: Memory Worker binding unavailable — cannot record memory' }], isError: true };
  }
  const topic = args.topic as string;
  const fact = args.fact as string;
  if (!topic || !fact) return { content: [{ type: 'text', text: 'Error: topic and fact are required' }], isError: true };

  const violation = validateMemoryWrite(topic, fact);
  if (violation) return { content: [{ type: 'text', text: `Rejected: ${violation}` }], isError: true };

  const confidence = (args.confidence as number) ?? 0.8;
  const source = (args.source as string) ?? 'claude_code';
  try {
    const { fragment_id } = await recordMemory(env.memoryBinding, topic, fact, confidence, source);
    return { content: [{ type: 'text', text: `Recorded: "${fact}" → ${topic} (confidence: ${confidence}, id: ${fragment_id})` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: failed to record memory — ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export async function toolAegisForgetMemory(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  if (!env.memoryBinding) {
    return { content: [{ type: 'text', text: 'Error: Memory Worker binding unavailable' }], isError: true };
  }
  const ids = args.ids as string[] | undefined;
  const id = args.id as string | undefined;
  const toDelete = ids ?? (id ? [id] : []);
  if (toDelete.length === 0) return { content: [{ type: 'text', text: 'Error: id or ids required' }], isError: true };
  if (toDelete.length > 20) return { content: [{ type: 'text', text: 'Error: max 20 entries per call' }], isError: true };
  try {
    const { forgetMemory } = await import('../kernel/memory-adapter.js');
    const deleted = await forgetMemory(env.memoryBinding, toDelete);
    return { content: [{ type: 'text', text: `Deleted ${deleted} memory entry/entries` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

export async function toolAegisAddAgenda(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const item = args.item as string;
  if (!item) return { content: [{ type: 'text', text: 'Error: item is required' }], isError: true };
  const context = args.context as string | undefined;
  const priority = (args.priority as 'low' | 'medium' | 'high') ?? 'medium';
  const id = await addAgendaItem(env.db, item, context, priority);
  return { content: [{ type: 'text', text: `Added agenda item #${id}: "${item}" (${priority})` }] };
}

export async function toolAegisResolveAgenda(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const id = args.id as number;
  const status = args.status as 'done' | 'dismissed';
  if (!id || !status) return { content: [{ type: 'text', text: 'Error: id and status are required' }], isError: true };
  await resolveAgendaItem(env.db, id, status);
  return { content: [{ type: 'text', text: `Resolved agenda item #${id} as ${status}` }] };
}

export async function toolAegisAddGoal(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const title = args.title as string;
  if (!title) return { content: [{ type: 'text', text: 'Error: title is required' }], isError: true };
  const description = args.description as string | undefined;
  const scheduleHours = (args.schedule_hours as number) ?? 6;
  const id = await addGoal(env.db, title, description, scheduleHours);
  return { content: [{ type: 'text', text: `Created goal "${title}" (ID: ${id}, every ${scheduleHours}h)` }] };
}

export async function toolAegisUpdateGoal(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const id = args.id as string;
  const status = args.status as 'paused' | 'completed' | 'failed';
  if (!id || !status) return { content: [{ type: 'text', text: 'Error: id and status are required' }], isError: true };
  await updateGoalStatus(env.db, id, status);
  return { content: [{ type: 'text', text: `Goal ${id} marked as ${status}` }] };
}

export async function toolAegisListGoals(env: EdgeEnv): Promise<ToolResult> {
  const goals = await getActiveGoals(env.db);
  return { content: [{ type: 'text', text: JSON.stringify({ count: goals.length, goals }, null, 2) }] };
}

export async function toolAegisCcSessions(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const id = args.id as string | undefined;
  if (id) {
    const session = await env.db.prepare('SELECT * FROM cc_sessions WHERE id = ?').bind(id).first();
    if (!session) return { content: [{ type: 'text', text: `No session found with ID ${id}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
  }
  const days = (args.days as number) ?? 7;
  const sessions = await env.db.prepare(
    "SELECT * FROM cc_sessions WHERE created_at > datetime('now', '-' || ? || ' days') ORDER BY created_at DESC LIMIT 20"
  ).bind(days).all();
  return { content: [{ type: 'text', text: JSON.stringify({ count: sessions.results.length, sessions: sessions.results }, null, 2) }] };
}

export async function toolAegisCreateCcTask(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const title = args.title as string;
  const repo = args.repo as string;
  const prompt = args.prompt as string;
  if (!title || !repo || !prompt) {
    return { content: [{ type: 'text', text: 'Error: title, repo, and prompt are required' }], isError: true };
  }

  const id = crypto.randomUUID();
  const completionSignal = (args.completion_signal as string) ?? 'TASK_COMPLETE';
  const priority = (args.priority as number) ?? 50;
  const dependsOn = (args.depends_on as string) ?? null;
  const blockedBy = Array.isArray(args.blocked_by) && args.blocked_by.length ? args.blocked_by as string[] : null;
  const maxTurns = (args.max_turns as number) ?? 25;

  const category = ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy'].includes(args.category as string ?? '') ? args.category as string : 'feature';
  const authority = ['proposed', 'auto_safe', 'operator'].includes(args.authority as string ?? '') ? args.authority as string : 'operator';

  await env.db.prepare(`
    INSERT INTO cc_tasks (id, title, repo, prompt, completion_signal, priority, depends_on, blocked_by, max_turns, created_by, authority, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aegis', ?, ?)
  `).bind(id, title.trim(), repo.trim(), prompt.trim(), completionSignal, priority, dependsOn, blockedBy ? JSON.stringify(blockedBy) : null, maxTurns, authority, category).run();

  return { content: [{ type: 'text', text: `Queued task "${title}" → ${repo} (ID: ${id}, priority: ${priority}, authority: ${authority}, category: ${category})` }] };
}

export async function toolAegisListCcTasks(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const status = args.status as string | undefined;
  const limit = Math.min(Math.max(1, (args.limit as number) || 20), 50);

  let tasks;
  const cols = 'id, title, repo, status, priority, authority, category, created_at, started_at, completed_at, exit_code, error, failure_kind, retryable';
  if (status) {
    tasks = await env.db.prepare(
      `SELECT ${cols} FROM cc_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(status, limit).all();
  } else {
    tasks = await env.db.prepare(
      `SELECT ${cols} FROM cc_tasks ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
  }

  return { content: [{ type: 'text', text: JSON.stringify({ count: tasks.results.length, tasks: tasks.results }, null, 2) }] };
}

export async function toolAegisCancelCcTask(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const id = args.id as string;
  if (!id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };

  const result = await env.db.prepare(
    "UPDATE cc_tasks SET status = 'cancelled', completed_at = datetime('now') WHERE id = ? AND status IN ('pending', 'running')"
  ).bind(id).run();

  if (result.meta.changes === 0) {
    return { content: [{ type: 'text', text: `Task ${id} not found or not in a cancellable status (pending/running)` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Cancelled task ${id}` }] };
}

export async function toolAegisApproveCcTask(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const id = args.id as string;
  if (!id) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true };

  const result = await env.db.prepare(
    "UPDATE cc_tasks SET authority = 'operator' WHERE id = ? AND authority = 'proposed' AND status = 'pending'"
  ).bind(id).run();

  if (result.meta.changes === 0) {
    return { content: [{ type: 'text', text: `Task ${id} not found, not proposed, or not pending` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Approved task ${id} — now eligible for autonomous execution` }] };
}

export async function toolAegisTaskSummary(env: EdgeEnv): Promise<ToolResult> {
  // Counts by status
  const statusCounts = await env.db.prepare(
    "SELECT status, COUNT(*) as count FROM cc_tasks GROUP BY status"
  ).all();
  const counts: Record<string, number> = {};
  for (const row of statusCounts.results) {
    counts[row.status as string] = row.count as number;
  }

  // Proposed tasks awaiting approval
  const proposed = await env.db.prepare(
    "SELECT id, title, repo, category, priority, created_at FROM cc_tasks WHERE authority = 'proposed' AND status = 'pending' ORDER BY priority ASC, created_at ASC"
  ).all();

  // Pending tasks ready to run (approved, not proposed)
  const pending = await env.db.prepare(
    "SELECT id, title, repo, authority, category, priority, preflight_json FROM cc_tasks WHERE status = 'pending' AND authority != 'proposed' ORDER BY priority ASC, created_at ASC"
  ).all();

  // Recent failures (last 3)
  const failures = await env.db.prepare(
    "SELECT id, title, repo, error, completed_at, failure_kind, retryable, autopsy_json FROM cc_tasks WHERE status = 'failed' ORDER BY completed_at DESC LIMIT 3"
  ).all();

  const failureKinds = await env.db.prepare(
    "SELECT failure_kind, COUNT(*) as count FROM cc_tasks WHERE status = 'failed' AND completed_at > datetime('now', '-7 days') AND failure_kind IS NOT NULL GROUP BY failure_kind ORDER BY count DESC LIMIT 10"
  ).all();

  const repoRisks = await env.db.prepare(
    "SELECT repo, COUNT(*) as fails FROM cc_tasks WHERE status = 'failed' AND completed_at > datetime('now', '-7 days') GROUP BY repo HAVING fails >= 2 ORDER BY fails DESC LIMIT 10"
  ).all();

  const preflightWarnings = pending.results.flatMap((task) => {
    const preflight = parseTaskPreflight((task as { preflight_json?: string | null }).preflight_json ?? null);
    if (!preflight?.warnings?.length) return [];
    return [{
      id: (task as { id: string }).id,
      title: (task as { title: string }).title,
      repo: (task as { repo: string }).repo,
      warnings: preflight.warnings,
      test_command: preflight.test_command ?? null,
      base_branch: preflight.base_branch ?? null,
    }];
  });

  const contractAlerts = collectContractAlerts(failures.results as Array<{
    id?: string;
    repo?: string;
    completed_at?: string | null;
    autopsy_json?: string | null;
  }>);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        counts,
        proposed: { count: proposed.results.length, tasks: proposed.results },
        pending: { count: pending.results.length, tasks: pending.results },
        recent_failures: failures.results,
        failure_kinds: failureKinds.results,
        repo_risks: repoRisks.results,
        preflight_warnings: preflightWarnings,
        contract_alerts: contractAlerts,
      }, null, 2),
    }],
  };
}

export async function toolAegisBatchApprove(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const ids = args.ids as string;
  if (!ids) return { content: [{ type: 'text', text: 'Error: ids is required' }], isError: true };

  let approved = 0;

  if (ids.trim().toLowerCase() === 'all') {
    const result = await env.db.prepare(
      "UPDATE cc_tasks SET authority = 'operator' WHERE authority = 'proposed' AND status = 'pending'"
    ).run();
    approved = result.meta.changes ?? 0;
  } else {
    const taskIds = ids.split(',').map(id => id.trim()).filter(Boolean);
    if (taskIds.length === 0) {
      return { content: [{ type: 'text', text: 'Error: no valid IDs provided' }], isError: true };
    }
    for (const taskId of taskIds) {
      const result = await env.db.prepare(
        "UPDATE cc_tasks SET authority = 'operator' WHERE id = ? AND authority = 'proposed' AND status = 'pending'"
      ).bind(taskId).run();
      approved += result.meta.changes ?? 0;
    }
  }

  return { content: [{ type: 'text', text: `Approved ${approved} task(s) — now eligible for autonomous execution` }] };
}

export async function toolAegisPublishTechPost(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const db = env.roundtableDb;
  if (!db) return { content: [{ type: 'text', text: 'Error: ROUNDTABLE_DB not bound' }], isError: true };
  const title = args.title as string;
  const slug = args.slug as string;
  const body = args.body as string;
  if (!title || !slug || !body) return { content: [{ type: 'text', text: 'Error: title, slug, body required' }], isError: true };
  const description = (args.description as string) ?? '';
  const tags = args.tags ? (args.tags as string).split(',').map(t => t.trim()) : [];
  const status = (args.status as string) ?? 'draft';
  const skipDevto = (args.skip_devto as boolean) ?? false;
  const id = crypto.randomUUID();
  const publishedAt = status === 'published' ? new Date().toISOString() : null;
  const canonicalUrl = `https://your-blog.example.com/post/${slug}`;
  const destination = status === 'published'
    ? canonicalUrl
    : 'saved as draft (no public URL until published)';

  const existing = await db.prepare('SELECT id FROM posts WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (existing) {
    await db.prepare(
      "UPDATE posts SET title = ?, description = ?, body = ?, tags = ?, status = ?, published_at = COALESCE(published_at, ?), updated_at = datetime('now') WHERE slug = ?"
    ).bind(title, description, body, JSON.stringify(tags), status, publishedAt, slug).run();

    // Syndicate to dev.to on publish
    let devtoResult = '';
    if (status === 'published' && !skipDevto && env.devtoApiKey) {
      devtoResult = await syndicateToDevto(env.devtoApiKey, { title, body, tags, description, canonicalUrl });
    }

    return { content: [{ type: 'text', text: `Updated "${title}" (${status}) → ${destination}${devtoResult}` }] };
  }

  await db.prepare(
    'INSERT INTO posts (id, slug, title, description, body, tags, status, author, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, slug, title, description, body, JSON.stringify(tags), status, 'AEGIS', publishedAt).run();

  // Syndicate to dev.to on publish
  let devtoResult = '';
  if (status === 'published' && !skipDevto && env.devtoApiKey) {
    devtoResult = await syndicateToDevto(env.devtoApiKey, { title, body, tags, description, canonicalUrl });
  }

  return {
    content: [{
      type: 'text',
      text: status === 'published'
        ? `Created "${title}" (${status}, slug: ${slug}) → ${destination}\nFeed: https://your-blog.example.com/feed.xml${devtoResult}`
        : `Created "${title}" (${status}, slug: ${slug}) → ${destination}`,
    }],
  };
}

/** Cross-post to dev.to with canonical URL pointing back to your-blog.example.com */
async function syndicateToDevto(
  apiKey: string,
  post: { title: string; body: string; tags: string[]; description: string; canonicalUrl: string },
): Promise<string> {
  try {
    // dev.to allows max 4 tags, each max 30 chars, alphanumeric + hyphens only
    const devtoTags = post.tags
      .slice(0, 4)
      .map(t => t.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30))
      .filter(Boolean);

    const res = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        'User-Agent': 'AEGIS/1.0',
      },
      body: JSON.stringify({
        article: {
          title: post.title,
          body_markdown: post.body,
          published: true,
          tags: devtoTags,
          canonical_url: post.canonicalUrl,
          description: post.description.slice(0, 150) || undefined,
          series: 'Stackbilt Engineering',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return `\ndev.to syndication failed (${res.status}): ${err.slice(0, 200)}`;
    }

    const data = await res.json<{ url?: string; id?: number }>();
    return `\ndev.to: ${data.url ?? `article #${data.id}`}`;
  } catch (err) {
    return `\ndev.to syndication error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function toolAegisGenerateDecisionDoc(args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  const topic = args.topic as string;
  if (!topic?.trim()) {
    return { content: [{ type: 'text', text: 'Error: topic is required' }], isError: true };
  }

  const doc = await generateDecisionDoc(topic.trim(), env, {
    days: (args.days as number) ?? undefined,
    includeRaw: (args.include_raw as boolean) ?? undefined,
    repo: (args.repo as string) ?? undefined,
  });

  return { content: [{ type: 'text', text: doc }] };
}
