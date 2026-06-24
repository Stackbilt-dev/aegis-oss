import { z } from 'zod';

// ─── Provider Contract ────────────────────────────────────────
export const LLMProviderNameSchema = z.enum(['anthropic', 'cloudflare', 'groq', 'cerebras']);
export type LLMProviderName = z.infer<typeof LLMProviderNameSchema>;

// ─── Cost Tier Contract ───────────────────────────────────────
// Encodes the cost hierarchy: premium > standard > free.
// Invariant: a fallback MUST resolve to an equal or lower tier than its source.
export const ExecutorTierSchema = z.enum(['premium', 'standard', 'free']);
export type ExecutorTier = z.infer<typeof ExecutorTierSchema>;

export const TIER_ORDER: Record<ExecutorTier, number> = {
  premium: 2,
  standard: 1,
  free: 0,
};

// ─── Executor Contract ────────────────────────────────────────
export const LLMExecutorSchema = z.enum([
  'claude',
  'claude_opus',
  'gpt_oss',
  'workers_ai',
  'groq',
  'cerebras_mid',
  'cerebras_reasoning',
]);
export type LLMExecutor = z.infer<typeof LLMExecutorSchema>;

// ─── Route Shape Contract ─────────────────────────────────────
// Validates the static, serialisable portion of an ExecutorRoute.
// The `model` function is excluded — it's behavioural, not structural.
export const ExecutorRouteShapeSchema = z.object({
  provider: LLMProviderNameSchema,
  tier: ExecutorTierSchema,
  // isDefault=true: this is the nominal default executor for the dispatch
  // layer. Exactly one route may carry this flag.
  isDefault: z.literal(true).optional(),
  // placeholder=true marks a forward-declared route whose executor is not
  // yet wired. Consumers must check this flag before dispatching.
  placeholder: z.literal(true).optional(),
  // placeholder routes MUST NOT define a fallback (can't route through an
  // executor that isn't implemented).
  fallback: LLMExecutorSchema.optional(),
});
export type ExecutorRouteShape = z.infer<typeof ExecutorRouteShapeSchema>;

// ─── Domain Invariants ────────────────────────────────────────

// I1: Anthropic-provider routes must define a fallback (resilience requirement —
//     Anthropic is the most expensive tier; a provider outage must not dead-end).
export const PROVIDER_REQUIRES_FALLBACK: Partial<Record<LLMProviderName, boolean>> = {
  anthropic: true,
};

// I2: Free-tier routes are terminal — no fallback allowed.
//     (A downgrade chain can only terminate at free; going from free to free is redundant.)
export const TIER_IS_TERMINAL: Partial<Record<ExecutorTier, boolean>> = {
  free: true,
};

// I3: Placeholder routes must not have a fallback.
//     (Routing through an unimplemented executor is undefined behaviour.)
export function validatePlaceholderIsolation(shape: ExecutorRouteShape): void {
  if (shape.placeholder && shape.fallback !== undefined) {
    throw new Error(
      `Placeholder route for provider '${shape.provider}' must not define a fallback.`,
    );
  }
}

// I4: Fallback cost must be ≤ source cost (never upgrade cost on failure).
export function validateFallbackTier(
  source: ExecutorTier,
  fallbackTier: ExecutorTier,
  executorName: string,
): void {
  if (TIER_ORDER[fallbackTier] > TIER_ORDER[source]) {
    throw new Error(
      `Executor '${executorName}' fallback tier '${fallbackTier}' is more expensive than source tier '${source}'. Fallbacks must be cost-neutral or cheaper.`,
    );
  }
}

// I6: Exactly one route must be marked isDefault.
export function validateSingleDefault(routes: Record<string, { isDefault?: boolean }>): void {
  const defaults = Object.entries(routes).filter(([, r]) => r.isDefault);
  if (defaults.length !== 1) {
    throw new Error(
      `Expected exactly 1 default executor, found ${defaults.length}: ${defaults.map(([k]) => k).join(', ') || 'none'}`,
    );
  }
}

// I5: Fallback DAG must be acyclic (depth-limited DFS).
export function detectFallbackCycle(
  routes: Record<string, { fallback?: string }>,
): string | null {
  for (const start of Object.keys(routes)) {
    const visited = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (visited.has(cursor)) {
        return `Cycle detected in fallback chain starting at '${start}': revisited '${cursor}'`;
      }
      visited.add(cursor);
      cursor = routes[cursor]?.fallback;
    }
  }
  return null;
}
