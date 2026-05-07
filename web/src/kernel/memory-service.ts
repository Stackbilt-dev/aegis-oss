/**
 * MemoryService — unified facade over the memory tiers (episodic,
 * procedural, semantic, insights) + goals. Phase 1B of the god-object
 * decomposition epic (aegis#532 / aegis#534).
 *
 * Why: the audit flagged that dispatch, self-improvement, ambient-capture
 * each reach into memory/*.ts and memory-adapter.ts directly, repeating
 * the `{db, memoryBinding}` threading and obscuring which tier each call
 * actually hits. This service hands callers one object and hides the
 * backing-store distinction.
 *
 * Tier → backing store:
 *   - episodic, procedural, insights, goals → D1 (env.db)
 *   - semantic, context-recall → memory-worker (env.memoryBinding) via
 *     memory-adapter (aegis-core re-export)
 *
 * Prefer this over the raw tier functions in new code. Existing callers
 * migrate incrementally — Phase 2/3 decomps will naturally fold the rest
 * as those files get broken up.
 */
import {
  recordEpisode as _recordEpisode,
  retrogradeEpisode as _retrogradeEpisode,
  getRecentEpisodes as _getRecentEpisodes,
  getEpisodeStatsByComplexity as _getEpisodeStatsByComplexity,
  upsertProcedure as _upsertProcedure,
  getProcedure as _getProcedure,
  getProcedureWithDerivedStats as _getProcedureWithDerivedStats,
  getAllProceduresWithDerivedStats as _getAllProceduresWithDerivedStats,
  type DriftLogOpts,
  addRefinement as _addRefinement,
  degradeProcedure as _degradeProcedure,
  findNearMiss as _findNearMiss,
  recordGapSignal as _recordGapSignal,
  clearGapSignal as _clearGapSignal,
  publishInsight as _publishInsight,
  validateInsight as _validateInsight,
  recordGoalAction as _recordGoalAction,
  type InsightPayload,
  type ValidationStage,
  type AgentAction,
} from './memory/index.js';
import {
  recordMemory as _recordMemoryViaAdapter,
  searchMemoryByKeywords as _searchMemoryByKeywordsViaAdapter,
  getAllMemoryForContext as _getAllMemoryForContextViaAdapter,
} from './memory-adapter.js';
import type { MemoryServiceBinding } from '../types.js';
import type { EpisodicEntry, ProceduralEntry, Refinement } from './types.js';

export type { ValidationStage, InsightPayload };

export interface DispatchOutcomeArgs {
  episode: Omit<EpisodicEntry, 'id' | 'created_at'>;
  procedureKey: string;
  executor: string;
  executorConfig: string;
  outcome: 'success' | 'failure' | 'partial_failure';
  latencyMs: number;
  cost: number;
  /** Optional refinement log — added when a replan promotes a degraded procedure. */
  refinement?: Refinement;
}

export interface GoalActionOpts {
  autoExecuted?: boolean;
  authorityLevel?: string;
  toolCalled?: string;
  toolArgsJson?: string;
  toolResultJson?: string;
}

export class MemoryService {
  constructor(
    private readonly db: D1Database,
    private readonly memoryBinding?: MemoryServiceBinding,
  ) {}

  // ─── Episodic ──────────────────────────────────────────────

  recordEpisode(entry: Omit<EpisodicEntry, 'id' | 'created_at'>): Promise<void> {
    return _recordEpisode(this.db, entry);
  }

  retrogradeEpisode(threadId: string): Promise<EpisodicEntry | null> {
    return _retrogradeEpisode(this.db, threadId);
  }

  getRecentEpisodes(intentClass: string, limit = 5): Promise<EpisodicEntry[]> {
    return _getRecentEpisodes(this.db, intentClass, limit);
  }

  // aegis#563: aggregates keyed by (intent_class, complexity_tier), matching
  // procedural_memory's procedureKey shape. Foundation for the #564
  // projection-vs-cache decomposition.
  getEpisodeStatsByComplexity(intentClass: string, complexityTier: string) {
    return _getEpisodeStatsByComplexity(this.db, intentClass, complexityTier);
  }

  // ─── Procedural ────────────────────────────────────────────

  upsertProcedure(
    taskPattern: string,
    executor: string,
    executorConfig: string,
    outcome: 'success' | 'failure' | 'partial_failure',
    latencyMs: number,
    cost: number,
  ): Promise<void> {
    return _upsertProcedure(this.db, taskPattern, executor, executorConfig, outcome, latencyMs, cost);
  }

  getProcedure(taskPattern: string): Promise<ProceduralEntry | null> {
    return _getProcedure(this.db, taskPattern);
  }

