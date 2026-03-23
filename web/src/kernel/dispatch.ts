import { route } from './router.js';
import { recordEpisode, retrogradeEpisode, upsertProcedure, addRefinement, degradeProcedure, getProcedure, procedureKey } from './memory/index.js';
import { searchMemoryByKeywords, getAllMemoryForContext } from './memory-adapter.js';
import { generateBriefing, formatBriefing } from './briefing.js';
import { fetchRelevantInsights } from './insight-cache.js';
import { probeConsistency } from '../groq.js';
import { executeComposite } from '../composite.js';
import { buildGroqSystemPrompt } from '../operator/prompt-builder.js';
import type { KernelIntent, DispatchResult, Executor } from './types.js';
import {
  executeClaude,
  executeClaudeOpus,
  executeClaudeStream,
  executeGroq,
  executeWorkersAi,
  executeGptOss,
  executeDirect,
  executeCodeTask,
  executeWithAnthropicFailover,
  executeTarotScript,
  buildMcpRegistry,
} from './executors/index.js';
// ─── Edge Environment ────────────────────────────────────────

export interface EdgeEnv {
  db: D1Database;
  anthropicApiKey: string;
  claudeModel: string;
  opusModel: string;
  gptOssModel: string;
  groqApiKey: string;
  groqModel: string;
  groqResponseModel: string;
  groqGptOssModel: string;
  bizopsFetcher: Fetcher;
  bizopsToken: string;
  resendApiKey: string;
  resendApiKeyPersonal: string;
  githubToken: string;
  githubRepo: string;
  braveApiKey: string;
  notifyEmail: string;
  baseUrl: string;
  ai?: Ai;
  aiGatewayId?: string;
  anthropicBaseUrl: string;
  groqBaseUrl: string;
  ctx?: ExecutionContext; // optional — used to background long-running tasks
  roundtableDb?: D1Database;
  cfAnalyticsToken?: string;
  imgForgeFetcher?: Fetcher;
  imgForgeSbSecret?: string;
  memoryBinding?: import('../types.js').MemoryServiceBinding;
  tarotscriptFetcher?: Fetcher;
  maraFetcher?: Fetcher;
  maraToken?: string;
  codebeastFetcher?: Fetcher;
  mindspringFetcher?: Fetcher;
  mindspringToken?: string;
  devtoApiKey?: string;
  gaCredentials?: string;
  blueskyHandle?: string;
  blueskyAppPassword?: string;
}

// ─── Intent Construction ─────────────────────────────────────

export function createIntent(
  threadId: string,
  text: string,
  overrides?: Partial<KernelIntent>,
): KernelIntent {
  return {
    source: { channel: 'web', threadId },
    raw: text,
    timestamp: Date.now(),
    costCeiling: 'expensive',
    ...overrides,
  };
}

// ─── Self-consistency probe (#51) ────────────────────────────
// Before executing via workers_ai or gpt_oss for no-tool queries,
// fire 3 parallel Groq 8B calls. If all agree, skip the expensive executor.

const PROBE_SKIP_CLASSIFICATIONS = new Set([
  'heartbeat', 'greeting', 'code_task', 'self_improvement', 'goal_execution',
]);

function probeEligible(
  executor: string,
  intent: KernelIntent,
  classification: string,
): boolean {
  if (intent.needsTools) return false;
  if (intent.source.channel === 'internal') return false;
  if (PROBE_SKIP_CLASSIFICATIONS.has(classification)) return false;
  return executor === 'workers_ai' || executor === 'gpt_oss';
}

// ─── Shared post-execution bookkeeping ───────────────────────

