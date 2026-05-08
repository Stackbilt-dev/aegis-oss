import type { EdgeEnv } from './dispatch.js';
import type { Executor } from './types.js';

// ─── Provider Names ──────────────────────────────────────────
// 'anthropic' and 'cloudflare' are wired in @stackbilt/llm-providers v1.6.0.
// 'groq' and 'cerebras' are forward-declared — no LLMProviderFactory entry yet.
// A future session can wire them when provider support lands.
export type LLMProviderName = 'anthropic' | 'cloudflare' | 'groq' | 'cerebras';

// ─── LLM Executor Subset ─────────────────────────────────────
// These are the executors that call an external LLM provider.
// Excluded from EXECUTOR_ROUTES (dispatch keeps its own branches):
//   'direct'      — returns a rule-based response without an LLM call
//   'claude_code' — spins a Claude Code CLI session, not a provider call
//   'tarotscript' — service-binding fetcher, not an LLM call
//   'composite'   — orchestrates multiple executors; no single provider entry
export type LLMExecutor = Extract<
  Executor,
  'claude' | 'claude_opus' | 'gpt_oss' | 'workers_ai' | 'groq' | 'cerebras_mid' | 'cerebras_reasoning'
>;

// ─── Route Shape ─────────────────────────────────────────────

export interface ExecutorRoute {
  provider: LLMProviderName;
  // Resolves the concrete model string at dispatch time — called with the live
  // EdgeEnv so per-deployment env-var overrides and AI Gateway config are respected.
  model: (env: EdgeEnv) => string;
  // Semantic fallback executor to try when this provider errors (credit, rate-limit, auth).
  // CONSUMER CONTRACT: when a fallback fires, the consumer must propagate actualExecutor
  // back to the telemetry layer. executeWithAnthropicFailover (executors/index.ts:67)
  // returns { actualExecutor } which dispatch.ts:363 uses to mutate plan.executor before
  // the procedure store records the outcome. A routing-layer consumer must preserve this.
  fallback?: LLMExecutor;
}

// ─── Route Table ─────────────────────────────────────────────
// Covers every LLMExecutor. Non-LLM executors (see above) are intentionally absent.
//
// Future consumer sketch (D.2 wiring session):
//   const route = EXECUTOR_ROUTES[plan.executor as LLMExecutor];
//   const provider = factory.get(route.provider);   // only 'anthropic'|'cloudflare' today
//   const model    = route.model(env);
//   try { result = await provider.generateResponse({ model, messages }); }
//   catch { if (route.fallback) { /* re-dispatch, record actualExecutor */ } }

export const EXECUTOR_ROUTES: Record<LLMExecutor, ExecutorRoute> = {
  claude: {
    provider: 'anthropic',
    model: (env) => env.claudeModel,
    fallback: 'gpt_oss',
  },
  claude_opus: {
    provider: 'anthropic',
    model: (env) => env.opusModel,
    // Falls back directly to gpt_oss — mirrors executeWithAnthropicFailover behavior.
    // A two-hop chain (opus → claude → gpt_oss) is a possible future refinement.
    fallback: 'gpt_oss',
  },
  gpt_oss: {
    provider: 'cloudflare',
    model: (env) => env.gptOssModel,
    // Terminal fallback — no further fallback defined.
  },
  workers_ai: {
    provider: 'cloudflare',
    // Hardcoded in executeWorkersAi today; no env override.
    model: () => '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  },
  groq: {
    provider: 'groq',
    // groqResponseModel = 8B (llama-3.1-8b-instant) — fast/cheap for greetings.
    // Intentionally NOT groqModel (70B). See executors/groq.ts:12.
    model: (env) => env.groqResponseModel,
  },
  cerebras_mid: {
    // TODO: EdgeEnv has no cerebras fields yet. Add cerebrasApiKey + cerebrasModel
    // when executors/cerebras.ts lands. Model name below is a placeholder.
    provider: 'cerebras',
    model: () => 'llama3.1-8b',
  },
  cerebras_reasoning: {
    // TODO: EdgeEnv has no cerebras fields yet. Add cerebrasApiKey + cerebrasReasoningModel
    // when executors/cerebras.ts lands. Model name below is a placeholder.
    provider: 'cerebras',
    model: () => 'qwen-3-32b',
  },
};

// ─── Lookup Helper ────────────────────────────────────────────
// Returns null for non-LLM executors (direct, claude_code, tarotscript, composite).
// Dispatch uses the null path to keep its own branches for those cases.
export function getExecutorRoute(executor: Executor): ExecutorRoute | null {
  return (EXECUTOR_ROUTES as Record<string, ExecutorRoute>)[executor] ?? null;
}
