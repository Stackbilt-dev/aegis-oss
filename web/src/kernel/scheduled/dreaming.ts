// Dreaming Cycle — asynchronous nightly reflection over full conversation threads
// Instead of extracting facts from lossy 500-char episodic summaries, reads raw
// conversation_history threads from the past day and asks a cheap high-context model
// to extract durable facts, user preferences, routing failures, and BizOps drift.

import { type EdgeEnv } from '../dispatch.js';
import { recordMemory as recordMemoryAdapter } from '../memory-adapter.js';
import { getActiveAgendaItems, resolveAgendaItem, type AgendaItem } from '../memory/agenda.js';
import { askGroq } from '../../groq.js';
import { createIssue, resolveRepoName } from '../../github.js';
import { ensureOnBoard } from '../board.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';
import { runReading, summarizeForMemory, formatSymbolicNote } from '../symbolic.js';
import { checkTaskGovernanceLimits } from './governance.js';

// ─── Workers AI helper (free inference, Groq fallback) ──────
async function askWorkersAiOrGroq(
  env: EdgeEnv,
  system: string,
  user: string,
  useResponseModel = false,
): Promise<string> {
  if (env.ai) {
    const model = useResponseModel
      ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      : (env.gptOssModel || '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    const result = await env.ai.run(
      model as Parameters<Ai['run']>[0],
      { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    ) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
    return result.choices?.[0]?.message?.content ?? result.response ?? '';
  }
  // Fallback to Groq
  const groqModel = useResponseModel ? env.groqResponseModel : env.groqModel;
  return askGroq(env.groqApiKey, groqModel, system, user, env.groqBaseUrl);
}

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
- proposed_tasks MUST reference specific files or modules to change. Do NOT propose vague tasks like "add tests for X project" — name the exact source files to test. BizOps project records are metadata, not codebases — never generate tasks about BizOps project entries themselves.`;

export async function runDreamingCycle(env: EdgeEnv): Promise<void> {
  // Check last dreaming run — only run once per day
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_dreaming_at'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const hoursSince = (Date.now() - new Date(lastRun.received_at + 'Z').getTime()) / (1000 * 60 * 60);
    if (hoursSince < 20) return; // Not time yet
  }

  // Fetch all conversation threads from the past 24 hours
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

  // Don't bail early on zero chat threads — CC sessions may still provide content

  // Load full thread content
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

  // Load Claude Code session digests from past 24h — richer than chat threads
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

  if (threadContents.length === 0) {
    await advanceWatermark(env.db);
    return;
  }

  // Fetch current BizOps state as exocortex context
  let bizopsContext = '';
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
    bizopsContext = `\n\nCurrent BizOps state (compare against conversations):\nOrganizations: ${typeof orgs === 'string' ? orgs.slice(0, 2000) : JSON.stringify(orgs).slice(0, 2000)}\nProjects: ${typeof projects === 'string' ? projects.slice(0, 2000) : JSON.stringify(projects).slice(0, 2000)}`;
  } catch {
    // BizOps unavailable — dream without exocortex
  }

  // Inject CC task execution health so dreaming sees pipeline state when proposing tasks
  let taskHealthContext = '';
  try {
    const taskStats = await env.db.prepare(
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
      taskHealthContext = `\n\nRecent task results (7d): ${parts.join(', ')}`;
    }
  } catch {
    // Non-fatal — dream without task health
  }

  const userPrompt = `${threadContents.join('\n\n').slice(0, 25000)}${bizopsContext}${taskHealthContext}`;

  let rawResponse: string;
  try {
    rawResponse = await askWorkersAiOrGroq(env, DREAMING_SYSTEM, userPrompt);
  } catch (err) {
    console.warn('[dreaming] LLM call failed:', err instanceof Error ? err.message : String(err));
    return;
  }

  if (!rawResponse) {
    console.warn('[dreaming] Groq returned empty response');
    await advanceWatermark(env.db);
    return;
  }

  // Parse response
  const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let result: {
    facts?: Array<{ topic: string; fact: string; confidence: number }>;
    routing_failures?: Array<{ thread_id: string; description: string }>;
    bizops_drift?: Array<{ entity: string; field: string; actual_value: string }>;
    preferences?: Array<{ preference: string; evidence: string }>;
    proposed_tasks?: Array<{ title: string; repo: string; prompt: string; category: string; rationale: string }>;
  };

  try {
    result = JSON.parse(cleaned);
  } catch {
    console.warn('[dreaming] Failed to parse response');
    await advanceWatermark(env.db);
    return;
  }

  // Process facts (cap at 5 per dreaming cycle — more generous than hourly consolidation)
  // Blocklist: topics that polluted memory with low-value synthesis noise
  const BLOCKED_TOPIC_PREFIXES = ['synthesis_', 'cross_repo_insight'];
  // Add your project-specific topic names here
  const ALLOWED_TOPICS = new Set([
    'aegis', 'infrastructure', 'compliance', 'content',
    'bizops', 'finance', 'project', 'operator_preferences',
    'meta_insight', 'feed_intel',
  ]);

  let factsRecorded = 0;
  for (const fact of (result.facts ?? []).slice(0, 5)) {
    if (!fact.topic || !fact.fact || fact.fact.length < 20) continue;

    // Block polluting topics at code level (model may ignore prompt rules)
    const topicLower = fact.topic.toLowerCase().trim();
    if (BLOCKED_TOPIC_PREFIXES.some(p => topicLower.startsWith(p))) {
      console.log(`[dreaming] Blocked polluting topic: ${fact.topic}`);
      continue;
    }
    if (!ALLOWED_TOPICS.has(topicLower)) {
      console.log(`[dreaming] Blocked unknown topic '${fact.topic}' — add to ALLOWED_TOPICS if legitimate`);
      continue;
    }

    try {
      if (!env.memoryBinding) continue;
      await recordMemoryAdapter(env.memoryBinding, fact.topic, fact.fact, fact.confidence ?? 0.8, 'dreaming_cycle');
      factsRecorded++;
      console.log(`[dreaming] Fact: [${fact.topic}] ${fact.fact.slice(0, 80)}`);
    } catch (err) {
      console.warn('[dreaming] Failed to record fact:', err instanceof Error ? err.message : String(err));
    }
  }

  // Log routing failures as refinements (for debugging, not automated action)
  for (const failure of (result.routing_failures ?? []).slice(0, 3)) {
    console.warn(`[dreaming] Routing failure detected: ${failure.description}`);
  }

  // Log BizOps drift (future: auto-update via MCP)
  for (const drift of (result.bizops_drift ?? []).slice(0, 3)) {
    console.warn(`[dreaming] BizOps drift: ${drift.entity}.${drift.field} should be "${drift.actual_value}"`);
  }

  // Record user preferences as semantic memory
  for (const pref of (result.preferences ?? []).slice(0, 3)) {
    if (!pref.preference || pref.preference.length < 15) continue;
    try {
      if (!env.memoryBinding) continue;
      await recordMemoryAdapter(env.memoryBinding, 'kurt_preferences', pref.preference, 0.85, 'dreaming_cycle');
      console.log(`[dreaming] Preference: ${pref.preference.slice(0, 80)}`);
    } catch {
      // non-fatal
    }
  }

  console.log(`[dreaming] Cycle complete: ${factsRecorded} facts, ${(result.routing_failures ?? []).length} failures, ${(result.bizops_drift ?? []).length} drift items`);

  // ─── Task Proposal Extraction ─────────────────────────────
  // Process proposed_tasks from the Groq analysis, route by category,
  // check governance limits, and insert into cc_tasks.
  await processDreamingTaskProposals(env.db, result.proposed_tasks);

  // ─── Phase 2: Agenda triage ─────────────────────────────────
  // Scan active agenda items. Promote work items to GitHub issues so they
  // flow through the Issue → Task pipeline. Keep only operator-scratchpad
  // items (deadlines, blockers, proposed actions) on the agenda.
  await triageAgendaToIssues(env);

  // ─── Phase 3: Persona extraction ──────────────────────────
  // Second pass on the same threads — extract personality dimensions
  // rather than facts. Feeds the persona matrix over time (aegis#95).
  await extractPersonaDimensions(env, threadContents);

  // ─── Phase 4: Pattern Synthesis Daemon (PRISM) ────────────
  // Cross-topic connection discovery. Pulls recent facts from multiple
  // memory topics, asks Groq to find non-obvious structural connections,
  // then validates utility before committing to meta_insight tier.
  await runPatternSynthesis(env);

  // ─── Phase 5: Symbolic reflection (TarotScript SingleDraw) ──
  // Structured serendipity — a single card mirror on the day's patterns.
  // Surfaces blind spots that convergent analytical reasoning suppresses.
  await runSymbolicReflection(env);

  await advanceWatermark(env.db);
}

// ─── Task Proposal Processing ────────────────────────────────
// Routes dreaming-extracted task proposals into cc_tasks with
// appropriate authority levels based on category.

// Category → authority mapping:
// docs, tests, research → auto_safe (low-risk, well-scoped)
// bugfix, feature, refactor → proposed (needs operator approval)
// deploy → skip entirely (never auto-queue deploys)
const AUTO_SAFE_CATEGORIES = new Set(['docs', 'tests', 'research', 'refactor']);
const PROPOSED_CATEGORIES = new Set(['bugfix', 'feature']);
const VALID_CATEGORIES = new Set([...AUTO_SAFE_CATEGORIES, ...PROPOSED_CATEGORIES]);

// Valid repos the taskrunner can resolve — must match aliases in taskrunner.sh
// Customize this set for your org's repos
const VALID_TASK_REPOS = new Set([
  'aegis',
  // Add your repo directory names here
]);

const MIN_PROMPT_LENGTH = 80; // Prompts shorter than this are too vague to execute

async function processDreamingTaskProposals(
  db: D1Database,
  proposedTasks?: Array<{ title: string; repo: string; prompt: string; category: string; rationale: string }>,
): Promise<void> {
  if (!proposedTasks || proposedTasks.length === 0) return;

  let tasksCreated = 0;
  for (const task of proposedTasks.slice(0, 3)) {
    // Validate required fields
    if (!task.title || !task.repo || !task.prompt || !task.category) {
      console.warn(`[dreaming:tasks] Skipping task with missing fields: ${task.title ?? '(no title)'}`);
      continue;
    }

    // Validate repo against known repos
    const repoNormalized = task.repo.trim().toLowerCase();
    if (!VALID_TASK_REPOS.has(repoNormalized)) {
      console.warn(`[dreaming:tasks] Skipping task with unknown repo '${task.repo}': ${task.title}`);
      continue;
    }

    // Reject prompts that are too vague to execute autonomously
    if (task.prompt.trim().length < MIN_PROMPT_LENGTH) {
      console.warn(`[dreaming:tasks] Skipping task with prompt too short (${task.prompt.length} chars): ${task.title}`);
      continue;
    }

    // Normalize category
    const category = task.category.toLowerCase().trim();

    // Skip deploy tasks entirely
    if (category === 'deploy') {
      console.log(`[dreaming:tasks] Skipping deploy task: ${task.title}`);
      continue;
    }

    // Validate category
    if (!VALID_CATEGORIES.has(category)) {
      console.warn(`[dreaming:tasks] Skipping task with invalid category '${category}': ${task.title}`);
      continue;
    }

    // All tasks are auto_safe — the PR is the approval gate, not task creation.
    const authority = 'auto_safe';

    // Check governance limits before insert
    const governance = await checkTaskGovernanceLimits(db, { repo: task.repo.trim(), title: task.title.trim(), category });
    if (!governance.allowed) {
      console.log(`[dreaming:tasks] Governance blocked '${task.title}': ${governance.reason}`);
      continue;
    }

    // Insert into cc_tasks
    const id = crypto.randomUUID();
    try {
      await db.prepare(`
        INSERT INTO cc_tasks (id, title, repo, prompt, completion_signal, status, priority, max_turns, created_by, authority, category)
        VALUES (?, ?, ?, ?, 'TASK_COMPLETE', 'pending', 50, 25, 'aegis', ?, ?)
      `).bind(id, task.title.trim(), task.repo.trim(), task.prompt.trim(), authority, category).run();

      tasksCreated++;
      console.log(`[dreaming:tasks] Created ${authority} task: ${task.title} (${category}, ${task.repo}) → ${id}`);
    } catch (err) {
      console.warn(`[dreaming:tasks] Failed to insert task '${task.title}':`, err instanceof Error ? err.message : String(err));
    }
  }

  if (tasksCreated > 0) {
    console.log(`[dreaming:tasks] Proposed ${tasksCreated} task(s) from dreaming cycle`);
  }
}

// ─── Agenda Triage ──────────────────────────────────────────
// Scans active agenda items and promotes work items to GitHub issues.
// The agenda should only contain operator-scratchpad items (deadlines,
// blockers, proposed actions, human-gated decisions). Anything that
// looks like a feature, bug, research task, or refactor gets filed
// as a GitHub issue with the `aegis` label so the issue watcher
// picks it up and routes it through the task pipeline.

const AGENDA_TRIAGE_SYSTEM = `You classify agenda items as either WORK (should be a GitHub issue) or KEEP (belongs on the operator scratchpad).

WORK items are: features to build, bugs to fix, research to do, refactors, documentation to write, code changes, design tasks, prototypes, integrations.

KEEP items are: time-sensitive deadlines, waiting-on-external blockers, proposed actions needing human approval, compliance alerts, quick operator reminders, items that need the operator's hands (not code).

For each item, return:
- "verdict": "work" or "keep"
- "repo": target GitHub repo (only if work) — use "aegis" as default, or infer from context
- "labels": array of GitHub labels (only if work) — pick from: bug, enhancement, documentation, test, research, refactor
- "title": cleaned issue title (only if work) — strip prefixes like [PROPOSED ACTION], make concise
- "body": issue body with context (only if work)

Return ONLY valid JSON (no markdown):
{
  "triage": [
    { "id": 123, "verdict": "keep" },
    { "id": 456, "verdict": "work", "repo": "aegis", "labels": ["enhancement"], "title": "Add foo feature", "body": "Description..." }
  ]
}`;

async function triageAgendaToIssues(env: EdgeEnv): Promise<void> {
  if (!env.githubToken || !env.groqApiKey) return;

  const items = await getActiveAgendaItems(env.db);
  // Skip if agenda is already lean
  if (items.length <= 5) return;

  // Filter out items that are already proposed actions or heartbeat signals — those are legitimate
  // Also skip items < 48h old — let them settle before promotion (#129)
  const now = Date.now();
  const SETTLING_MS = 48 * 60 * 60 * 1000;
  const candidates = items.filter(i => {
    if (i.item.startsWith('[PROPOSED ACTION]') || i.item.startsWith('[PROPOSED TASK]')) return false;
    if (i.context?.includes('Auto-detected by heartbeat')) return false;
    const createdMs = new Date(i.created_at.endsWith('Z') ? i.created_at : i.created_at + 'Z').getTime();
    if (now - createdMs < SETTLING_MS) return false;
    return true;
  });

  if (candidates.length === 0) return;

  const itemList = candidates.map(i =>
    `ID ${i.id} [${i.priority}]: ${i.item}${i.context ? ` — Context: ${i.context}` : ''}`,
  ).join('\n');

  let rawResponse: string;
  try {
    rawResponse = await askWorkersAiOrGroq(env, AGENDA_TRIAGE_SYSTEM, itemList, true);
  } catch (err) {
    console.warn('[dreaming:triage] LLM call failed:', err instanceof Error ? err.message : String(err));
    return;
  }

  if (!rawResponse) return;

  const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let result: {
    triage?: Array<{
      id: number;
      verdict: 'work' | 'keep';
      repo?: string;
      labels?: string[];
      title?: string;
      body?: string;
    }>;
  };

  try {
    result = JSON.parse(cleaned);
  } catch {
    console.warn('[dreaming:triage] Failed to parse response');
    return;
  }

  let promoted = 0;
  for (const item of result.triage ?? []) {
    if (item.verdict !== 'work' || !item.title || !item.repo) continue;

    // Cap at 3 promotions per cycle to avoid issue spam
    if (promoted >= 3) break;

    const resolvedRepo = resolveRepoName(item.repo);
    const labels = [...(item.labels ?? ['enhancement']), 'aegis'];

    try {
      const { number, url } = await createIssue(
        env.githubToken, resolvedRepo,
        item.title,
        `${item.body ?? ''}\n\n---\n_Promoted from AEGIS agenda item #${item.id} by dreaming triage._`,
        labels,
      );
      await resolveAgendaItem(env.db, item.id, 'done');

      // Add to project board
      const projectIdRow = await env.db.prepare(
        "SELECT received_at FROM web_events WHERE event_id = 'board_project_id'"
      ).first<{ received_at: string }>();
      if (projectIdRow?.received_at) {
        await ensureOnBoard(env.db, env.githubToken, projectIdRow.received_at, resolvedRepo, number, item.title, 'backlog').catch(() => {});
      }

      promoted++;
      console.log(`[dreaming:triage] Promoted agenda #${item.id} → ${resolvedRepo}#${number}: ${url}`);
    } catch (err) {
      console.warn(`[dreaming:triage] Failed to create issue for agenda #${item.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  if (promoted > 0) {
    console.log(`[dreaming:triage] Promoted ${promoted} agenda item(s) to GitHub issues`);
  }
}

// ─── Persona Extraction ─────────────────────────────────────
// Analyzes conversation threads for personality dimensions rather
// than factual content. Builds the persona matrix incrementally.

const PERSONA_SYSTEM = `You analyze conversations to extract personality dimensions — how someone thinks, communicates, decides, and what they value. You are NOT extracting facts or preferences. You are observing behavioral patterns.

Analyze the conversations and return ONLY valid JSON (no markdown):
{
  "observations": [
    {
      "dimension": "cognitive_style|communication|values|delegation|decision_making|emotional",
      "observation": "specific behavioral pattern observed with evidence",
      "confidence": 0.7
    }
  ]
}

Dimensions:
- cognitive_style: pattern-matching vs sequential, systems-thinking, attention patterns, how they process information
- communication: directness, brevity, humor style, when they elaborate vs stay terse, energy signals
- values: what they protect, what they trade off, aesthetic sensibility, what "good" means to them
- delegation: how they assign work, trust calibration, review depth, feedback style
- decision_making: speed, what they weigh, what they dismiss, how they handle uncertainty, reversibility awareness
- emotional: what energizes them, what drains them, confidence vs insecurity signals, momentum patterns

Rules:
- Only record patterns with clear behavioral evidence from the conversation
- Be specific: "commits to architectural decisions within one exchange" not "makes fast decisions"
- Look for HOW they engage, not WHAT they discuss
- 3-5 observations max. Skip if the conversations are too transactional to reveal personality
- Return empty observations array if nothing personality-relevant is visible`;

async function extractPersonaDimensions(env: EdgeEnv, threadContents: string[]): Promise<void> {
  if (threadContents.length === 0) return;

  let rawResponse: string;
  try {
    rawResponse = await askWorkersAiOrGroq(env, PERSONA_SYSTEM, threadContents.join('\n\n').slice(0, 15000), true);
  } catch (err) {
    console.warn('[dreaming:persona] LLM call failed:', err instanceof Error ? err.message : String(err));
    return;
  }

  if (!rawResponse) return;
  const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let result: { observations?: Array<{ dimension: string; observation: string; confidence: number }> };

  try {
    result = JSON.parse(cleaned);
  } catch {
    console.warn('[dreaming:persona] Failed to parse response');
    return;
  }

  let recorded = 0;
  for (const obs of (result.observations ?? []).slice(0, 5)) {
    if (!obs.observation || obs.observation.length < 20 || !obs.dimension) continue;
    const fact = `[${obs.dimension}] ${obs.observation}`;
    try {
      if (!env.memoryBinding) continue;
      await recordMemoryAdapter(env.memoryBinding, 'kurt_persona', fact, obs.confidence ?? 0.7, 'persona_extraction');
      recorded++;
      console.log(`[dreaming:persona] ${fact.slice(0, 80)}`);
    } catch {
      // non-fatal
    }
  }

  if (recorded > 0) {
    console.log(`[dreaming:persona] Extracted ${recorded} persona observations`);
  }
}

// ─── Symbolic Reflection ─────────────────────────────────────
// Nightly SingleDraw via TarotScript — mirrors the day's operational patterns.
// Result is stored as semantic memory and surfaces in next day's agenda synthesis.

async function runSymbolicReflection(env: EdgeEnv): Promise<void> {
  if (!env.tarotscriptFetcher) return;

  try {
    const reading = await runReading(
      env.tarotscriptFetcher,
      'dreaming',
      "Reflect on today's operational patterns",
      { domain: 'reflection', situation: 'Nightly dreaming cycle mirror', timeframe: 'immediate' },
    );

    const summary = summarizeForMemory(reading, 'dreaming', "Reflect on today's operational patterns");
    const note = formatSymbolicNote(reading, 'dreaming');

    // Store symbolic note as semantic memory
    const memoryContent = `${note}\nReceipt: ${summary.receiptHash} | Seed: ${summary.seed}`;
    if (env.memoryBinding) {
      await recordMemoryAdapter(env.memoryBinding, 'symbolic_reflection', memoryContent, 0.7, 'dreaming_cycle');
    }

    console.log(`[dreaming:symbolic] SingleDraw complete — ${summary.dominantElement}, shadow ${summary.shadowDensity.toFixed(2)}, sephira ${summary.sephira}`);
  } catch (err) {
    console.warn('[dreaming:symbolic] TarotScript reading failed:', err instanceof Error ? err.message : String(err));
  }
}

// ─── Pattern Synthesis Daemon (PRISM) ──────────────────────
// Cross-topic connection discovery. Pulls recent facts from diverse
// memory topics, asks Groq to find structural connections, then
// validates utility before committing to the meta_insight tier.
//
// Inspired by adversarial reasoning analysis: "Topological Transforms
// map network structures and discover non-obvious relationships by
// analyzing shared functional constraints and interdependencies."

const SYNTHESIS_SYSTEM = `You are a pattern synthesis engine. You receive facts from different domains stored in an AI agent's memory. Your job is to find NON-OBVIOUS structural connections between facts from DIFFERENT topics.

Rules:
- Only propose connections between facts from DIFFERENT topics (cross-domain synthesis).
- Each connection must be ACTIONABLE — it must change a decision, reveal a risk, or unlock an optimization. "These two things are related" is not enough.
- Apply adversarial self-check: could this connection be a coincidence or superficial keyword overlap? If yes, discard it.
- Maximum 2 connections per run. Quality over quantity.

Return ONLY valid JSON (no markdown):
{
  "connections": [
    {
      "fact_a": "first fact (quote or paraphrase)",
      "topic_a": "topic of first fact",
      "fact_b": "second fact (quote or paraphrase)",
      "topic_b": "topic of second fact",
      "insight": "the non-obvious connection and WHY it matters",
      "action": "specific action this insight enables or decision it changes",
      "confidence": 0.8
    }
  ]
}

If no genuine cross-domain connections exist, return {"connections": []}.
Do NOT force connections. Empty is better than noise.`;

async function runPatternSynthesis(env: EdgeEnv): Promise<void> {
  if (!env.memoryBinding) return;

  // Gather recent facts from diverse topics
  const topicSamples: Array<{ topic: string; content: string }> = [];
  const sampleTopics = [
    'aegis', 'infrastructure', 'feed_intel',
    'compliance', 'finance', 'content',
  ];

  for (const topic of sampleTopics) {
    try {
      const facts = await env.memoryBinding.recall('aegis', {
        topic,
        limit: 3,
        min_confidence: 0.7,
      });
      for (const f of facts) {
        topicSamples.push({ topic: f.topic, content: f.content });
      }
    } catch {
      // Topic may not exist yet — skip
    }
  }

  if (topicSamples.length < 6) {
    console.log(`[dreaming:prism] Too few facts for synthesis (${topicSamples.length})`);
    return;
  }

  // Deduplicate by topic — keep max 3 per topic for diversity
  const byTopic: Record<string, typeof topicSamples> = {};
  for (const s of topicSamples) {
    if (!byTopic[s.topic]) byTopic[s.topic] = [];
    if (byTopic[s.topic].length < 3) byTopic[s.topic].push(s);
  }

  const topicCount = Object.keys(byTopic).length;
  if (topicCount < 3) {
    console.log(`[dreaming:prism] Need 3+ topics for cross-domain synthesis (have ${topicCount})`);
    return;
  }

  const factsBlock = Object.entries(byTopic)
    .map(([topic, facts]) =>
      `[${topic}]\n${facts.map(f => `- ${f.content}`).join('\n')}`
    ).join('\n\n');

  try {
    const raw = await askWorkersAiOrGroq(env, SYNTHESIS_SYSTEM, factsBlock.slice(0, 8000));

    if (!raw) return;

    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const result = JSON.parse(cleaned) as {
      connections?: Array<{
        fact_a: string;
        topic_a: string;
        fact_b: string;
        topic_b: string;
        insight: string;
        action: string;
        confidence: number;
      }>;
    };

    let recorded = 0;
    for (const conn of (result.connections ?? []).slice(0, 2)) {
      if (!conn.insight || !conn.action || conn.insight.length < 30) continue;
      if (conn.topic_a === conn.topic_b) continue; // Same-topic — not cross-domain

      // Utility gate: action must be specific (>20 chars, not generic advice)
      if (conn.action.length < 20) continue;

      const metaFact = `[PRISM] Connection: ${conn.topic_a} ↔ ${conn.topic_b} — ${conn.insight}. Action: ${conn.action}`;
      await recordMemoryAdapter(
        env.memoryBinding,
        'meta_insight',
        metaFact,
        Math.min(conn.confidence ?? 0.8, 0.85), // Cap confidence — insights need validation
        'pattern_synthesis',
      );
      recorded++;
      console.log(`[dreaming:prism] Meta-insight: ${conn.topic_a} ↔ ${conn.topic_b} — ${conn.insight.slice(0, 100)}`);
    }

    if (recorded === 0) {
      console.log('[dreaming:prism] No actionable cross-domain connections found (this is fine)');
    }
  } catch (err) {
    console.warn('[dreaming:prism] Pattern synthesis failed:', err instanceof Error ? err.message : String(err));
  }
}

async function advanceWatermark(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_dreaming_at', datetime('now'))"
  ).run();
}