async function recordOutcome(
  env: EdgeEnv,
  intent: KernelIntent,
  classification: string,
  procKey: string,
  plan: Awaited<ReturnType<typeof route>>['plan'],
  existingProcedure: Awaited<ReturnType<typeof getProcedure>>,
  text: string,
  cost: number,
  latencyMs: number,
  nearMiss: string | null | undefined,
  outcome: 'success' | 'failure' | 'partial_failure',
  reclassified?: boolean,
): Promise<void> {
  await recordEpisode(env.db, {
    intent_class: classification,
    channel: intent.source.channel,
    summary: `${classification} via ${plan.executor}${intent.classifierSource ? ` [clf:${intent.classifierSource}]` : ''}${intent.domain ? ` [domain:${intent.domain}/${(intent.domainConfidence ?? 0).toFixed(2)}]` : ''}: ${text.slice(0, 500)}`,
    outcome: outcome === 'partial_failure' ? 'failure' : outcome,
    cost,
    latency_ms: latencyMs,
    near_miss: nearMiss,
    classifier_confidence: intent.confidence,
    reclassified,
    thread_id: intent.source.threadId,
    executor: plan.executor,
  });

  await upsertProcedure(env.db, procKey, plan.executor, JSON.stringify({ executor: plan.executor }), outcome, latencyMs, cost);

  const isReplan = existingProcedure
    && (existingProcedure.status === 'degraded' || existingProcedure.status === 'broken')
    && !plan.procedureId;

  if (isReplan && outcome === 'success' && existingProcedure) {
    await addRefinement(env.db, procKey, {
      timestamp: Date.now(),
      what: `Replanned from ${existingProcedure.executor} to ${plan.executor}`,
      why: `Previous executor had ${existingProcedure.consecutive_failures} consecutive failures (status: ${existingProcedure.status})`,
      impact: 'pending',
    });
  }
}

// ─── Shared Augmentation ─────────────────────────────────────
// Common pre-dispatch logic: insight injection, memory recall,
// implicit feedback, self-improvement ACK, and probe.

interface AugmentedContext {
  plan: Awaited<ReturnType<typeof route>>['plan'];
  nearMiss: string | null | undefined;
  reclassified: boolean | undefined;
  classification: string;
  procKey: string;
  existingProcedure: Awaited<ReturnType<typeof getProcedure>>;
}

