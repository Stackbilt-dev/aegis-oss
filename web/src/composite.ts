// Composite Executor — Asymmetric AI Microservices Pipeline
// Groq plans → CF Workers AI gathers (tools) → Groq analyzes (parallel) → Claude synthesizes
//
// Cost model:
//   Groq GPT-OSS-120B: $0.15/$0.60 per MTok (orchestrate + analyze)
//   CF Workers AI GPT-OSS-120B: $0.35/$0.75 per MTok (gather)
//   Claude Sonnet: $3/$15 per MTok (synthesize)
//   Expected total: $0.01-0.03 per composite query

import { askGroqJson } from './groq.js';
import { buildContext, handleInProcessTool, callMcpWithRetry, resolveMcpTool } from './claude.js';
import { toOpenAiTools, extractText, extractToolCalls, extractUsage, type AiChatResponse } from './workers-ai-chat.js';
import { McpClient, McpRegistry } from './mcp-client.js';
import { operatorConfig } from './operator/index.js';
import { buildPersonaPreamble } from './operator/prompt-builder.js';
import { getCognitiveState, formatCognitiveContext } from './kernel/cognition.js';
import { getAttachedBlocks, assembleBlockContext } from './kernel/memory/blocks.js';
import { getConversationHistory, budgetConversationHistory } from './kernel/memory/index.js';
import { classifyCourtCard, type CourtCard, type CourtCardProfile } from './kernel/court-cards.js';
import type { KernelIntent } from './kernel/types.js';
import type { EdgeEnv } from './kernel/dispatch.js';

// ─── Types ──────────────────────────────────────────────────

interface ExecutionDAG {
  subtasks: Array<{
    id: string;
    description: string;
    tools_needed: string[];
    analysis_prompt: string;
  }>;
  synthesis_instruction: string;
  model_override?: 'sonnet' | 'opus';
}

interface SubtaskResult {
  id: string;
  description: string;
  gathered: string;
  analysis: string;
}

// ─── Cost rates ─────────────────────────────────────────────

const GROQ_GPT_OSS_RATES = { input: 0.15, output: 0.60 };
const CF_GPT_OSS_RATES = { input: 0.35, output: 0.75 };
const CLAUDE_SONNET_RATES = { input: 3, output: 15 };
const CLAUDE_OPUS_RATES = { input: 15, output: 75 };

// ─── Phase 1: Orchestrate ───────────────────────────────────

const ORCHESTRATOR_SYSTEM = `You are a task decomposition engine. Given a user query and a list of available tools, decompose the query into subtasks that can be executed independently.

Return a JSON object with this exact schema:
{
  "subtasks": [
    {
      "id": "subtask_1",
      "description": "What this subtask should accomplish",
      "tools_needed": ["tool_name_1", "tool_name_2"],
      "analysis_prompt": "After gathering data, analyze: [specific question about the gathered data]"
    }
  ],
  "synthesis_instruction": "How to combine all subtask results into a final answer",
  "model_override": null
}

Rules:
- Each subtask should gather ONE logical group of information
- Use 1-4 subtasks (prefer fewer, more focused subtasks)
- tools_needed must reference exact tool names from the available list
- If no tools are needed, use an empty tools_needed array — the subtask will be analysis-only
- analysis_prompt should ask a specific question about the gathered data
- CRITICAL: preserve ALL specific identifiers (UUIDs, IDs, enum values, exact names) from the user query verbatim in subtask descriptions. Never paraphrase identifiers.
- CRITICAL: your subtasks must address exactly what the user asked. Do NOT reinterpret, reframe, or expand the query into a different topic. If conversation context is provided, use it to understand the user's actual intent.
- synthesis_instruction should describe how to weave everything together
- Set model_override to "opus" only for queries requiring deep multi-step reasoning`;

function buildOrchestratorPrompt(
  userQuery: string,
  toolDescriptions: string,
  conversationContext?: string,
  courtCard?: CourtCardProfile,
): string {
  const contextBlock = conversationContext
    ? `Conversation context (recent turns):\n${conversationContext}\n\n`
    : '';
  const courtCardBlock = courtCard
    ? `\nRouting orientation (${courtCard.label}): ${courtCard.orchestratorHint}\n\n`
    : '';
  return `Available tools:\n${toolDescriptions}\n\n${courtCardBlock}${contextBlock}User query: ${userQuery}`;
}

