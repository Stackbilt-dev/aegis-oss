import { describe, it, expect } from 'vitest';
import { EXECUTOR_ROUTES, getExecutorRoute } from '../src/kernel/executor-router.js';
import {
  ExecutorRouteShapeSchema,
  LLMExecutorSchema,
  TIER_ORDER,
  PROVIDER_REQUIRES_FALLBACK,
  TIER_IS_TERMINAL,
  validatePlaceholderIsolation,
  validateFallbackTier,
  validateSingleDefault,
  detectFallbackCycle,
} from '../src/kernel/executor-router.contract.js';

// ─── Semantic Contract Suite ──────────────────────────────────

describe('executor-router semantic contract', () => {
  // ── S1: Structural parse ──────────────────────────────────
  it('every route satisfies ExecutorRouteShapeSchema', () => {
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      const result = ExecutorRouteShapeSchema.safeParse(route);
      expect(result.success, `Route '${name}' failed schema: ${JSON.stringify((result as any).error?.issues)}`).toBe(true);
    }
  });

  // ── S2: Acyclic DAG ───────────────────────────────────────
  it('fallback chains contain no cycles', () => {
    const cycle = detectFallbackCycle(EXECUTOR_ROUTES);
    expect(cycle).toBeNull();
  });

  // ── S3: Fallback cost downgrade ───────────────────────────
  it('fallback tier is always ≤ source tier (never upgrades cost)', () => {
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      if (!route.fallback) continue;
      const fallbackRoute = EXECUTOR_ROUTES[route.fallback as keyof typeof EXECUTOR_ROUTES];
      expect(fallbackRoute, `Fallback '${route.fallback}' for '${name}' is not in EXECUTOR_ROUTES`).toBeDefined();
      expect(
        TIER_ORDER[fallbackRoute.tier],
        `Executor '${name}' (${route.tier}) fallback '${route.fallback}' (${fallbackRoute.tier}) is a cost upgrade`,
      ).toBeLessThanOrEqual(TIER_ORDER[route.tier]);
    }
  });

  // ── S4: Anthropic resilience ──────────────────────────────
  it('all anthropic-provider routes define a fallback', () => {
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      if (!PROVIDER_REQUIRES_FALLBACK[route.provider]) continue;
      expect(
        route.fallback,
        `Anthropic-provider executor '${name}' must define a fallback for provider outage resilience`,
      ).toBeDefined();
    }
  });

  // ── S5: Placeholder isolation ─────────────────────────────
  it('placeholder routes do not define a fallback', () => {
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      if (!route.placeholder) continue;
      expect(
        route.fallback,
        `Placeholder route '${name}' must not define a fallback`,
      ).toBeUndefined();
    }
  });

  // ── S6: Free-tier routes are terminal ─────────────────────
  it('free-tier routes define no fallback', () => {
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      if (!TIER_IS_TERMINAL[route.tier]) continue;
      expect(
        route.fallback,
        `Free-tier executor '${name}' is terminal and must not define a fallback`,
      ).toBeUndefined();
    }
  });

  // ── S7: Fallback targets are valid LLM executors ──────────
  it('all fallback targets are registered LLM executors', () => {
    const validExecutors = new Set(LLMExecutorSchema.options);
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      if (!route.fallback) continue;
      expect(
        validExecutors.has(route.fallback),
        `Executor '${name}' fallback '${route.fallback}' is not a valid LLM executor`,
      ).toBe(true);
      // Must also be in EXECUTOR_ROUTES (not just the type union)
      expect(
        getExecutorRoute(route.fallback as any),
        `Fallback '${route.fallback}' for '${name}' has no route entry`,
      ).not.toBeNull();
    }
  });

  // ── S8: Domain helpers enforce invariants ─────────────────
  it('validatePlaceholderIsolation throws when placeholder has fallback', () => {
    expect(() =>
      validatePlaceholderIsolation({ provider: 'cerebras', tier: 'standard', placeholder: true, fallback: 'workers_ai' }),
    ).toThrow();
  });

  it('validatePlaceholderIsolation is silent when no fallback', () => {
    expect(() =>
      validatePlaceholderIsolation({ provider: 'cerebras', tier: 'standard', placeholder: true }),
    ).not.toThrow();
  });

  it('validateFallbackTier throws on cost upgrade', () => {
    expect(() => validateFallbackTier('free', 'premium', 'test-executor')).toThrow();
  });

  it('validateFallbackTier is silent on cost-neutral or downgrade', () => {
    expect(() => validateFallbackTier('premium', 'standard', 'claude')).not.toThrow();
    expect(() => validateFallbackTier('premium', 'free', 'claude')).not.toThrow();
    expect(() => validateFallbackTier('standard', 'standard', 'groq')).not.toThrow();
  });

  // ── S9: Single default ────────────────────────────────────
  it('exactly one executor is marked isDefault', () => {
    const defaults = Object.entries(EXECUTOR_ROUTES).filter(([, r]) => r.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0][0]).toBe('workers_ai');
  });

  it('validateSingleDefault passes on the live route table', () => {
    expect(() => validateSingleDefault(EXECUTOR_ROUTES)).not.toThrow();
  });

  it('validateSingleDefault throws when no default is set', () => {
    expect(() => validateSingleDefault({ a: {}, b: {} })).toThrow(/Expected exactly 1/);
  });

  it('validateSingleDefault throws when multiple defaults are set', () => {
    expect(() => validateSingleDefault({ a: { isDefault: true }, b: { isDefault: true } })).toThrow(/Expected exactly 1/);
  });

  // ── S10: Default executor model is env-configurable ───────
  it('workers_ai model reads from env.workersAiModel override', () => {
    const overrideModel = '@cf/moonshotai/kimi-k2.6';
    const result = EXECUTOR_ROUTES.workers_ai.model({ workersAiModel: overrideModel } as any);
    expect(result).toBe(overrideModel);
  });

  it('workers_ai model falls back to llama-3.3-70b when env has no override', () => {
    const result = EXECUTOR_ROUTES.workers_ai.model({} as any);
    expect(result).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  });

  it('detectFallbackCycle returns null for the live route table', () => {
    expect(detectFallbackCycle(EXECUTOR_ROUTES)).toBeNull();
  });

  it('detectFallbackCycle detects an introduced cycle', () => {
    const cyclic = {
      a: { fallback: 'b' },
      b: { fallback: 'c' },
      c: { fallback: 'a' },
    };
    expect(detectFallbackCycle(cyclic)).not.toBeNull();
  });
});
