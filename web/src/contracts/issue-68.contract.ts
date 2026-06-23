// AUTO-GENERATED BLUEPRINT — Do not implement. Operator approval required.
// Issue: Stackbilt-dev/aegis-oss#68
// Feature: WasmGraph spreading activation via @stackbilt/wasm-core

import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Entity Schemas
// ---------------------------------------------------------------------------

/**
 * Shape of a single node row returned by the bulk D1 SELECT on kg_nodes.
 * Mirrors the columns consumed by activateGraph(); only these columns are
 * passed to WASM — no extra D1 columns cross the boundary.
 */
export const NodeRowSchema = z.object({
  /** D1 rowid — must be unique within a snapshot. */
  id: z.number().int().positive(),
  /** Human-readable label used for seed-query keyword matching. */
  label: z.string().min(1),
  // BLUEPRINT: node_type is an enum; kept as z.enum to allow exhaustive
  // pattern-matching in Rust via serde without an "unknown" arm.
  node_type: z.enum([
    'person',
    'project',
    'tool',
    'decision',
    'event',
    'pattern',
    'concept',
  ]),
  /**
   * Per-node stored activation (0.0–1.0). Used as seed weight when a node
   * matches the query; otherwise the BFS decay updates it during traversal.
   */
  activation: z.number().min(0).max(1),
});

export type NodeRow = z.infer<typeof NodeRowSchema>;

/**
 * Shape of a single edge row returned by the bulk D1 SELECT on kg_edges.
 * Only the three columns required for BFS traversal are included.
 */
export const EdgeRowSchema = z.object({
  // BLUEPRINT: source_id / target_id reference NodeRow.id; referential
  // integrity is enforced by the snapshotInvariants below, not the schema,
  // because Zod cannot cross-validate across two arrays cheaply.
  source_id: z.number().int().positive(),
  target_id: z.number().int().positive(),
  /** Decay multiplier per hop (0.0–1.0). */
  weight: z.number().min(0).max(1),
});

export type EdgeRow = z.infer<typeof EdgeRowSchema>;

/**
 * Output shape returned by WasmGraph.spreadActivation().
 * Matches the existing ActivatedNode interface at graph.ts lines 189–193
 * exactly — field names, types, and count are frozen to preserve the public
 * activateGraph() signature.
 */
export const ActivatedNodeSchema = z.object({
  label: z.string(),
  // BLUEPRINT: `type` is string (not the NodeType enum) to match the existing
  // interface; Rust serialises the enum variant as a plain string.
  type: z.string(),
  /** Final activation score after BFS + decay; 0.05–1.0 (pruned below 0.05). */
  activation: z.number().min(0).max(1),
});

export type ActivatedNode = z.infer<typeof ActivatedNodeSchema>;

/**
 * The combined input object JS assembles from two bulk D1 SELECTs and passes
 * to WasmGraph.fromSnapshotArrays(). This is the full in-memory graph
 * representation — WASM receives no other data source.
 */
export const GraphSnapshotSchema = z.object({
  nodes: z.array(NodeRowSchema),
  edges: z.array(EdgeRowSchema),
});

export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

/**
 * Options forwarded from the JS caller into the WASM BFS solver.
 * Both fields are optional; WASM fills defaults from ACTIVATION_INVARIANTS
 * when absent.
 */
export const SpreadActivationOptsSchema = z.object({
  // BLUEPRINT: hops is nullable so JS can forward `undefined` from the
  // existing activateGraph(db, query, hops?) parameter without coercing it.
  hops: z.number().int().min(1).optional(),
  // BLUEPRINT: topK is separate from hops so callers can tune result size
  // independently of traversal depth (e.g. hops=3, topK=5).
  topK: z.number().int().min(1).optional(),
});

export type SpreadActivationOpts = z.infer<typeof SpreadActivationOptsSchema>;

// ---------------------------------------------------------------------------
// 2. WASM Module Contract
// ---------------------------------------------------------------------------

/**
 * Represents the live WASM struct in linear memory.
 * Obtained by calling WasmGraphContract.fromSnapshotArrays(); immutable
 * once constructed — no mutation methods are exposed.
 *
 * LIFECYCLE: the adjacency list and node index live in WASM linear memory.
 * Callers MUST call free() when done. Failing to do so leaks the allocation
 * for the lifetime of the WASM module instance.
 */
export interface WasmGraph {
  /**
   * Run the spreading-activation BFS from seed nodes matched by seedQuery.
   * Pure: calling this multiple times with the same arguments returns the
   * same result. Does not mutate the WasmGraph instance.
   */
  spreadActivation(seedQuery: string, opts: SpreadActivationOpts): ActivatedNode[];

  /**
   * Release the WASM linear-memory allocation for this graph instance.
   * Must be called exactly once after all spreadActivation calls are done.
   * Subsequent calls to any method after free() are undefined behaviour.
   */
  free(): void;
}

/**
 * Static factory surface of the @stackbilt/wasm-core WasmGraph module.
 * Import this as the type of the WASM module export, not a value:
 *
 *   import type { WasmGraphContract } from './issue-68.contract';
 *   import init, { WasmGraph as WasmGraphFactory } from '@stackbilt/wasm-core';
 *
 * The exported WASM binding must satisfy this interface.
 */