async function orchestrate(
  intent: KernelIntent,
  env: EdgeEnv,
  toolDescriptions: string,
  conversationContext?: string,
  courtCard?: CourtCardProfile,
): Promise<{ dag: ExecutionDAG; cost: number }> {
  const userPrompt = buildOrchestratorPrompt(intent.raw, toolDescriptions, conversationContext, courtCard);
  const { parsed, usage } = await askGroqJson<ExecutionDAG>(
    env.groqApiKey,
    env.groqGptOssModel,
    ORCHESTRATOR_SYSTEM,
    userPrompt,
    env.groqBaseUrl,
    { maxTokens: 1500, temperature: 0.2 },
  );

  let cost = 0;
  if (usage) {
    cost = (usage.prompt_tokens * GROQ_GPT_OSS_RATES.input
      + usage.completion_tokens * GROQ_GPT_OSS_RATES.output) / 1_000_000;
  }

  // Validate DAG structure
  if (!parsed.subtasks || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
    throw new Error('Orchestrator returned empty DAG');
  }

  return { dag: parsed, cost };
}

// ─── DAG Intent Validator ────────────────────────────────────
// Lightweight heuristic: extract significant words from the user query and
// check that the DAG's synthesis instruction + subtask descriptions share
// enough lexical overlap. If the orchestrator reframed the task into
// something unrelated, overlap will be low → fail closed to single-model.

function validateDagIntent(userQuery: string, dag: ExecutionDAG): boolean {
  const extractWords = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3));

  const queryWords = extractWords(userQuery);
  if (queryWords.size === 0) return true; // trivial query, let it through

  // Combine all DAG text: synthesis instruction + subtask descriptions
  const dagText = [
    dag.synthesis_instruction,
    ...dag.subtasks.map(s => s.description),
  ].join(' ');
  const dagWords = extractWords(dagText);

  // Count how many query words appear in the DAG
  let overlap = 0;
  for (const word of queryWords) {
    if (dagWords.has(word)) overlap++;
  }

  const overlapRatio = overlap / queryWords.size;
  // Require at least 25% of query words to appear in the DAG.
  // This catches gross reinterpretation (job search → provider evaluation)
  // while allowing legitimate decomposition that uses different phrasing.
  if (overlapRatio < 0.25) {
    console.warn(`[composite] DAG overlap: ${overlap}/${queryWords.size} (${(overlapRatio * 100).toFixed(0)}%) — below 25% threshold`);
    return false;
  }

  return true;
}

// ─── Phase 2: Gather (CF Workers AI tool loop) ─────────────

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

const MAX_GATHER_ROUNDS = 6;

// ─── Phase 3: Analyze (Groq parallel) ──────────────────────

async function analyzeSubtask(
  subtask: ExecutionDAG['subtasks'][number],
  gathered: string,
  env: EdgeEnv,
  courtCard?: CourtCardProfile,
): Promise<{ analysis: string; cost: number }> {
  const lensDirective = courtCard
    ? ` ${courtCard.analysisLens}`
    : '';
  const { parsed, usage } = await askGroqJson<{ analysis: string }>(
    env.groqApiKey,
    env.groqGptOssModel,
    `${buildPersonaPreamble()} Analyze the gathered data and answer the analysis prompt. Be direct and specific — reference actual products, numbers, and context.${lensDirective} Return JSON: { "analysis": "your analysis" }`,
    `Analysis prompt: ${subtask.analysis_prompt}\n\nGathered data:\n${gathered}`,
    env.groqBaseUrl,
    { maxTokens: 2000, temperature: 0.2, prefill: '{"analysis":"' },
  );

  let cost = 0;
  if (usage) {
    cost = (usage.prompt_tokens * GROQ_GPT_OSS_RATES.input
      + usage.completion_tokens * GROQ_GPT_OSS_RATES.output) / 1_000_000;
  }

  return { analysis: parsed.analysis ?? gathered, cost };
}

