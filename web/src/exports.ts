/**
 * @stackbilt/aegis-core — Main barrel export.
 *
 * This is the primary entry point for consumers who install
 * aegis-core as a dependency. It re-exports the extension
 * interfaces, factory function, and core subsystem modules.
 *
 * Usage:
 *   import { createAegisApp, dispatch } from '@stackbilt/aegis-core';
 *
 * For deeper imports, use subpath exports:
 *   import { recordMemory } from '@stackbilt/aegis-core/kernel/memory';
 *   import { buildEdgeEnv } from '@stackbilt/aegis-core/edge-env';
 */

// ─── Factory + Extension Contracts ──────────────────────────
export {
  createAegisApp,
  type AegisApp,
  type AegisAppConfig,
  type ScheduledTaskPlugin,
  type TaskPhase,
  type ExecutorPlugin,
  type ExecutorResult,
  type RoutePlugin,
  type McpToolPlugin,
  type McpToolDefinition,
} from './core.js';

// ─── Core Types ─────────────────────────────────────────────
export type {
  // Worker bindings
  Env,
  MemoryServiceBinding,
  MemoryStoreRequest,
  MemoryStoreResult,
  MemoryRecallQuery,
  MemoryFragmentResult,
  MemoryForgetFilter,
  MemoryStatsResult,
  MessageMetadata,
} from './types.js';

export type {
  // Kernel types
  EdgeEnv,
} from './kernel/dispatch.js';

export type {
  KernelIntent,
  DispatchResult,
  Executor,
  ExecutionPlan,
  CognitiveState,
  Channel,
  EpisodicEntry,
  ProceduralEntry,
  ProceduralStatus,
  MemoryEntry,
  Refinement,
} from './kernel/types.js';

export type {
  OperatorConfig,
  Product,
  SelfModel,
} from './operator/types.js';

// ─── Dispatch ───────────────────────────────────────────────
export {
  dispatch,
  dispatchStream,
  createIntent,
} from './kernel/dispatch.js';

// ─── Memory ─────────────────────────────────────────────────
export {
  // Episodic
  recordEpisode,
  getEpisodeStats,
  getConversationHistory,
  budgetConversationHistory,
  // Procedural
  getProcedure,
  getAllProcedures,
  upsertProcedure,
  addRefinement,
  degradeProcedure,
  procedureKey,
  // Semantic
  recordMemory,
  searchMemoryByKeywords,
  recallMemory,
  getAllMemoryForContext,
  // Consolidation
  consolidateEpisodicToSemantic,
  // Pruning
  pruneMemory,
  // Insights
  publishInsight,
  validateInsight,
  promoteInsight,
  // Agenda
  getActiveAgendaItems,
  addAgendaItem,
  resolveAgendaItem,
  getAgendaContext,
  // Goals
  getActiveGoals,
  addGoal,
  updateGoalStatus,
  recordGoalAction,
  // Graph
  extractNodes,
  createEdges,
  activateGraph,
} from './kernel/memory/index.js';

// ─── Executors ──────────────────────────────────────────────
export {
  executeClaude,
  executeClaudeOpus,
  executeClaudeStream,
  executeGroq,
  executeWorkersAi,
  executeGptOss,
  executeDirect,
  executeCodeTask,
  executeTarotScript,
  executeWithAnthropicFailover,
  buildMcpRegistry,
} from './kernel/executors/index.js';

// ─── Scheduled Tasks ────────────────────────────────────────
export { runScheduledTasks } from './kernel/scheduled/index.js';

// ─── Operator ───────────────────────────────────────────────
export { operatorConfig, renderTemplate } from './operator/index.js';

// ─── Auth ───────────────────────────────────────────────────
export { bearerAuth } from './auth.js';

// ─── Edge Env ───────────────────────────────────────────────
export { buildEdgeEnv } from './edge-env.js';

// ─── MCP ────────────────────────────────────────────────────
export { handleMcpRequest } from './mcp-server.js';

// ─── Router ─────────────────────────────────────────────────
export { route } from './kernel/router.js';

// ─── Version ────────────────────────────────────────────────
export { VERSION } from './version.js';

// ─── Observability ──────────────────────────────────────────
export { InMemoryErrorTracker } from './lib/observability/errors.js';
