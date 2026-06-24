// ─── Knowledge Graph: Node Extraction, Edge Inference, Spreading Activation ──
//
// Phase 2 of the cognitive layer. Populates kg_nodes/kg_edges tables using
// zero-cost regex/heuristic NER (no LLM calls). Provides spreading activation
// for context-aware retrieval.
//
// activateGraph() wires to @stackbilt/wasm-core WasmGraph: 2 bulk D1 SELECTs
// replace the previous O(2N) sequential edge queries (aegis-oss#68).

// ─── Node Type Classification ────────────────────────────────────────────────

import { WasmGraph } from '@stackbilt/wasm-core';
import type { NodeType, SourceSystem } from '../../schema-enums.js';
export type { SourceSystem } from '../../schema-enums.js';

const KNOWN_PROJECTS: Set<string> = new Set([
  'aegis', 'bizops',
  // Add your project names here
]);

const KNOWN_TOOLS: Set<string> = new Set([
  'cloudflare', 'wrangler', 'd1', 'kv', 'r2', 'workers ai',
  'groq', 'claude', 'anthropic', 'openai', 'sonnet', 'opus', 'haiku',
  'stripe', 'resend', 'github', 'better auth', 'oauth', 'mcp',
  'brave search', 'astro', 'react', 'typescript', 'pnpm', 'npm',
]);

const KNOWN_PEOPLE: Set<string> = new Set([
  'alex',
]);

const DECISION_MARKERS = /\b(decided|decision|chose|chosen|approved|rejected|switched to|migrated to|adopted)\b/i;
const EVENT_MARKERS = /\b(launched|shipped|deployed|completed|released|merged|filed|signed|created|failed|broke|fixed)\b/i;
const PATTERN_MARKERS = /\b(pattern|anti-?pattern|best practice|convention|approach|strategy|architecture)\b/i;

function classifyNode(label: string, context: string): NodeType {
  const lower = label.toLowerCase();
  if (KNOWN_PEOPLE.has(lower)) return 'person';
  if (KNOWN_PROJECTS.has(lower)) return 'project';
  if (KNOWN_TOOLS.has(lower)) return 'tool';
  if (DECISION_MARKERS.test(context)) return 'decision';
  if (EVENT_MARKERS.test(context)) return 'event';
  if (PATTERN_MARKERS.test(context)) return 'pattern';
  return 'concept';
}

// ─── Entity Extraction (regex/heuristic NER — zero LLM cost) ─────────────────

// Matches capitalized multi-word phrases (2+ words starting with uppercase)
const CAPITALIZED_PHRASE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;

// Matches known technical terms that may not be capitalized
const TECH_TERMS = /\b(OAuth\s*2\.?1?|MCP|D1|KV|R2|CRIX|EIN|LLC|PBC|API|CLI|PKCE|SSO|JWT|RRF)\b/g;

// Matches version references like v1.9.0, Phase 2, etc.
const VERSION_REFS = /\b(v\d+\.\d+(?:\.\d+)?|Phase\s+\d+)\b/gi;

// Matches product/project names with hyphens like my-project, demo-app-v2
const HYPHENATED_NAMES = /\b([a-z]+-[a-z]+(?:-[a-z0-9]+)?)\b/gi;

function extractEntities(fact: string): string[] {
  const entities = new Set<string>();

  // Capitalized multi-word phrases
  for (const match of fact.matchAll(CAPITALIZED_PHRASE)) {
    const phrase = match[1].trim();
    // Skip common English phrases that aren't entities
    if (phrase.split(/\s+/).length <= 4 && phrase.length >= 4) {
      entities.add(phrase);
    }
  }

  // Known tech terms
  for (const match of fact.matchAll(TECH_TERMS)) {
    entities.add(match[1].toUpperCase());
  }

  // Version references (useful for tracking evolution)
  for (const match of fact.matchAll(VERSION_REFS)) {
    entities.add(match[1]);
  }

  // Hyphenated project names
  for (const match of fact.matchAll(HYPHENATED_NAMES)) {
    const name = match[1].toLowerCase();
    if (KNOWN_PROJECTS.has(name) || KNOWN_TOOLS.has(name)) {
      entities.add(name);
    }
  }

  // Single-word known projects/tools/people from the fact text
  const words = fact.toLowerCase().split(/[\s,;:()\[\]]+/);
  for (const word of words) {
    const cleaned = word.replace(/[^a-z0-9-]/g, '');
    if (cleaned.length >= 3) {
      if (KNOWN_PROJECTS.has(cleaned) || KNOWN_TOOLS.has(cleaned) || KNOWN_PEOPLE.has(cleaned)) {
        entities.add(cleaned);
      }
    }
  }

  return [...entities].filter(e => e.length >= 2);
}

