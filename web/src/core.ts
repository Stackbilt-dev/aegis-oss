/**
 * @stackbilt/aegis-core — Extension interfaces and app factory.
 *
 * This module defines the contracts that consumers use to extend AEGIS
 * with custom scheduled tasks, executors, routes, and MCP tools.
 *
 * Design principle: Extension Over Addition (ODD Pillar 2).
 * Consumers extend the core — they don't fork or duplicate it.
 */

import { Hono } from 'hono';
import type { Env } from './types.js';
import type { EdgeEnv } from './kernel/dispatch.js';
import type { KernelIntent, DispatchResult, Executor, CognitiveState } from './kernel/types.js';
import type { OperatorConfig, Product, SelfModel } from './operator/types.js';
import { setOperatorConfig } from './operator/index.js';
import { bearerAuth } from './auth.js';
import { runScheduledTasks } from './kernel/scheduled/index.js';

// Core route modules
import { health, setAppVersion } from './routes/health.js';
import { sessions } from './routes/sessions.js';
import { operatorLogs } from './routes/operator-logs.js';
import { feedback } from './routes/feedback.js';
import { conversations } from './routes/conversations.js';
import { observability } from './routes/observability.js';
import { pages } from './routes/pages.js';
import { ccTasks } from './routes/cc-tasks.js';
import { messages } from './routes/messages.js';
import { dynamicToolsRoutes } from './routes/dynamic-tools.js';

// ─── Scheduled Task Plugin ──────────────────────────────────
// Register custom scheduled tasks that run alongside core tasks.

export type TaskPhase = 'heartbeat' | 'cron';

export interface ScheduledTaskPlugin {
  /** Unique task name (used in task_runs table and audit chain) */
  name: string;
  /** heartbeat = runs every hour, cron = time-gated */
  phase: TaskPhase;
  /** The task implementation */
  run: (env: EdgeEnv) => Promise<void>;
  /**
   * Optional time gate for cron-phase tasks.
   * If provided, the task only runs when `new Date().getUTCHours() % frequency === 0`.
   */
  frequencyHours?: number;
  /**
   * Optional UTC hours when this task should run.
   * More precise than frequencyHours — e.g., `[8, 20]` runs at 08:00 and 20:00 UTC.
   */
  utcHours?: number[];
}

// ─── Executor Plugin ────────────────────────────────────────
// Register custom LLM executors beyond the built-in set.

export interface ExecutorResult {
  text: string;
  cost: number;
  meta?: unknown;
}

export interface ExecutorPlugin {
  /** Executor name (must not collide with built-in executors) */
  name: string;
  /** Execute a dispatch intent and return the result */
  execute: (intent: KernelIntent, env: EdgeEnv) => Promise<ExecutorResult>;
  /** Optional streaming variant — emit deltas via onDelta callback */
  stream?: (
    intent: KernelIntent,
    env: EdgeEnv,
    onDelta: (text: string) => void,
  ) => Promise<ExecutorResult>;
}

// ─── Route Plugin ───────────────────────────────────────────
// Mount additional Hono route modules onto the app.

export interface RoutePlugin {
  /** Route prefix (e.g., '/' mounts at root, '/api/bluesky' mounts under that path) */
  prefix: string;
  /** The Hono router instance. Accepts any Env superset — internal routes may have wider bindings. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router: Hono<any>;
}

// ─── MCP Tool Plugin ────────────────────────────────────────
// Register additional MCP tools beyond the core set.

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolPlugin {
  /** Tool definition (name, description, input schema) */
  definition: McpToolDefinition;
  /** Tool handler — receives parsed arguments, returns MCP tool result */
  handler: (args: Record<string, unknown>, env: EdgeEnv) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

// ─── App Configuration ──────────────────────────────────────

export interface AegisAppConfig {
  /** Override the version reported by /health (defaults to core VERSION) */
  version?: string;

  /** Operator identity and persona configuration */
  operator: OperatorConfig;

  /** Additional scheduled tasks to register alongside core tasks */
  scheduledTasks?: ScheduledTaskPlugin[];

  /** Additional executors to register */
  executors?: ExecutorPlugin[];

  /** Additional route modules to mount (after core routes) */
  routes?: RoutePlugin[];

  /** Additional MCP tools to register */
  mcpTools?: McpToolPlugin[];