// ─── Phase 4: Synthesize (Claude) ───────────────────────────

async function synthesize(
  intent: KernelIntent,
  subtaskResults: SubtaskResult[],
  synthesisInstruction: string,
  env: EdgeEnv,
  useOpus: boolean,
  courtCard?: CourtCardProfile,
): Promise<{ text: string; cost: number }> {
  const model = useOpus ? env.opusModel : env.claudeModel;
  const rates = useOpus ? CLAUDE_OPUS_RATES : CLAUDE_SONNET_RATES;

  const subtaskSummary = subtaskResults.map(r => {
    // Include raw gathered data so synthesis can recover structured values the analysis step may have dropped
    const gatheredSection = r.gathered && r.gathered !== r.analysis
      ? `\n**Raw data:**\n${r.gathered.slice(0, 3000)}`
      : '';
    return `### ${r.id}: ${r.description}\n${r.analysis}${gatheredSection}`;
  }).join('\n\n');

  // Inject block context so Claude can reference identity, products, narratives
  let contextSuffix = '';
  try {
    const blocks = await getAttachedBlocks(env.db, 'composite');
    if (blocks.length > 0) {
      contextSuffix = '\n\n' + assembleBlockContext(blocks);
    } else {
      // Fallback: CognitiveState when blocks haven't been seeded yet
      const cogState = await getCognitiveState(env.db);
      if (cogState) contextSuffix = '\n' + formatCognitiveContext(cogState);
    }
  } catch { /* non-fatal — synthesize without cognitive context */ }

  const response = await fetch(`${env.anthropicBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: `${buildPersonaPreamble()} Synthesize the analyzed subtask results into a coherent, actionable answer. Speak as AEGIS — the co-founder who knows the business inside-out. Be thorough but concise. Reference specific products, numbers, and context from the portfolio below. Never give generic consultant advice; give the answer a co-founder would give.${courtCard ? ` ${courtCard.synthesisVoice}` : ''}${contextSuffix}`,
      messages: [{
        role: 'user',
        content: `Original query: ${intent.raw}\n\nSynthesis instruction: ${synthesisInstruction}\n\nSubtask results:\n${subtaskSummary}`,
      }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json<{
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
  }>();

  const text = data.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  const cost = (data.usage.input_tokens * rates.input + data.usage.output_tokens * rates.output) / 1_000_000;

  return { text: text || '(no synthesis)', cost };
}

// ─── Groq synthesis fallback ────────────────────────────────

async function synthesizeGroqFallback(
  intent: KernelIntent,
  subtaskResults: SubtaskResult[],
  synthesisInstruction: string,
  env: EdgeEnv,
  courtCard?: CourtCardProfile,
): Promise<{ text: string; cost: number }> {
  const subtaskSummary = subtaskResults.map(r => {
    const gatheredSection = r.gathered && r.gathered !== r.analysis
      ? `\n**Raw data:**\n${r.gathered.slice(0, 3000)}`
      : '';
    return `### ${r.id}: ${r.description}\n${r.analysis}${gatheredSection}`;
  }).join('\n\n');

  // Inject block context for persona grounding in fallback path too
  let contextSuffix = '';
  try {
    const blocks = await getAttachedBlocks(env.db, 'gpt_oss');
    if (blocks.length > 0) {
      contextSuffix = '\n\n' + assembleBlockContext(blocks);
    } else {
      const cogState = await getCognitiveState(env.db);
      if (cogState) contextSuffix = '\n' + formatCognitiveContext(cogState);
    }
  } catch { /* non-fatal */ }

  const { parsed, usage } = await askGroqJson<{ response: string }>(
    env.groqApiKey,
    env.groqGptOssModel,
    `${buildPersonaPreamble()} Combine the analyzed subtask results into a coherent answer. Speak as AEGIS — the co-founder who knows the business. Reference specific products and context. Never give generic advice.${courtCard ? ` ${courtCard.synthesisVoice}` : ''}${contextSuffix} Return JSON: { "response": "your complete answer" }`,
    `Original query: ${intent.raw}\n\nSynthesis instruction: ${synthesisInstruction}\n\nSubtask results:\n${subtaskSummary}`,
    env.groqBaseUrl,
    { maxTokens: 4000, temperature: 0.3 },
  );

  let cost = 0;
  if (usage) {
    cost = (usage.prompt_tokens * GROQ_GPT_OSS_RATES.input
      + usage.completion_tokens * GROQ_GPT_OSS_RATES.output) / 1_000_000;
  }

  return { text: parsed.response ?? '(no synthesis)', cost };
}

