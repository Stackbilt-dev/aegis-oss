import { createLLMProviderFactory, type LLMProviderFactory } from '@stackbilt/llm-providers';
import type { EdgeEnv } from './dispatch.js';

// ─── Fallback ownership ──────────────────────────────────────
// EXECUTOR_ROUTES (executor-router.ts) owns the fallback policy, not this factory.
// Factory-level fallbackRules are left empty to prevent double-firing:
//   - Router fallback re-dispatches with a different *semantic executor* (different
//     model, cost ceiling, telemetry tag) and must surface actualExecutor to the
//     procedure store (see executeWithAnthropicFailover in executors/index.ts:67).
//   - A factory-level fallback would silently swap providers inside a single call,
//     bypassing actualExecutor tracking and producing wrong telemetry.
// Circuit breaker and retries operate below the executor boundary and do not
// interfere with executor-level fallback routing — they are kept enabled.

export function buildLLMProviderFactory(env: EdgeEnv): LLMProviderFactory {
  return createLLMProviderFactory({
    anthropic: {
      apiKey: env.anthropicApiKey,
      baseUrl: env.anthropicBaseUrl,
    },
    // Cloudflare Workers AI: wired when the AI binding is present.
    // The factory uses the `ai` binding directly for Workers AI inference;
    // no accountId is required for service-binding usage.
    cloudflare: env.ai ? { ai: env.ai } : undefined,
    groq: {
      apiKey: env.groqApiKey,
      baseUrl: env.groqBaseUrl || undefined,
    },
    // Cerebras: no EdgeEnv fields yet (cerebrasApiKey, cerebrasModel).
    // Add here when executors/cerebras.ts and the corresponding EdgeEnv fields land.

    fallbackRules: [],
    enableCircuitBreaker: true,
    enableRetries: true,
  });
}
