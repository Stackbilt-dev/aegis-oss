import type { OperatorConfig } from './types.js';
import raw from './config.js';

// ─── Validation ───────────────────────────────────────────────

function validate(cfg: OperatorConfig): OperatorConfig {
  if (!cfg.identity?.name) throw new Error('operator config: identity.name is required');
  if (!cfg.persona?.tagline) throw new Error('operator config: persona.tagline is required');
  if (!cfg.persona?.traits?.length) throw new Error('operator config: persona.traits must have at least one entry');

  // Auto-derive possessive if not provided
  if (!cfg.identity.possessive) {
    cfg.identity.possessive = cfg.identity.name.endsWith('s')
      ? `${cfg.identity.name}'`
      : `${cfg.identity.name}'s`;
  }

  return cfg;
}

// ─── Mutable config singleton ─────────────────────────────────
// Starts with the core default config. Consumers override via
// setOperatorConfig() — called by createAegisApp() — so that all
// internal modules (email, dispatch, MCP tools) pick up the
// consumer's real addresses instead of the core's example.com defaults.

// eslint-disable-next-line import/no-mutable-exports
export let operatorConfig: Readonly<OperatorConfig> = Object.freeze(validate({ ...raw }));

/**
 * Override the operator config at app startup.
 * Must be called before any scheduled tasks or route handlers run.
 */
export function setOperatorConfig(cfg: OperatorConfig): void {
  operatorConfig = Object.freeze(validate({ ...cfg }));
}

// ─── Template helper ──────────────────────────────────────────

export function renderTemplate(template: string): string {
  return template
    .replace(/\{name\}/g, operatorConfig.identity.name)
    .replace(/\{possessive\}/g, operatorConfig.identity.possessive!);
}

export type { OperatorConfig };
