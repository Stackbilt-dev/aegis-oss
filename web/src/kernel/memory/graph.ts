// ─── Knowledge Graph: Node Extraction, Edge Inference, Spreading Activation ──
//
// Phase 2 of the cognitive layer. Populates kg_nodes/kg_edges tables using
// zero-cost regex/heuristic NER (no LLM calls). Provides spreading activation
// for context-aware retrieval.

// ─── Node Type Classification ────────────────────────────────────────────────

type NodeType = 'concept' | 'project' | 'person' | 'decision' | 'pattern' | 'tool' | 'event'
  | 'file' | 'module' | 'function' | 'class' | 'interface' | 'type_alias';

export type SourceSystem = 'cognitive' | 'code' | 'manual';

// Add your project names here for entity recognition in the knowledge graph
const KNOWN_PROJECTS: Set<string> = new Set([
  'aegis',
  // 'my-project', 'my-service', etc.
]);

const KNOWN_TOOLS: Set<string> = new Set([
  'cloudflare', 'wrangler', 'd1', 'kv', 'r2', 'workers ai',
  'groq', 'claude', 'anthropic', 'openai', 'sonnet', 'opus', 'haiku',
  'stripe', 'resend', 'github', 'better auth', 'oauth', 'mcp',
  'brave search', 'astro', 'react', 'typescript', 'pnpm', 'npm',
]);

// Add known people for entity recognition (first name + full name)
const KNOWN_PEOPLE: Set<string> = new Set([
  // 'operator', 'jane doe',
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

// Matches product/project names with hyphens like my-service, my-project-v2
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

  // Find seed nodes by keyword matching against labels
  const keywords = query.toLowerCase().split(/[\s,;:()\[\]]+/).filter(w => w.length >= 3);
  if (keywords.length === 0) return [];

  // Build LIKE conditions for seed node matching
  const conditions = keywords.map(() => 'LOWER(label) LIKE ?').join(' OR ');
  const binds = keywords.map(k => `%${k}%`);

  const seedResult = await db.prepare(
    `SELECT id, label, node_type FROM kg_nodes WHERE ${conditions} LIMIT 20`
  ).bind(...binds).all<{ id: number; label: string; node_type: string }>();

  if (seedResult.results.length === 0) return [];

  // Activation map: nodeId -> activation score
  const activations = new Map<number, number>();
  const nodeInfo = new Map<number, { label: string; type: string }>();

  // Seed nodes get activation 1.0
  for (const seed of seedResult.results) {
    activations.set(seed.id, 1.0);
    nodeInfo.set(seed.id, { label: seed.label, type: seed.node_type });
  }

  // Spread activation through edges
  const DECAY = 0.7;
  let frontier = [...seedResult.results.map(s => s.id)];

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const nextFrontier: number[] = [];

    for (const nodeId of frontier) {
      const sourceActivation = activations.get(nodeId) ?? 0;
      if (sourceActivation < 0.05) continue; // Prune weak activations

      // Find neighbors via edges (both directions)
      const neighbors = await db.prepare(
        `SELECT
          CASE WHEN source_id = ? THEN target_id ELSE source_id END as neighbor_id,
          weight,
          e.id as edge_id
        FROM kg_edges e
        WHERE source_id = ? OR target_id = ?
        LIMIT 20`
      ).bind(nodeId, nodeId, nodeId).all<{ neighbor_id: number; weight: number; edge_id: number }>();

      for (const neighbor of neighbors.results) {
        const spreadActivation = sourceActivation * neighbor.weight * DECAY;
        const current = activations.get(neighbor.neighbor_id) ?? 0;

        if (spreadActivation > current) {
          activations.set(neighbor.neighbor_id, spreadActivation);
          nextFrontier.push(neighbor.neighbor_id);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Fetch info for any activated nodes we don't have info for yet
  const missingIds = [...activations.keys()].filter(id => !nodeInfo.has(id));
  if (missingIds.length > 0) {
    // Batch fetch in chunks to avoid overly long queries
    for (let i = 0; i < missingIds.length; i += 20) {
      const chunk = missingIds.slice(i, i + 20);
      const placeholders = chunk.map(() => '?').join(',');
      const infoResult = await db.prepare(
        `SELECT id, label, node_type FROM kg_nodes WHERE id IN (${placeholders})`
      ).bind(...chunk).all<{ id: number; label: string; node_type: string }>();

      for (const row of infoResult.results) {
        nodeInfo.set(row.id, { label: row.label, type: row.node_type });
      }
    }
  }

  // Build result: top 10 by activation score
  const results: ActivatedNode[] = [];
  for (const [nodeId, activation] of activations.entries()) {
    const info = nodeInfo.get(nodeId);
    if (info) {
      results.push({ label: info.label, type: info.type, activation });
    }
  }

  results.sort((a, b) => b.activation - a.activation);
  return results.slice(0, 10);
}