export interface WasmGraphContract {
  /**
   * Construct an immutable WasmGraph from pre-fetched D1 row arrays.
   * Builds an adjacency list in WASM linear memory from the supplied snapshot.
   * Validates that arrays are non-empty; throws if the snapshot is malformed.
   *
   * Path A (snapshot load) from approved architecture diagram.
   */
  fromSnapshotArrays(nodes: NodeRow[], edges: EdgeRow[]): WasmGraph;
}

// ---------------------------------------------------------------------------
// 3. Activation Invariants
// ---------------------------------------------------------------------------

/**
 * Canonical numerical constants governing the BFS solver.
 * These values are the source of truth — Rust must hard-code or accept these
 * exact values. JS callers use DEFAULT_HOPS and DEFAULT_TOP_K to fill opts
 * when the activateGraph() caller omits hops.
 */
export const ACTIVATION_INVARIANTS = {
  /** Activation score assigned to every seed node (keyword-matched). */
  SEED_ACTIVATION: 1.0,
  /**
   * Multiplier applied per hop:
   *   spreadActivation = sourceActivation × edgeWeight × DECAY_FACTOR
   */
  DECAY_FACTOR: 0.7,
  /** Nodes with activation below this threshold are excluded from results. */
  PRUNE_THRESHOLD: 0.05,
  /** Default hop depth when activateGraph() is called without the hops arg. */
  DEFAULT_HOPS: 2,
  /** Maximum number of ActivatedNode results returned (sorted descending). */
  DEFAULT_TOP_K: 10,
} as const;

// ---------------------------------------------------------------------------
// 4. Authority Rules
// ---------------------------------------------------------------------------

/**
 * Defines which call-site roles may instantiate or invoke WasmGraph.
 *
 * Rationale for `forbidden`:
 *   - HTTP route handlers must never hold a WasmGraph across request
 *     boundaries; the lifecycle (load → BFS → free) belongs in the kernel.
 *   - External API surfaces must not expose raw activation scores or the
 *     graph topology outside the cognitive-kernel boundary.
 */
export const WASM_GRAPH_AUTHORITY = {
  caller: ['cognitive-kernel', 'recall-pipeline'],
  forbidden: ['http-route-handlers', 'external-api'],
} as const;

export type WasmGraphCaller = (typeof WASM_GRAPH_AUTHORITY)['caller'][number];
export type WasmGraphForbidden = (typeof WASM_GRAPH_AUTHORITY)['forbidden'][number];

// ---------------------------------------------------------------------------
// 5. Snapshot Invariants
// ---------------------------------------------------------------------------

/**
 * Runtime-checkable invariants that must hold before JS calls
 * WasmGraph.fromSnapshotArrays(). The implementation (not this contract)
 * is responsible for enforcing them; they are named here so violations can
 * be traced back to a spec.
 *
 * Each entry is a { name, description, check } object so test suites can
 * drive parametric coverage from a single import.
 */

export interface SnapshotInvariant {
  /** Stable machine-readable name for the invariant. */
  name: string;
  /** Human-readable description for error messages and docs. */
  description: string;
  /** Pure predicate — returns true when the invariant holds. */
  check(snapshot: GraphSnapshot): boolean;
}

export const snapshotNodeIdsUnique: SnapshotInvariant = {
  name: 'snapshotNodeIdsUnique',
  description:
    'No two nodes in the snapshot share the same id. ' +
    'Duplicates would corrupt the adjacency-list index built in WASM.',
  check({ nodes }) {
    const seen = new Set<number>();
    for (const n of nodes) {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
    }
    return true;
  },
};

export const edgeEndpointsExistInSnapshot: SnapshotInvariant = {
  name: 'edgeEndpointsExistInSnapshot',
  description:
    'Every source_id and target_id referenced by an edge must correspond ' +
    'to a node id present in the snapshot nodes array. ' +
    'Dangling edges would cause WASM to index out of the adjacency table.',
  check({ nodes, edges }) {
    const nodeIds = new Set(nodes.map((n: NodeRow) => n.id));
    for (const e of edges) {
      if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) return false;
    }
    return true;
  },
};

export const activationBounded: SnapshotInvariant = {
  name: 'activationBounded',
  description:
    'All node activation values must be in the closed range [0.0, 1.0]. ' +
    'Values outside this range violate the BFS decay model and may cause ' +
    'PRUNE_THRESHOLD comparisons to behave incorrectly.',
  check({ nodes }) {
    return nodes.every((n: NodeRow) => n.activation >= 0.0 && n.activation <= 1.0);
  },
};

export const weightBounded: SnapshotInvariant = {
  name: 'weightBounded',
  description:
    'All edge weight values must be in the closed range [0.0, 1.0]. ' +
    'Values outside this range break the spreading-activation formula ' +
    '(sourceActivation × edgeWeight × DECAY_FACTOR must stay ≤ 1.0).',
  check({ edges }) {
    return edges.every((e: EdgeRow) => e.weight >= 0.0 && e.weight <= 1.0);
  },
};

/** All snapshot invariants in declaration order — import for parametric tests. */
export const SNAPSHOT_INVARIANTS: readonly SnapshotInvariant[] = [
  snapshotNodeIdsUnique,
  edgeEndpointsExistInSnapshot,
  activationBounded,
  weightBounded,
] as const;
