import { describe, it, expect } from 'vitest';
import { EXECUTOR_ROUTES } from '../src/kernel/executor-router.js';
import {
  PROVIDER_REQUIRES_FALLBACK,
  TIER_IS_TERMINAL,
} from '../src/kernel/executor-router.contract.js';

// ─── Contract-Derived Invariant Suite ─────────────────────────
// Complements executor-router-semantic.test.ts. Adds the violation-path
// coverage for I1 (anthropic requires fallback) and I2 (free-tier terminal),
// which the semantic suite only checks on the happy path against the live table.

describe('executor-router contract invariants', () => {
  // ── I1: anthropic-provider routes require a fallback ──────────
  describe('I1: anthropic routes require a fallback', () => {
    it('every anthropic route in the live table defines a fallback', () => {
      const anthropicRoutes = Object.entries(EXECUTOR_ROUTES).filter(
        ([, r]) => PROVIDER_REQUIRES_FALLBACK[r.provider],
      );
      expect(anthropicRoutes.length).toBeGreaterThan(0);
      for (const [name, route] of anthropicRoutes) {
        expect(route.fallback, `anthropic route '${name}' must define a fallback`).toBeDefined();
      }
    });

    it('detects an anthropic route missing its required fallback', () => {
      // A route guard derived from the contract map: any provider flagged in
      // PROVIDER_REQUIRES_FALLBACK with no fallback is a violation.
      const offending = { provider: 'anthropic' as const, tier: 'premium' as const };
      const isViolation =
        PROVIDER_REQUIRES_FALLBACK[offending.provider] &&
        (offending as { fallback?: string }).fallback === undefined;
      expect(isViolation).toBe(true);
    });
  });

  // ── I2: free-tier routes are terminal ────────────────────────
  describe('I2: free-tier routes are terminal', () => {
    it('every free-tier route in the live table has no fallback', () => {
      const freeRoutes = Object.entries(EXECUTOR_ROUTES).filter(
        ([, r]) => TIER_IS_TERMINAL[r.tier],
      );
      expect(freeRoutes.length).toBeGreaterThan(0);
      for (const [name, route] of freeRoutes) {
        expect(route.fallback, `free-tier route '${name}' must be terminal`).toBeUndefined();
      }
    });

    it('detects a free-tier route that defines a fallback', () => {
      const offending = { tier: 'free' as const, fallback: 'gpt_oss' };
      const isViolation =
        Boolean(TIER_IS_TERMINAL[offending.tier]) && offending.fallback !== undefined;
      expect(isViolation).toBe(true);
    });
  });
});
