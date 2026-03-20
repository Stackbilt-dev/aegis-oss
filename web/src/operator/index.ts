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

// ─── Frozen export ────────────────────────────────────────────

export const operatorConfig: Readonly<OperatorConfig> = Object.freeze(validate({ ...raw }));

// ─── Template helper ──────────────────────────────────────────

export function renderTemplate(template: string): string {
  return template
    .replace(/\{name\}/g, operatorConfig.identity.name)
    .replace(/\{possessive\}/g, operatorConfig.identity.possessive!);
}

export type { OperatorConfig };