// ─── Composite meta type ────────────────────────────────────

export interface CompositeMeta {
  partialFailure: boolean;
  failedSubtasks: number;
  budgetExhausted: boolean;
  subtasksPlanned: number;
  subtasksExecuted: number;
  courtCard?: CourtCard;
  subrequests: {
    gather: number;
    analyze: number;
    synthesize: number;
  };
}

// ─── Main composite executor ────────────────────────────────

export async function executeComposite(
  intent: KernelIntent,
  env: EdgeEnv,
  mcpRegistry?: McpRegistry,
  maxCost = 0.50,
): Promise<{ text: string; cost: number; meta?: CompositeMeta }> {
  let totalCost = 0;

  // Subrequest counters per phase
  // Each AI call = 1 subrequest; each tool call inside gather = 1 additional subrequest
  const subrequests = { gather: 0, analyze: 0, synthesize: 0 };

  // Build context to get tool list
  // BizOps MCP client is optional — create a no-op client if not configured
  const mcpClient = new McpClient({
    url: env.bizopsToken ? operatorConfig.integrations.bizops.fallbackUrl : '',
    token: env.bizopsToken || '',
    prefix: 'bizops',
    fetcher: env.bizopsFetcher,
    rpcPath: '/rpc',
  });
  const { systemPrompt, tools } = await buildContext({
    apiKey: '',
    model: '',
    mcpClient,
    mcpRegistry,
    db: env.db,
    channel: 'web',
    conversationId: intent.source.threadId,
    githubToken: env.githubToken,
    githubRepo: env.githubRepo,
    braveApiKey: env.braveApiKey,
    roundtableDb: env.roundtableDb,
    userQuery: intent.raw,
  }, env.roundtableDb);

  // Load conversation history for context continuity
  let conversationContext = '';
  if (intent.source.threadId) {
    try {
      const history = await getConversationHistory(env.db, intent.source.threadId, 6);
      if (history.length > 0) {
        const budgeted = budgetConversationHistory(history);
        conversationContext = budgeted.map(m =>
          `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`
        ).join('\n');
      }
    } catch { /* non-fatal — orchestrate without history */ }
  }

  // ─── Court card classification (zero model calls) ──────────
  const courtCard = classifyCourtCard(intent.raw, intent.classified, intent.complexity);
  console.log(`[composite] court card: ${courtCard.label} (${courtCard.orientation})`);

  // Build tool descriptions for orchestrator (names + descriptions + required params)
  const toolDescriptions = (tools as Array<{ name: string; description: string; input_schema?: { required?: string[]; properties?: Record<string, { type?: string; description?: string }> } }>)
    .map(t => {
      let line = `- ${t.name}: ${t.description}`;
      const schema = t.input_schema;
      if (schema?.required?.length) {
        const params = schema.required.map(p => {
          const prop = schema.properties?.[p];
          return prop?.type ? `${p}: ${prop.type}` : p;
        }).join(', ');
        line += ` [required: ${params}]`;
      }
      return line;
    })
    .join('\n');

  // Phase 1: Orchestrate
  let dag: ExecutionDAG;
  try {
    const orchResult = await orchestrate(intent, env, toolDescriptions, conversationContext, courtCard);
    dag = orchResult.dag;
    totalCost += orchResult.cost;
    // Orchestrate is 1 Groq API call = 1 subrequest (counted in gather phase budget)
    subrequests.gather += 1;
    console.log(`[composite] orchestrated ${dag.subtasks.length} subtasks`);

    // ─── DAG intent validator (fail-closed) ─────────────────
    // If the synthesis instruction introduces an objective that doesn't relate
    // to the original query, abort to single-model gpt_oss which preserves
    // thread history and won't reinterpret intent.
    if (!validateDagIntent(intent.raw, dag)) {
      console.warn(`[composite] DAG intent drift detected — aborting to gpt_oss`);
      const { executeWorkersAiChat } = await import('./workers-ai-chat.js');
      return executeWorkersAiChat({
        ai: env.ai!,
        model: env.gptOssModel,
        mcpClient,
        db: env.db,
        channel: 'web',
        conversationId: intent.source.threadId,
        githubToken: env.githubToken,
        githubRepo: env.githubRepo,
        braveApiKey: env.braveApiKey,
      }, intent.raw);
    }
  } catch (err) {
    // Fallback: single-executor GPT-OSS if orchestration fails
    console.warn(`[composite] orchestration failed, falling back to gpt_oss: ${err instanceof Error ? err.message : String(err)}`);
    const { executeWorkersAiChat } = await import('./workers-ai-chat.js');
    return executeWorkersAiChat({
      ai: env.ai!,
      model: env.gptOssModel,
      mcpClient,
      db: env.db,
      channel: 'web',
      conversationId: intent.source.threadId,
      githubToken: env.githubToken,
      githubRepo: env.githubRepo,
      braveApiKey: env.braveApiKey,
    }, intent.raw);
  }

  // ─── Fast-path: single subtask with tools → skip analyze+synthesize ───
  // When the orchestrator produces exactly 1 subtask, the full 4-model pipeline
  // (orchestrate → gather → analyze → synthesize) is overkill. Run a single gather
  // round with the original query and return the result directly. This eliminates
  // 2 model hops and the parameter-paraphrasing they cause.
  if (dag.subtasks.length === 1 && dag.subtasks[0].tools_needed.length > 0) {
    const subtask = dag.subtasks[0];
    try {
      const { gathered, cost: gatherCost, subrequestCount } = await gatherSubtaskInstrumented(
        subtask, tools, systemPrompt, mcpClient, env, mcpRegistry, intent.raw,
      );
      totalCost += gatherCost;
      subrequests.gather += subrequestCount;
      console.log(`[composite] fast-path: single subtask gathered in ${subrequestCount} subreqs, $${gatherCost.toFixed(4)}`);
      return {
        text: gathered,
        cost: totalCost,
        meta: {
          partialFailure: false,
          failedSubtasks: 0,
          budgetExhausted: false,
          subtasksPlanned: 1,
          subtasksExecuted: 1,
          courtCard: courtCard.card,
          subrequests,
        } satisfies CompositeMeta,
      };
    } catch (err) {
      console.warn(`[composite] fast-path failed, falling through to full pipeline: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to full pipeline
    }
  }

  // Phase 2: Gather (sequential — CF Workers AI shared binding)
  // Cost ceiling enforced per subtask — skip remaining if budget exhausted
  const subtasksPlanned = dag.subtasks.length;
  let budgetExhausted = false;
  let failedSubtasks = 0;
  const gatherResults: Array<{ id: string; description: string; gathered: string }> = [];

  for (const subtask of dag.subtasks) {
    if (totalCost >= maxCost) {
      budgetExhausted = true;
      console.warn(`[composite] budget ceiling $${maxCost.toFixed(2)} hit after ${gatherResults.length}/${subtasksPlanned} subtasks — skipping remaining`);
      break;
    }

    try {
      const { gathered, cost, subrequestCount } = await gatherSubtaskInstrumented(subtask, tools, systemPrompt, mcpClient, env, mcpRegistry, intent.raw);
      gatherResults.push({ id: subtask.id, description: subtask.description, gathered });
      totalCost += cost;
      subrequests.gather += subrequestCount;
      console.log(`[composite] gathered ${subtask.id}: ${gathered.length} chars, $${cost.toFixed(4)}, ${subrequestCount} subreqs`);
    } catch (err) {
      console.warn(`[composite] gather failed for ${subtask.id}: ${err instanceof Error ? err.message : String(err)}`);
      gatherResults.push({ id: subtask.id, description: subtask.description, gathered: `Error: ${err instanceof Error ? err.message : String(err)}` });
      failedSubtasks += 1;
    }
  }

  // Phase 3: Analyze (parallel — Groq HTTP calls are independent)
  // Only analyze subtasks that were actually gathered
  const gatheredSubtasks = dag.subtasks.slice(0, gatherResults.length);
  const analyzePromises = gatheredSubtasks.map(async (subtask, i) => {
    const gathered = gatherResults[i]?.gathered ?? '';
    try {
      const { analysis, cost } = await analyzeSubtask(subtask, gathered, env, courtCard);
      return { id: subtask.id, description: subtask.description, gathered, analysis, cost, ok: true };
    } catch (err) {
      console.warn(`[composite] analyze failed for ${subtask.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { id: subtask.id, description: subtask.description, gathered, analysis: gathered, cost: 0, ok: false };
    }
  });

  const analyzed = await Promise.all(analyzePromises);
  for (const a of analyzed) {
    totalCost += a.cost;
    subrequests.analyze += 1; // 1 Groq call per subtask
    if (!a.ok) failedSubtasks += 1;
  }

  const subtaskResults: SubtaskResult[] = analyzed.map(a => ({
    id: a.id,
    description: a.description,
    gathered: a.gathered,
    analysis: a.analysis,
  }));

  console.log(`[composite] analyzed ${subtaskResults.length} subtasks, pre-synthesis cost: $${totalCost.toFixed(4)}`);

  // Phase 4: Synthesize (Claude with Groq fallback)
  const useOpus = dag.model_override === 'opus';
  const partialFailure = budgetExhausted || failedSubtasks > 0;
  const meta: CompositeMeta = {
    partialFailure,
    failedSubtasks,
    budgetExhausted,
    subtasksPlanned,
    subtasksExecuted: gatherResults.length,
    courtCard: courtCard.card,
    subrequests,
  };

  const synthesisInstruction = budgetExhausted
    ? `${dag.synthesis_instruction} NOTE: Only ${gatherResults.length} of ${subtasksPlanned} subtasks completed due to cost ceiling. Synthesize from available data only.`
    : dag.synthesis_instruction;

  try {
    const { text, cost } = await synthesize(intent, subtaskResults, synthesisInstruction, env, useOpus, courtCard);
    totalCost += cost;
    subrequests.synthesize += 1;
    return { text, cost: totalCost, meta };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Anthropic API error') || msg.includes('credit balance')) {
      console.warn(`[composite] Claude synthesis failed, falling back to Groq: ${msg.slice(0, 120)}`);
      try {
        const { text, cost } = await synthesizeGroqFallback(intent, subtaskResults, synthesisInstruction, env, courtCard);
        totalCost += cost;
        subrequests.synthesize += 1;
        return { text, cost: totalCost, meta };
      } catch (groqErr) {
        console.error('[composite] Groq fallback also failed:', groqErr instanceof Error ? groqErr.message : String(groqErr));
        return { text: `Synthesis failed: both Claude and Groq unavailable. Raw subtask data is available.`, cost: totalCost, meta };
      }
    }
    throw err;
  }
}