async function augmentIntent(intent: KernelIntent, env: EdgeEnv): Promise<AugmentedContext> {
  // 1. Route
  const { plan, nearMiss, reclassified } = await route(intent, env.db, env.groqApiKey, env.groqModel, env.groqBaseUrl, env.ai, env.tarotscriptFetcher);
  const classification = intent.classified ?? 'unknown';
  const procKey = procedureKey(classification, intent.complexity);
  const existingProcedure = await getProcedure(env.db, procKey);

  // 1.3. Cross-repo insight augmentation (CRIX #106)
  if (env.memoryBinding && classification !== 'greeting' && classification !== 'heartbeat') {
    try {
      const insightContext = await fetchRelevantInsights(env, classification, intent.raw);
      if (insightContext) {
        intent.raw = `${insightContext}\n\n${intent.raw}`;
      }
    } catch (err) {
      console.warn('[dispatch] Insight fetch failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  // 1.5. Memory-recall augmentation
  if (classification === 'memory_recall') {
    try {
      if (env.memoryBinding) {
        const relevant = await searchMemoryByKeywords(env.memoryBinding, intent.raw, 10);
        if (relevant.length > 0) {
          const memLines = relevant.map(m => `- [${m.topic}] ${m.fact} (confidence: ${m.confidence})`).join('\n');
          intent.raw = `[Relevant memory entries matching this query]\n${memLines}\n\n[User's question]\n${intent.raw}`;
        }
      } else {
        console.warn('[dispatch] Memory binding unavailable — skipping memory recall augmentation');
      }
    } catch (err) {
      console.warn('[dispatch] Memory search failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  // 1.6. Implicit feedback — retrograde previous episode on user correction
  if (classification === 'user_correction' && intent.source.threadId) {
    try {
      const retrograded = await retrogradeEpisode(env.db, intent.source.threadId);
      if (retrograded) {
        const badProcKey = procedureKey(retrograded.intent_class, intent.complexity);
        await degradeProcedure(env.db, badProcKey, retrograded.executor ?? 'unknown');
        console.log(`[dispatch] Implicit feedback: retrograded episode ${retrograded.id} (${retrograded.intent_class}/${retrograded.executor})`);
      }
    } catch (err) {
      console.warn('[dispatch] Implicit feedback failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  // 1.7. Greeting → Re-entry Briefing
  // Instead of a dumb "hi!", generate a situational briefing so AEGIS acts like
  // a co-founder catching you up: what happened, what needs you, what's active.
  if (classification === 'greeting') {
    try {
      const briefing = await generateBriefing(env);
      const briefingText = formatBriefing(briefing);
      intent.raw = `[The operator just opened a session. Generate a re-entry briefing — not a greeting. Lead with what needs their attention, then what shipped, then what you're working on. Be direct, no fluff. Use the data below.]\n\n${briefingText}\n\n[Operator said: ${intent.raw}]`;
    } catch (err) {
      console.warn('[dispatch] Briefing generation failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  return { plan, nearMiss, reclassified, classification, procKey, existingProcedure };
}

// ─── Self-Improvement ACK ────────────────────────────────────
// self_improvement is long-running — return immediate ACK, background the work.

function trySelfImprovementAck(
  classification: string,
  intent: KernelIntent,
  env: EdgeEnv,
  startMs: number,
): DispatchResult | null {
  if (classification !== 'self_improvement' || intent.source.channel === 'internal') return null;

  if (env.ctx) {
    env.ctx.waitUntil(
      (async () => {
        const start = Date.now();
        try {
          await executeComposite(intent, env, buildMcpRegistry(env));
          await env.db.prepare(
            "INSERT INTO task_runs (task_name, status, duration_ms) VALUES ('self_improvement', 'ok', ?)"
          ).bind(Date.now() - start).run().catch(() => {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[self_improvement] background run failed:', msg);
          await env.db.prepare(
            "INSERT INTO task_runs (task_name, status, duration_ms, error_message) VALUES ('self_improvement', 'error', ?, ?)"
          ).bind(Date.now() - start, msg).run().catch(() => {});
        }
      })(),
    );
  }

  return {
    text: 'Self-improvement analysis queued. I\'ll review the codebase, check existing issues, and post any findings as GitHub issues + agenda items. This usually takes 1-2 minutes.',
    executor: 'composite',
    cost: 0,
    latency_ms: Date.now() - startMs,
    procedureHit: false,
    classification,
  };
}

// ─── Probe + Execute ─────────────────────────────────────────
// Self-consistency probe, then executor dispatch. Shared between
// streaming and non-streaming paths.

interface ExecuteResult {
  text: string;
  cost: number;
  meta?: unknown;
  outcome: 'success' | 'failure' | 'partial_failure';
  probeResult?: 'agreed' | 'split' | 'escalated';
  earlyReturn?: DispatchResult; // probe agreed → skip executor
}

async function probeAndExecute(
  ctx: AugmentedContext,
  intent: KernelIntent,
  env: EdgeEnv,
  startMs: number,
  onDelta?: (text: string) => void,
): Promise<ExecuteResult> {
  const { plan, nearMiss, classification, procKey, existingProcedure } = ctx;
  let probeResult: 'agreed' | 'split' | 'escalated' | undefined;

  // Self-consistency probe
  if (probeEligible(plan.executor, intent, classification)) {
    try {
      const probe = await probeConsistency(
        env.groqApiKey, env.groqResponseModel, buildGroqSystemPrompt(), intent.raw, env.groqBaseUrl,
        env.memoryBinding,
      );
      if (probe.sigma === 0 && probe.agreedText) {
        console.log(`[dispatch] Probe agreed for "${classification}" — skipping ${plan.executor}`);
        const text = probe.agreedText;
        const cost = 0.0003;
        probeResult = 'agreed';
        plan.executor = 'groq';
        if (onDelta) onDelta(text);
        const latencyMs = Date.now() - startMs;
        await recordOutcome(env, intent, classification, procKey, plan, existingProcedure, text, cost, latencyMs, nearMiss, 'success', ctx.reclassified);
        return {
          text, cost, outcome: 'success', probeResult,
          earlyReturn: { text, executor: plan.executor, cost, latency_ms: latencyMs, procedureHit: !!plan.procedureId, classification, confidence: intent.confidence, reclassified: ctx.reclassified, probeResult, meta: undefined },
        };
      } else if (probe.sigma === 1.0) {
        const prev = plan.executor;
        plan.executor = plan.executor === 'workers_ai' ? 'gpt_oss' : 'composite';
        probeResult = 'escalated';
        console.log(`[dispatch] Probe disagreed for "${classification}" — escalating ${prev} → ${plan.executor}`);
      } else {
        probeResult = 'split';
      }
    } catch (err) {
      console.warn('[dispatch] Probe failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  // Execute
  let text: string;
  let cost: number;
  let meta: unknown;
  let outcome: 'success' | 'failure' | 'partial_failure' = 'success';

  try {
    let result: { text: string; cost: number; meta?: unknown };

    // Streaming Claude path — uses executeClaudeStream for real-time deltas
    if (onDelta && (plan.executor === 'claude' || plan.executor === 'claude_opus')) {
      try {
        // Tag intent so executeClaudeStream picks the right model
        const savedClassified = intent.classified;
        intent.classified = plan.executor;
        const streamResult = await executeClaudeStream(intent, env, onDelta);
        intent.classified = savedClassified;
        result = streamResult;
      } catch (streamErr) {
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        if (msg.includes('Anthropic API error') || msg.includes('credit balance')) {
          console.warn(`[dispatch] streaming ${plan.executor} failed, failover → gpt_oss: ${msg.slice(0, 120)}`);
          const fallback = await executeGptOss(intent, env);
          result = fallback;
          plan.executor = 'gpt_oss';
          onDelta(result.text);
        } else {
          throw streamErr;
        }
      }
    } else {
      // Non-streaming or non-Claude executors
      switch (plan.executor) {
        case 'claude':
        case 'claude_opus': {
          const r = await executeWithAnthropicFailover(plan.executor, intent, env);
          result = r;
          plan.executor = r.actualExecutor;
          break;
        }
        case 'composite':
          result = await executeComposite(intent, env, buildMcpRegistry(env));
          break;
        case 'gpt_oss':
          result = await executeGptOss(intent, env);
          break;
        case 'workers_ai':
          result = await executeWorkersAi(intent, env);
          break;
        case 'groq':
          result = await executeGroq(intent, env);
          break;
        case 'direct':
          result = await executeDirect(intent, env);
          break;
        case 'claude_code':
          result = await executeCodeTask(intent, env);
          break;
        case 'tarotscript':
          result = await executeTarotScript(intent, env);
          break;
        default:
          throw new Error(`Unknown executor: ${plan.executor}`);
      }

      // For streaming non-Claude executors, emit full text as single delta
      if (onDelta) onDelta(result.text);
    }

    text = result.text;
    cost = result.cost;
    meta = result.meta;
    // Detect partial failure from composite executor (#71)
    const partialMeta = result.meta as { partialFailure?: boolean } | undefined;
    if (partialMeta?.partialFailure) {
      outcome = 'partial_failure';
    }
  } catch (err) {
    outcome = 'failure';
    cost = 0;
    text = `Error: ${err instanceof Error ? err.message : String(err)}`;
    if (onDelta) onDelta(text);
  }

  return { text, cost, meta, outcome, probeResult };
}

// ─── Shadow Exploration (#290) ───────────────────────────────
// On ~5% of expensive dispatches, background-test a cheaper executor.
// If the cheaper tier produces quality output, record it as a candidate
// in procedural memory. Promotion happens automatically via the
// candidate_executor probation system in upsertProcedure().

const SHADOW_EXPLORATION_RATE = 0.05; // 5% of eligible dispatches

// Expensive → cheaper executor demotion map
const SHADOW_DEMOTION: Partial<Record<Executor, Executor>> = {
  claude_opus: 'claude',
  claude: 'gpt_oss',
  composite: 'gpt_oss',
  gpt_oss: 'workers_ai',
};

// Skip shadow exploration for these classifications
const SHADOW_SKIP = new Set([
  'heartbeat', 'greeting', 'code_task', 'self_improvement',
  'goal_execution', 'user_correction',
]);

function shadowEligible(executor: Executor, classification: string, intent: KernelIntent): boolean {
  if (SHADOW_SKIP.has(classification)) return false;
  if (intent.source.channel === 'internal') return false;
  if (!SHADOW_DEMOTION[executor]) return false;
  return Math.random() < SHADOW_EXPLORATION_RATE;
}

// Quality gate: is the shadow output good enough to count as a success?
function shadowQualityPass(primaryText: string, shadowText: string): boolean {
  // Too short = likely error or refusal
  if (shadowText.length < 20) return false;
  // Length ratio: shadow should be at least 30% of primary length
  if (shadowText.length < primaryText.length * 0.3) return false;
  // Error patterns
  const errorPatterns = /^error:|i cannot|i'm unable|as an ai|i don't have/i;
  if (errorPatterns.test(shadowText.trim())) return false;
  return true;
}

async function tryShadowExploration(
  ctx: AugmentedContext,
  intent: KernelIntent,
  env: EdgeEnv,
  primaryText: string,
): Promise<void> {
  const primaryExecutor = ctx.plan.executor;
  const shadowExecutor = SHADOW_DEMOTION[primaryExecutor];
  if (!shadowExecutor) return;

  try {
    // Clone intent to avoid mutation
    const shadowIntent: KernelIntent = { ...intent, classified: shadowExecutor };
    let result: { text: string; cost: number };

    switch (shadowExecutor) {
      case 'gpt_oss':
        result = await executeGptOss(shadowIntent, env);
        break;
      case 'workers_ai':
        result = await executeWorkersAi(shadowIntent, env);
        break;
      case 'claude':
        result = await executeClaude(shadowIntent, env);
        break;
      default:
        return;
    }

    const passed = shadowQualityPass(primaryText, result.text);
    const outcome = passed ? 'success' : 'failure';

    // Record to procedural memory as the shadow executor —
    // upsertProcedure's probation system handles candidate tracking
    await upsertProcedure(
      env.db, ctx.procKey, shadowExecutor,
      JSON.stringify({ executor: shadowExecutor }),
      outcome, 0, result.cost,
    );

    console.log(
      `[shadow] ${ctx.classification}: ${primaryExecutor} → ${shadowExecutor} = ${outcome}` +
      ` (primary: ${primaryText.length} chars, shadow: ${result.text.length} chars)`,
    );
  } catch (err) {
    console.warn('[shadow] exploration failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ─── Shared Finalization ─────────────────────────────────────

function buildResult(
  ctx: AugmentedContext,
  intent: KernelIntent,
  exec: ExecuteResult,
  latencyMs: number,
): DispatchResult {
  return {
    text: exec.text,
    executor: ctx.plan.executor,
    cost: exec.cost,
    latency_ms: latencyMs,
    procedureHit: !!ctx.plan.procedureId,
    classification: ctx.classification,
    confidence: intent.confidence,
    reclassified: ctx.reclassified,
    probeResult: exec.probeResult,
    meta: exec.meta,
  };
}

// ─── Main Dispatch Loop ──────────────────────────────────────

export async function dispatch(intent: KernelIntent, env: EdgeEnv): Promise<DispatchResult> {
  const startMs = Date.now();
  const ctx = await augmentIntent(intent, env);

  // Self-improvement ACK (backgrounded)
  const ack = trySelfImprovementAck(ctx.classification, intent, env, startMs);
  if (ack) return ack;

  const exec = await probeAndExecute(ctx, intent, env, startMs);
  if (exec.earlyReturn) return exec.earlyReturn;

  const latencyMs = Date.now() - startMs;
  await recordOutcome(env, intent, ctx.classification, ctx.procKey, ctx.plan, ctx.existingProcedure, exec.text, exec.cost, latencyMs, ctx.nearMiss, exec.outcome, ctx.reclassified);

  // Background: shadow exploration + shadow read
  if (env.ctx) {
    if (exec.outcome === 'success' && shadowEligible(ctx.plan.executor as Executor, ctx.classification, intent)) {
      env.ctx.waitUntil(tryShadowExploration(ctx, intent, env, exec.text));
    }
    if (env.memoryBinding) {
      env.ctx.waitUntil(
        getAllMemoryForContext(env.memoryBinding).catch(err => {
          console.warn('[dispatch] Background shadow read failed:', err instanceof Error ? err.message : String(err));
        }),
      );
    }
  }

  return buildResult(ctx, intent, exec, latencyMs);
}

// ─── Streaming Dispatch ──────────────────────────────────────

export async function dispatchStream(
  intent: KernelIntent,
  env: EdgeEnv,
  onDelta: (text: string) => void,
): Promise<DispatchResult> {
  const startMs = Date.now();
  const ctx = await augmentIntent(intent, env);

  const exec = await probeAndExecute(ctx, intent, env, startMs, onDelta);
  if (exec.earlyReturn) return exec.earlyReturn;

  const latencyMs = Date.now() - startMs;
  await recordOutcome(env, intent, ctx.classification, ctx.procKey, ctx.plan, ctx.existingProcedure, exec.text, exec.cost, latencyMs, ctx.nearMiss, exec.outcome, ctx.reclassified);

  // Background: shadow exploration + shadow read
  if (env.ctx) {
    if (exec.outcome === 'success' && shadowEligible(ctx.plan.executor as Executor, ctx.classification, intent)) {
      env.ctx.waitUntil(tryShadowExploration(ctx, intent, env, exec.text));
    }
    if (env.memoryBinding) {
      env.ctx.waitUntil(
        getAllMemoryForContext(env.memoryBinding).catch(err => {
          console.warn('[dispatch] Background shadow read failed:', err instanceof Error ? err.message : String(err));
        }),
      );
    }
  }

  return buildResult(ctx, intent, exec, latencyMs);
}