// ─── extractNodes ────────────────────────────────────────────────────────────

export async function extractNodes(
  db: D1Database,
  fact: string,
  topic: string,
): Promise<number[]> {
  const entities = extractEntities(fact);
  if (entities.length === 0) return [];

  // Also add the topic itself as a concept node if not already extracted
  const topicLabel = topic.replace(/_/g, ' ');
  if (!entities.some(e => e.toLowerCase() === topicLabel.toLowerCase())) {
    entities.push(topicLabel);
  }

  const nodeIds: number[] = [];

  for (const entity of entities) {
    const label = entity.trim();
    if (!label) continue;

    const nodeType = classifyNode(label, fact);

    // Upsert: check if node with this label already exists (case-insensitive)
    const existing = await db.prepare(
      'SELECT id, memory_ids FROM kg_nodes WHERE LOWER(label) = LOWER(?) LIMIT 1'
    ).bind(label).first<{ id: number; memory_ids: string }>();

    if (existing) {
      // Update activation timestamp
      await db.prepare(
        "UPDATE kg_nodes SET last_activated_at = datetime('now'), activation = MIN(activation + 0.1, 1.0), updated_at = datetime('now') WHERE id = ?"
      ).bind(existing.id).run();
      nodeIds.push(existing.id);
    } else {
      // Insert new node
      const result = await db.prepare(
        "INSERT INTO kg_nodes (label, node_type, activation, last_activated_at, memory_ids, source_system) VALUES (?, ?, 0.5, datetime('now'), '[]', 'cognitive')"
      ).bind(label, nodeType).run();

      if (result.meta.last_row_id) {
        nodeIds.push(result.meta.last_row_id as number);
      }
    }
  }

  return nodeIds;
}

// ─── createEdges ─────────────────────────────────────────────────────────────

export async function createEdges(
  db: D1Database,
  nodeIds: number[],
  _factId?: number,
): Promise<void> {
  if (nodeIds.length < 2) return;

  // Create co-occurrence edges for all pairs
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const sourceId = nodeIds[i];
      const targetId = nodeIds[j];

      // Check for existing edge (either direction)
      const existing = await db.prepare(
        'SELECT id, co_activation_count, weight FROM kg_edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?) LIMIT 1'
      ).bind(sourceId, targetId, targetId, sourceId).first<{ id: number; co_activation_count: number; weight: number }>();

      if (existing) {
        // Increment co-activation, increase weight (cap at 1.0), update last_seen_at
        const newWeight = Math.min(existing.weight + 0.1, 1.0);
        await db.prepare(
          "UPDATE kg_edges SET co_activation_count = co_activation_count + 1, weight = ?, updated_at = datetime('now'), last_seen_at = datetime('now') WHERE id = ?"
        ).bind(newWeight, existing.id).run();
      } else {
        // Create new co-occurrence edge
        await db.prepare(
          "INSERT INTO kg_edges (source_id, target_id, relation, weight, confidence, source_system, first_seen_at, last_seen_at) VALUES (?, ?, 'related_to', 0.5, 0.7, 'cognitive', datetime('now'), datetime('now'))"
        ).bind(sourceId, targetId).run();
      }
    }
  }
}

// ─── activateGraph (spreading activation) ────────────────────────────────────

interface ActivatedNode {
  label: string;
  type: string;
  activation: number;
}

export async function activateGraph(
  db: D1Database,
  query: string,
  hops: number = 2,
): Promise<ActivatedNode[]> {
  if (!query || query.trim().length < 2) return [];

  // Bulk-load full graph snapshot: 2 queries total regardless of graph size.
  // WasmGraph runs the BFS in WASM linear memory — zero additional D1 round trips.
  const [nodesResult, edgesResult] = await Promise.all([
    db.prepare(
      'SELECT id, label, node_type, activation FROM kg_nodes'
    ).all<{ id: number; label: string; node_type: string; activation: number }>(),
    db.prepare(
      'SELECT source_id, target_id, weight FROM kg_edges'
    ).all<{ source_id: number; target_id: number; weight: number }>(),
  ]);

  if (nodesResult.results.length === 0) return [];

  const graph = WasmGraph.fromSnapshotArrays(nodesResult.results, edgesResult.results);
  try {
    const raw = graph.spreadActivation(query, hops, 10);
    return raw as ActivatedNode[];
  } finally {
    graph.free();
  }
}