// ─── Instrumented gather wrapper ─────────────────────────────
// Wraps gatherSubtask to count subrequests (AI calls + tool calls)

async function gatherSubtaskInstrumented(
  subtask: ExecutionDAG['subtasks'][number],
  allTools: unknown[],
  systemPrompt: string,
  mcpClient: McpClient,
  env: EdgeEnv,
  mcpRegistry?: McpRegistry,
  originalQuery?: string,
): Promise<{ gathered: string; cost: number; subrequestCount: number }> {
  if (!env.ai) throw new Error('Workers AI binding not available');

  // Filter tools to only those needed for this subtask
  const anthropicToolDefs = allTools as Array<{ name: string; description: string; input_schema: unknown }>;
  const scopedTools = subtask.tools_needed.length > 0
    ? anthropicToolDefs.filter(t => subtask.tools_needed.includes(t.name))
    : [];
  const openAiTools = toOpenAiTools(scopedTools);

  // Include original query so the gather model has access to exact IDs, UUIDs, and enum values
  const userContent = originalQuery
    ? `Original request: ${originalQuery}\n\nYour subtask: ${subtask.description}\n\nIMPORTANT: Use exact identifiers (UUIDs, IDs, enum values) from the original request when calling tools.`
    : subtask.description;

  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemPrompt}\n\nFocus: ${subtask.description}\nGather the data needed and return your findings.` },
    { role: 'user', content: userContent },
  ];

  let totalCost = 0;
  let subrequestCount = 0;

  // Tool loop — up to MAX_GATHER_ROUNDS
  for (let round = 0; round < MAX_GATHER_ROUNDS; round++) {
    subrequestCount += 1; // 1 AI call per round
    const result = await env.ai.run(env.gptOssModel as Parameters<Ai['run']>[0], {
      messages,
      ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
      max_tokens: 2048,
      temperature: 0.2,
      top_p: 0.9,
      frequency_penalty: 0.3,
    } as Record<string, unknown>) as AiChatResponse;

    const usage = extractUsage(result);
    if (usage) {
      totalCost += (usage.prompt_tokens * CF_GPT_OSS_RATES.input
        + usage.completion_tokens * CF_GPT_OSS_RATES.output) / 1_000_000;
    }

    const toolCalls = extractToolCalls(result);
    const responseText = extractText(result);

    if (toolCalls.length === 0) {
      return { gathered: responseText ?? '(no data gathered)', cost: totalCost, subrequestCount };
    }

    messages.push({ role: 'assistant', content: responseText ?? '', tool_calls: toolCalls });

    for (const call of toolCalls) {
      subrequestCount += 1; // 1 subrequest per tool call (external fetch or DB query)
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* empty args */ }

      let toolResult: string;
      const inProcess = await handleInProcessTool(
        env.db, call.function.name, args,
        env.githubToken, env.githubRepo, env.braveApiKey,
        env.roundtableDb,
        { apiKey: env.anthropicApiKey, model: env.claudeModel, baseUrl: env.anthropicBaseUrl },
        env.memoryBinding,
        { resendApiKey: env.resendApiKey, resendApiKeyPersonal: env.resendApiKeyPersonal },
      );

      if (inProcess !== null) {
        toolResult = inProcess;
      } else {
        const resolved = resolveMcpTool(call.function.name, mcpClient, mcpRegistry);
        if (resolved) {
          toolResult = await callMcpWithRetry(resolved.client, resolved.mcpName, args);
        } else {
          toolResult = `Unknown tool: ${call.function.name}`;
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: toolResult });
    }
  }

  // Force summary if tool rounds exhausted
  // Condense messages: strip tool_calls metadata and truncate tool results
  // to prevent context overflow when sending to GPT-OSS without tools definition
  const condensedGather: ChatMessage[] = [messages[0]]; // system
  const gatherFindings: string[] = [];
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user' && !('tool_call_id' in msg)) {
      condensedGather.push(msg);
    } else if (msg.role === 'assistant' && msg.content) {
      gatherFindings.push(msg.content);
    } else if (msg.role === 'tool') {
      const truncated = msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '... [truncated]'
        : msg.content;
      gatherFindings.push(truncated);
    }
  }
  if (gatherFindings.length > 0) {
    let accumulated = '';
    for (const f of gatherFindings) {
      if (accumulated.length + f.length > 20000) {
        accumulated += '\n[... additional data truncated]';
        break;
      }
      accumulated += '\n' + f;
    }
    condensedGather.push({ role: 'assistant', content: `Gathered data:\n${accumulated.trim()}` });
  }
  condensedGather.push({ role: 'user', content: 'Summarize all data gathered so far. Return the raw findings.' });

  subrequestCount += 1;
  const summaryResult = await env.ai.run(env.gptOssModel as Parameters<Ai['run']>[0], {
    messages: condensedGather,
    max_tokens: 2048,
    temperature: 0.2,
  } as Record<string, unknown>) as AiChatResponse;

  const summaryUsage = extractUsage(summaryResult);
  if (summaryUsage) {
    totalCost += (summaryUsage.prompt_tokens * CF_GPT_OSS_RATES.input
      + summaryUsage.completion_tokens * CF_GPT_OSS_RATES.output) / 1_000_000;
  }

  return { gathered: extractText(summaryResult) ?? '(gather exhausted)', cost: totalCost, subrequestCount };
}
