/**
 * Convergence Pattern Contracts
 *
 * TypeScript structural contracts for patterns in the Stackbilt convergence
 * catalog (docs/routines/convergence-patterns.md in aegis-daemon). These are
 * compile-time-only artifacts — no runtime code.
 *
 * Intended use: tag an implementation by assigning an object satisfying the
 * interface to a const (optionally unused):
 *
 *   import type { PositionalDispatch } from '@stackbilt/aegis-core/kernel/patterns';
 *   const _p1: PositionalDispatch<KernelIntent, Executor, ExecFn> = { classify, select };
 *
 * The convergence-thesis routine uses PATTERN_ID constants as catalog keys.
 * Consumer repos that implement a mirrored version import the interface and
 * write a structural-compat test pinning the shapes (see P5 contract-mirroring
 * for the full discipline).
 */

// ─── P1: Positional Dispatch ─────────────────────────────────────────────────

export const POSITIONAL_DISPATCH_PATTERN_ID = 'positional-dispatch' as const;
export const POSITIONAL_DISPATCH_CONTRACT_VERSION = '1.0.0';

/**
 * P1: Positional Dispatch
 *
 * Input acquires meaning through context; a pattern match on the
 * contextualized input selects the handler. The two-phase structure
 * (classify → select) is the invariant. Specific type shapes are
 * consumer-defined.
 *
 * Canonical implementation: aegis kernel/dispatch.ts + kernel/router.ts
 *   - classify: route(intent, env) → ExecutionPlan (executor = classification)
 *   - select:   switch(plan.executor) → executor function
 *
 * Known mirrors:
 *   - tarotscript spread-selector.ts: detectMode(intent) + selectSpread(mode)
 *   - charter command router: command + project-type context → rule selection
 */
export interface PositionalDispatch<TInput, TClassification, THandler> {
  /** Assigns a classification to raw input, optionally using captured context */
  classify(input: TInput): TClassification | Promise<TClassification>;
  /** Maps a classification to the appropriate handler */
  select(classification: TClassification): THandler;
}

// ─── P7: Tiered Execution ────────────────────────────────────────────────────

export const TIERED_EXECUTION_PATTERN_ID = 'tiered-execution' as const;
export const TIERED_EXECUTION_CONTRACT_VERSION = '1.0.0';

/**
 * P7: Tiered Execution
 *
 * Tasks are routed to one of several ordered execution tiers based on
 * resource cost, reasoning depth, and budget constraints. The tier selection
 * function maps task characteristics to a tier; the executor runs the
 * tier-appropriate implementation with budget enforcement.
 *
 * Canonical implementation: aegis kernel/dispatch.ts
 *   - selectTier:  SHADOW_DEMOTION map + cost ceiling → Executor tier
 *   - execute:     executor switch → execute* function
 *
 * Known mirrors:
 *   - llm-providers factory.ts: getPrioritizedProviders() + buildProviderChain()
 *   - tarotscript spread-selector.ts: complexity → spread depth
 *
 * Extraction candidate: a shared cost-aware routing primitive (see #230).
 */
export interface TieredExecution<TInput, TTier extends string, TResult> {
  /** Maps task characteristics to an execution tier */
  selectTier(input: TInput): TTier;
  /** Executes using the selected tier, with budget/capacity enforcement */
  execute(tier: TTier, input: TInput): TResult | Promise<TResult>;
}
