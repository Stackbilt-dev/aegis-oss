/**
 * Resilience primitives — circuit breakers, cost tracking, retry/fallback
 * combinators. Delegates to @stackbilt/llm-providers for breaker + cost
 * singletons shared across a process.
 *
 * Core exports primitives + a factory (`createResilience`) that instantiates
 * a cost-tracker / ledger / circuit-registry triple with consumer-specified
 * budgets. Module-level singletons live in consumers (e.g. the daemon), not
 * here — core is generic and doesn't know anyone's monthly budget.
 *
 * Exhaustion tracking uses llm-providers' `defaultExhaustionRegistry` —
 * one global exhaustion state per process is correct (rate limits are a
 * global property of the upstream provider, not per-consumer).
 *
 * Usage (consumer):
 *   import { createResilience, withRetry, withFallback, resilient } from '@stackbilt/aegis-core/kernel/resilience';
 *   const { circuits, costs, ledger } = createResilience({
 *     budgets: [{ provider: 'anthropic', monthlyBudget: 20 }],
 *   });
 *   const result = await circuits.exec('groq', () => askGroq(...));
 */

import {
  CircuitBreakerManager,
  CircuitBreakerOpenError,
  defaultCircuitBreakerManager,
  CostTracker as LlmCostTracker,
  CreditLedger,
  QuotaExceededError,
  RateLimitError,
  LLMProviderError,
  ExhaustionRegistry,
  defaultExhaustionRegistry,
  noopHooks,
  composeHooks,
  defaultLatencyHistogram,
} from '@stackbilt/llm-providers';
import type {
  CircuitBreakerConfig as LlmCircuitBreakerConfig,
  CircuitBreakerState,
  LLMResponse,
  CreditLedgerSnapshot,
  LedgerEvent,
  ObservabilityHooks,
  LatencyHistogram,
} from '@stackbilt/llm-providers';

// ─── Re-exports ─────────────────────────────────────────────
// Consumers import from here, not from llm-providers directly.

export { CircuitBreakerOpenError, QuotaExceededError, RateLimitError, LLMProviderError };
export { ExhaustionRegistry, defaultExhaustionRegistry, noopHooks, composeHooks, defaultLatencyHistogram };
export type { CircuitBreakerState, ObservabilityHooks, LatencyHistogram, LedgerEvent, CreditLedgerSnapshot };
export { CreditLedger };

// Keep the AEGIS-native config shape. Property names differ from llm-providers
// (resetTimeoutMs vs resetTimeout) for readability at call sites — the adapter
// below maps them internally.
export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  windowMs: number;
  minRequests: number;
  degradationCurve: number[];
}

export type CircuitState = 'CLOSED' | 'DEGRADED' | 'OPEN' | 'RECOVERING';

function adaptConfig(cfg?: Partial<CircuitBreakerConfig>): Partial<LlmCircuitBreakerConfig> | undefined {
  if (!cfg) return undefined;
  return {
    failureThreshold: cfg.failureThreshold,
    resetTimeout: cfg.resetTimeoutMs,
    monitoringPeriod: cfg.windowMs,
    minRequests: cfg.minRequests,
    degradationCurve: cfg.degradationCurve,
  };
}

/** Backwards-compatible alias (pre-llm-providers name). */
export const CircuitOpenError = CircuitBreakerOpenError;

// ─── Circuit Registry ───────────────────────────────────────

export class CircuitRegistry {
  private readonly mgr: CircuitBreakerManager;
  constructor(mgr: CircuitBreakerManager) { this.mgr = mgr; }

  get(name: string, config?: Partial<CircuitBreakerConfig>) {
    return this.mgr.getBreaker(name, adaptConfig(config));
  }

  async exec<T>(name: string, op: () => Promise<T>, config?: Partial<CircuitBreakerConfig>): Promise<T> {
    return this.mgr.execute(name, op, adaptConfig(config));
  }

  async execWithFallback<T>(
    name: string,
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
    config?: Partial<CircuitBreakerConfig>,
  ): Promise<T> {
    return this.mgr.execWithFallback(name, primary, fallback, adaptConfig(config));
  }

  allStats() {
    return this.mgr.getHealthStatus();
  }

  resetAll() {
    this.mgr.resetAll();
  }
}

// ─── Cost Tracker ───────────────────────────────────────────

export interface ProviderCostEntry {
  totalCost: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  lastRecordedAt: number;
}

export class AegisCostTracker {
  private readonly tracker: LlmCostTracker;
  private readonly ledgerRef: CreditLedger;

  constructor(tracker: LlmCostTracker, ledger: CreditLedger) {
    this.tracker = tracker;
    this.ledgerRef = ledger;
  }