  /**
   * Paths that bypass bearer auth (in addition to core public paths like /health).
   * Supports exact matches and prefix matches ending with *.
   */
  publicPaths?: string[];
}

// ─── App Factory ────────────────────────────────────────────

export interface AegisApp {
  /**
   * The composed Hono application (pass to OAuthProvider or export directly).
   * Typed as `any` bindings to allow consumers with extended Env types.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>;

  /** Run core + extension scheduled tasks. Wire to the Worker's scheduled handler. */
  // Accepts any EdgeEnv superset — consumers may add service binding fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runScheduled: (env: any) => Promise<void>;

  /** Core route instances (for consumers who want manual composition instead of the factory) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coreRoutes: Record<string, Hono<any>>;

  /** Registered executor plugins (for dispatch integration) */
  executorPlugins: Map<string, ExecutorPlugin>;

  /** Registered MCP tool plugins (for MCP server integration) */
  mcpToolPlugins: McpToolPlugin[];
}

/**
 * Create a configured AEGIS application.
 *
 * Composes core routes, auth, scheduled tasks, and extensions into a
 * deployable Worker. This is the primary entry point for consumers.
 *
 * ```ts
 * import { createAegisApp } from '@stackbilt/aegis-core';
 * import { buildEdgeEnv } from '@stackbilt/aegis-core/edge-env';
 *
 * const aegis = createAegisApp({
 *   operator: myOperatorConfig,
 *   scheduledTasks: [argusHeartbeat, contentDrip],
 *   routes: [
 *     { prefix: '/', router: blueskyRoutes },
 *     { prefix: '/', router: telegramRoutes },
 *   ],
 * });
 *
 * export default {
 *   fetch: aegis.app.fetch,
 *   scheduled: (_event, env, ctx) => {
 *     ctx.waitUntil(aegis.runScheduled(buildEdgeEnv(env, ctx)));
 *   },
 * };
 * ```
 */
export function createAegisApp(config: AegisAppConfig): AegisApp {
  // ── Operator config override ──
  // Must happen before anything else — core modules (email, dispatch, MCP tools)
  // import operatorConfig at the module level, so this sets the live binding.
  setOperatorConfig(config.operator);

  // ── Version override ──
  if (config.version) setAppVersion(config.version);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<any>();

  // ── Auth middleware ──
  app.use('*', bearerAuth);

  // ── Core routes ──
  app.route('/', health);
  app.route('/', sessions);
  app.route('/', operatorLogs);
  app.route('/', feedback);
  app.route('/', conversations);
  app.route('/', observability);
  app.route('/', pages);
  app.route('/', ccTasks);
  app.route('/', messages);
  app.route('/', dynamicToolsRoutes);

  // ── Extension routes ──
  for (const route of config.routes ?? []) {
    app.route(route.prefix, route.router);
  }

  // ── Executor registry ──
  const executorPlugins = new Map<string, ExecutorPlugin>();
  for (const plugin of config.executors ?? []) {
    executorPlugins.set(plugin.name, plugin);
  }

  // ── MCP tool registry ──
  const mcpToolPlugins = config.mcpTools ?? [];

  // ── Scheduled task composition ──
  const extensionTasks = config.scheduledTasks ?? [];

  async function runScheduled(env: EdgeEnv): Promise<void> {
    // Core scheduled tasks (heartbeat + cron phases)
    await runScheduledTasks(env);

    // Extension scheduled tasks
    const hour = new Date().getUTCHours();
    for (const task of extensionTasks) {
      if (task.utcHours && !task.utcHours.includes(hour)) continue;
      if (task.frequencyHours && hour % task.frequencyHours !== 0) continue;

      const start = Date.now();
      try {
        await task.run(env);
        await env.db.prepare(
          'INSERT INTO task_runs (task_name, status, duration_ms) VALUES (?, ?, ?)',
        ).bind(task.name, 'ok', Date.now() - start).run().catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ext:${task.phase}] ${task.name} failed:`, msg);
        await env.db.prepare(
          'INSERT INTO task_runs (task_name, status, duration_ms, error_message) VALUES (?, ?, ?, ?)',
        ).bind(task.name, 'error', Date.now() - start, msg).run().catch(() => {});
      }
    }
  }

  const coreRoutes = {
    health,
    sessions,
    operatorLogs,
    feedback,
    conversations,
    observability,
    pages,
    ccTasks,
    messages,
    dynamicTools: dynamicToolsRoutes,
  };

  return { app, runScheduled, coreRoutes, executorPlugins, mcpToolPlugins };
}

// ─── Re-export core types ───────────────────────────────────

export type {
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

export type { EdgeEnv } from './kernel/dispatch.js';

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
