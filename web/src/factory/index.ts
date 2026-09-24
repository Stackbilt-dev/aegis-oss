// @stackbilt/aegis-core/factory — sandboxed coding tasks that publish a pull
// request only after an acceptance contract passes. See docs/sandbox-executor.md.
//
// This entry point is runtime-neutral: it loads under plain Node (tests, MCP
// handlers, scripts). The Durable Object class and the Sandbox container class
// need the Workers runtime (`cloudflare:` modules) and live in
// `@stackbilt/aegis-core/factory/executor`.

export type { TaskExecutorConfig, TaskExecutorEnv } from './executor-do.js';
export { taskExecutorDispatchPlugin, runTaskExecutorDispatch } from './dispatch.js';
export { taskExecutorRoutes } from './routes.js';
export {
  DEFAULT_INSTALL_STEP,
  cloneSiblingCommand,
  type BootstrapCommand,
  type BootstrapRecipe,
} from './bootstrap.js';
export {
  defaultExternalRepoPolicy,
  externalRepoAdmissionError,
  parseTaskRepo,
  type ExternalRepoPolicy,
  type TaskAdmission,
  type TaskRepoTarget,
} from './repo.js';
export {
  acceptanceAdmissionError,
  evaluateAcceptance,
  formatAcceptanceReport,
  parseAcceptanceSpec,
  type AcceptanceSpec,
  type AcceptanceVerdict,
} from './acceptance.js';
export { SANDBOX_HARNESS_MODEL } from './harness.js';