  /** Record a cost event with raw numbers (AEGIS call pattern). */
  record(provider: string, cost: number, inputTokens = 0, outputTokens = 0): void {
    this.tracker.trackCost(provider, {
      message: '',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost },
      model: '',
      provider,
      responseTime: 0,
    } as LLMResponse);
  }

  breakdown(): Record<string, ProviderCostEntry> {
    return this.tracker.breakdown();
  }

  total(): number {
    return this.tracker.total();
  }

  /** Drain and reset — for periodic reporting. */
  drain(): Record<string, ProviderCostEntry> {
    return this.tracker.drain();
  }

  getLedger(): CreditLedger {
    return this.ledgerRef;
  }
}

// ─── Exhaustion Tracking ────────────────────────────────────
// Delegates to llm-providers' defaultExhaustionRegistry — one global
// exhaustion state per process is correct (provider rate limits are
// upstream-global, not per-consumer).

export function markProviderExhausted(provider: string): void {
  defaultExhaustionRegistry.markExhausted(provider);
  console.warn(`[resilience] Provider ${provider} marked as quota-exhausted`);
}

export function isProviderExhausted(provider: string): boolean {
  return defaultExhaustionRegistry.isExhausted(provider);
}

// ─── Retry with Exponential Backoff ─────────────────────────

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: number; // 0–1 fraction
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  backoffMultiplier: 2,
  jitter: 0.15,
};

export async function withRetry<T>(
  op: () => Promise<T>,
  config?: Partial<RetryConfig>,
  label?: string,
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...config };
  let lastErr: unknown;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const retryable = cfg.shouldRetry ? cfg.shouldRetry(err, attempt) : isRetryable(err);
      if (!retryable || attempt === cfg.maxAttempts) throw err;

      const delay = Math.min(
        cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt - 1),
        cfg.maxDelayMs,
      );
      const jitteredDelay = Math.floor(delay + delay * cfg.jitter * Math.random());

      console.warn(`[retry] ${label ?? 'op'} attempt ${attempt}/${cfg.maxAttempts} failed, retrying in ${jitteredDelay}ms`);
      await sleep(jitteredDelay);
    }
  }

  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof CircuitBreakerOpenError) return false;
  if (err instanceof QuotaExceededError) return false;
  if (err instanceof LLMProviderError) return err.retryable;
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes('timeout') || m.includes('network') || m.includes('503') || m.includes('502')
    || m.includes('rate') || m.includes('429') || m.includes('econnreset')
    || m.includes('temporarily') || m.includes('overloaded');
}

// ─── Fallback ───────────────────────────────────────────────

export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  shouldFallback?: (err: unknown) => boolean,
): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    if (shouldFallback && !shouldFallback(err)) throw err;
    console.warn(`[fallback] primary failed, trying fallback: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    return fallback();
  }
}

// ─── Combined: Circuit + Retry + Fallback ───────────────────

export async function resilient<T>(
  service: string,
  op: () => Promise<T>,
  opts: {
    circuits: CircuitRegistry;
    fallback?: () => Promise<T>;
    retry?: Partial<RetryConfig>;
    circuit?: Partial<CircuitBreakerConfig>;
  },
): Promise<T> {
  const retryOp = () => withRetry(op, opts.retry, service);

  if (opts.fallback) {
    return opts.circuits.execWithFallback(service, retryOp, opts.fallback, opts.circuit);
  }
  return opts.circuits.exec(service, retryOp, opts.circuit);
}

// ─── Factory ────────────────────────────────────────────────
// Instantiates the circuit/cost/ledger triple with consumer-specified
// budgets. Wires the ledger event listener inside the factory so core's
// module load has no side effects — only consumers that call the factory
// subscribe to budget events.

export interface ResilienceBudget {
  provider: string;
  monthlyBudget: number;
}

export interface ResilienceConfig {
  budgets: ResilienceBudget[];
  /** Override behavior when emergency budget threshold is crossed. Default: markProviderExhausted. */
  onEmergencyBudget?: (provider: string) => void;
}

export interface ResilienceBundle {
  circuits: CircuitRegistry;
  costs: AegisCostTracker;
  ledger: CreditLedger;
}

export function createResilience(config: ResilienceConfig): ResilienceBundle {
  const ledger = new CreditLedger({ budgets: config.budgets });
  const costs = new AegisCostTracker(new LlmCostTracker({}, ledger), ledger);
  const circuits = new CircuitRegistry(defaultCircuitBreakerManager);

  const onEmergency = config.onEmergencyBudget ?? markProviderExhausted;

  ledger.on((event: LedgerEvent) => {
    if (event.type === 'threshold_crossed') {
      const pct = (event.utilizationPct * 100).toFixed(0);
      console.warn(`[ledger] ${event.provider} budget ${event.tier}: ${pct}% utilized ($${event.spend.toFixed(2)}/$${event.budget.toFixed(2)})`);
      if (event.tier === 'emergency') {
        onEmergency(event.provider);
      }
    } else if (event.type === 'depletion_projected') {
      console.warn(`[ledger] ${event.provider} depletion ${event.tier}: ~${event.daysRemaining.toFixed(1)} days remaining at $${event.burnRate.costPerDay.toFixed(2)}/day`);
    }
  });

  return { circuits, costs, ledger };
}

// ─── Util ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