  // aegis#564 Phase 1 — callers that read the five cached aggregate
  // columns (success_count, fail_count, avg_latency_ms, avg_cost,
  // last_used) should route through this helper. Phase 1 is a pass-
  // through; Phase 2 adds shadow-read logging; Phase 3 flips to derived.
  getProcedureWithDerivedStats(taskPattern: string, opts?: DriftLogOpts): Promise<ProceduralEntry | null> {
    return _getProcedureWithDerivedStats(this.db, taskPattern, opts);
  }

  getAllProceduresWithDerivedStats(opts?: DriftLogOpts): Promise<ProceduralEntry[]> {
    return _getAllProceduresWithDerivedStats(this.db, opts);
  }

  addRefinement(taskPattern: string, refinement: Refinement): Promise<void> {
    return _addRefinement(this.db, taskPattern, refinement);
  }

  degradeProcedure(taskPattern: string, executor: string): Promise<void> {
    return _degradeProcedure(this.db, taskPattern, executor);
  }

  findNearMiss(taskPattern: string) {
    return _findNearMiss(this.db, taskPattern);
  }

  recordGapSignal(taskPattern: string): Promise<void> {
    return _recordGapSignal(this.db, taskPattern);
  }

  clearGapSignal(taskPattern: string): Promise<void> {
    return _clearGapSignal(this.db, taskPattern);
  }

  // ─── Semantic (memory-worker via adapter) ──────────────────

  async recordMemory(
    topic: string,
    fact: string,
    confidence: number,
    source: string,
    metadata?: Record<string, unknown>,
  ) {
    this.requireBinding('recordMemory');
    return _recordMemoryViaAdapter(this.memoryBinding!, topic, fact, confidence, source, metadata);
  }

  async searchMemory(query: string, limit?: number) {
    this.requireBinding('searchMemory');
    return _searchMemoryByKeywordsViaAdapter(this.memoryBinding!, query, limit);
  }

  async getMemoryForContext(query?: string) {
    this.requireBinding('getMemoryForContext');
    return _getAllMemoryForContextViaAdapter(this.memoryBinding!, query);
  }

  // ─── Insights ──────────────────────────────────────────────

  publishInsight(payload: InsightPayload) {
    return _publishInsight(this.db, payload, this.memoryBinding);
  }

  validateInsight(factHash: string, validatingRepo: string, confirmed: boolean) {
    return _validateInsight(this.db, factHash, validatingRepo, confirmed);
  }

  // ─── Goals ─────────────────────────────────────────────────

  recordGoalAction(
    goalId: string | null,
    actionType: AgentAction['action_type'],
    description: string,
    outcome: AgentAction['outcome'] = 'success',
    opts?: GoalActionOpts,
  ): Promise<void> {
    return _recordGoalAction(this.db, goalId, actionType, description, outcome, opts);
  }

  // ─── Domain: dispatch outcome bookkeeping ──────────────────

  /**
   * Record a dispatch outcome: episode + procedural upsert, plus an
   * optional refinement log when a replan happens on a degraded procedure.
   * Collapses the three-call pattern that dispatch.recordOutcome carries
   * inline.
   */
  async recordDispatchOutcome(args: DispatchOutcomeArgs): Promise<void> {
    // aegis#563: enrich episode with complexity_tier (derived from
    // procedureKey = `classification:complexity_tier`) and executor_config
    // snapshot. Caller-supplied values win; otherwise derive from args so
    // dispatcher call sites don't need to pass these explicitly.
    const tierFromKey = args.procedureKey.includes(':')
      ? args.procedureKey.slice(args.procedureKey.indexOf(':') + 1)
      : null;
    const enrichedEpisode: Omit<EpisodicEntry, 'id' | 'created_at'> = {
      ...args.episode,
      complexity_tier: args.episode.complexity_tier ?? tierFromKey,
      executor_config: args.episode.executor_config ?? args.executorConfig,
    };

    await _recordEpisode(this.db, enrichedEpisode);
    await _upsertProcedure(
      this.db,
      args.procedureKey,
      args.executor,
      args.executorConfig,
      args.outcome,
      args.latencyMs,
      args.cost,
    );
    if (args.refinement) {
      await _addRefinement(this.db, args.procedureKey, args.refinement);
    }
  }

  // ─── Internal ──────────────────────────────────────────────

  private requireBinding(method: string): void {
    if (!this.memoryBinding) {
      throw new Error(
        `[memory-service] ${method}() requires memoryBinding — constructor received none`,
      );
    }
  }
}

/**
 * Factory: construct a MemoryService from any env-shape carrying
 * `db` and (optionally) `memoryBinding`. The daemon's EdgeEnv satisfies
 * this shape; scheduled tasks and tests can pass a narrower object.
 */
export function memoryServiceFor(env: {
  db: D1Database;
  memoryBinding?: MemoryServiceBinding;
}): MemoryService {
  return new MemoryService(env.db, env.memoryBinding);
}
