/**
 * audit-chain type definitions.
 *
 * Generic, domain-agnostic types for tamper-evident audit logging.
 * D1-only mode (no R2). Hash chain provides tamper evidence.
 */

/**
 * Chain genesis sentinel -- 64 hex zeros.
 * The first record in any chain uses this as its prev_hash.
 */
export const GENESIS_HASH = '0'.repeat(64);
