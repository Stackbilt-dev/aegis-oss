import type { MemoryEntry } from '../types.js';

// ─── Temporal Relevance Decay (#53) ─────────────────────────
export const BASE_HALF_LIFE_DAYS = 14;
const RECENCY_WEIGHT = 0.6;
const STRENGTH_WEIGHT = 0.3;
const CONFIDENCE_WEIGHT = 0.1;
const MEMORY_CONTEXT_LIMIT = 50;
const MEMORY_FETCH_POOL = 80;

// ─── Topic Taxonomy ──────────────────────────────────────────
// Canonical topic map: normalized variant → canonical name.
// Two-pass normalizeTopic(): string cleanup → canonical lookup.
// Add new entries here when a new conceptual cluster emerges.
const CANONICAL_TOPICS: Record<string, string> = {
  // AEGIS internals — all facts about the cognitive kernel itself
  'aegis_development':    'aegis',
  'aegis_architecture':   'aegis',
  'aegis_infrastructure': 'aegis',
  'aegis_governance':     'aegis',
  'aegis_status':         'aegis',
  // img-forge — normalize the inconsistent prefix
  'imgforge':             'img_forge',
  'img_forge_economics':  'img_forge',
  'img_forge_integration': 'img_forge',
  // BizOps — operational mutations and improvements are the same domain
  'bizops_improvements':  'bizops',
  'bizops_mutate':        'bizops',
  // Content pipelines — roundtable, dispatch, column all live here
  'dispatch_generation':   'content',
  'roundtable_generation': 'content',
  'research_dispatch':     'content',
  'research_synthesis':    'content',
  'column_generation':     'content',
  'content_generation':    'content',
  // Self-improvement — outcomes belong with the source topic
  'self_improvement_outcomes': 'self_improvement',
  // Organization-level governance and priorities → root organization
  'organization_governance':  'organization',
  'organization_priorities':  'organization',
};

// Normalize topics to lowercase_underscore to prevent fragmentation
// ("Compliance Monitoring", "compliance_monitoring", "Compliance" → "compliance_monitoring")
export function normalizeTopic(topic: string): string {
  // Pass 1: string cleanup — lowercase, underscores, strip non-alphanum
  const normalized = topic.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
  // Pass 2: canonical lookup — collapse semantic variants to the same bucket
  return CANONICAL_TOPICS[normalized] ?? normalized;
}

// ─── Semantic Memory ────────────────────────────────────────

// Simple djb2-style hash for deduplication — no crypto needed, collision risk acceptable for this use
export function factHash(topic: string, fact: string): string {
  const s = `${topic}::${fact.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// ─── Semantic Dedup Helpers (#37) ────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
  'than', 'too', 'very', 'just', 'also', 'it', 'its', 'this', 'that',
  'these', 'those', 'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my',
  'his', 'her', 'our', 'your', 'their', 'what', 'which', 'who', 'whom',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SEMANTIC_DEDUP_THRESHOLD = 0.6;
const COSINE_DEDUP_THRESHOLD = 0.80;

// Cosine similarity for embedding-based dedup
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Three-phase dedup: exact hash → semantic similarity → insert new (#1, #37)
// When memoryBinding is provided, Phase 2 uses cosine similarity on BGE embeddings
// instead of Jaccard token overlap — catches paraphrased duplicates.
export async function recordMemory(
  db: D1Database, topic: string, fact: string, confidence: number, source: string,
  memoryBinding?: { embed(tenantId: string, texts: string[]): Promise<{ embeddings: number[][] }> },
): Promise<void> {
  topic = normalizeTopic(topic);
  const hash = factHash(topic, fact);

  // Phase 1: Exact hash dedup — fast path (active entries only)
  const existing = await db.prepare(
    'SELECT id, confidence FROM memory_entries WHERE topic = ? AND fact_hash = ? AND valid_until IS NULL LIMIT 1'
  ).bind(topic, hash).first<{ id: number; confidence: number }>();

  if (existing) {
    await db.prepare(
      "UPDATE memory_entries SET confidence = MAX(confidence, ?), source = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(confidence, source, existing.id).run();
    return;
  }

  // Phase 2: Semantic dedup — cosine similarity (preferred) or Jaccard fallback
  const topicEntries = await db.prepare(
    'SELECT id, fact, confidence FROM memory_entries WHERE topic = ? AND valid_until IS NULL ORDER BY confidence DESC LIMIT 20'
  ).bind(topic).all<{ id: number; fact: string; confidence: number }>();

  // Try cosine similarity via Memory Worker embeddings first
  let matchedEntry: { id: number; fact: string; confidence: number } | null = null;

  if (memoryBinding && topicEntries.results.length > 0) {
    try {
      const textsToEmbed = [fact, ...topicEntries.results.map(e => e.fact)];
      const { embeddings } = await memoryBinding.embed('aegis', textsToEmbed);
      const newEmb = embeddings[0];
      for (let i = 0; i < topicEntries.results.length; i++) {
        if (cosineSimilarity(newEmb, embeddings[i + 1]) >= COSINE_DEDUP_THRESHOLD) {
          matchedEntry = topicEntries.results[i];
          break;
        }
      }
    } catch (err) {
      console.error('[semantic] cosine dedup failed, falling back to Jaccard:', err instanceof Error ? err.message : String(err));
      // Fall through to Jaccard below
    }
  }

  // Jaccard fallback when memoryBinding unavailable or cosine dedup failed
  if (!matchedEntry && (!memoryBinding || topicEntries.results.length > 0)) {
    const newTokens = tokenize(fact);
    for (const entry of topicEntries.results) {
      const existingTokens = tokenize(entry.fact);
      if (jaccardSimilarity(newTokens, existingTokens) >= SEMANTIC_DEDUP_THRESHOLD) {
        matchedEntry = entry;
        break;
      }
    }
  }

  if (matchedEntry) {
    // Supersede: invalidate old entry, insert new with audit link
    const mergedFact = fact.length > matchedEntry.fact.length ? fact : matchedEntry.fact;
    const mergedHash = factHash(topic, mergedFact);
    const mergedConfidence = Math.min(1.0, Math.max(confidence, matchedEntry.confidence) + 0.05);
    // Invalidate old entry
    await db.prepare(
      "UPDATE memory_entries SET valid_until = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(matchedEntry.id).run();
    // Insert replacement with superseded_by link
    const insertResult = await db.prepare(
      'INSERT INTO memory_entries (topic, fact, fact_hash, confidence, source, superseded_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(topic, mergedFact, mergedHash, mergedConfidence, source, matchedEntry.id).run();
    // Back-link: set superseded_by on the old entry to point to new entry
    if (insertResult.meta.last_row_id) {
      await db.prepare(
        'UPDATE memory_entries SET superseded_by = ? WHERE id = ?'
      ).bind(insertResult.meta.last_row_id, matchedEntry.id).run();
    }
    return;
  }

  // Phase 3: No match — insert new entry
  await db.prepare(
    'INSERT INTO memory_entries (topic, fact, fact_hash, confidence, source) VALUES (?, ?, ?, ?, ?)'
  ).bind(topic, fact, hash, confidence, source).run();
}

// ─── Targeted Memory Search (#memory-recall-fix) ─────────────
// Keyword-based search across all memory facts — returns entries where
// the fact text contains any of the significant words from the query.
// Used by dispatch to augment memory_recall prompts with relevant context
// instead of relying on the model to find it in a 50-entry dump.

export async function searchMemoryByKeywords(
  db: D1Database,
  query: string,
  limit = 10,
): Promise<Array<{ id: number; topic: string; fact: string; confidence: number }>> {
  // Extract significant keywords (>3 chars, not stop words)
  const keywords = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  if (keywords.length === 0) return [];

  // Build OR-based LIKE search — each keyword gets a LIKE clause
  // D1 doesn't support full-text search, so LIKE is our best option
  const likeClauses = keywords.map(() => "LOWER(fact) LIKE ?").join(' OR ');
  const likeParams = keywords.map(k => `%${k}%`);

  const result = await db.prepare(
    `SELECT id, topic, fact, confidence FROM memory_entries
     WHERE valid_until IS NULL AND (${likeClauses})
     ORDER BY confidence DESC, updated_at DESC
     LIMIT ?`
  ).bind(...likeParams, limit).all<{ id: number; topic: string; fact: string; confidence: number }>();

  return result.results;
}

// ─── Memory Retrieval + Scoring ─────────────────────────────

export async function getMemoryEntries(db: D1Database, topic?: string): Promise<MemoryEntry[]> {
  if (topic) {
    const result = await db.prepare(
      'SELECT * FROM memory_entries WHERE topic = ? AND valid_until IS NULL ORDER BY created_at DESC'
    ).bind(normalizeTopic(topic)).all();
    return result.results as unknown as MemoryEntry[];
  }
  const result = await db.prepare(
    'SELECT * FROM memory_entries WHERE valid_until IS NULL ORDER BY created_at DESC LIMIT 100'
  ).all();
  return result.results as unknown as MemoryEntry[];
}

// ─── Memory Recall Tracking (#52) ────────────────────────────

// Increment strength and update last_recalled_at when facts are used in responses.
// Single batch UPDATE instead of N individual queries — 50x fewer D1 operations at recall.
export async function recallMemory(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.prepare(
    `UPDATE memory_entries SET strength = strength + 1, last_recalled_at = datetime('now') WHERE id IN (${placeholders})`
  ).bind(...ids).run();
}

// EWA (Ebbinghaus-Weighted Attention) score for temporal relevance ranking
// Combines recency decay, reinforcement strength, and source confidence
export function computeEwaScore(
  daysSinceActive: number,
  strength: number,
  confidence: number,
): number {
  // Recency: Ebbinghaus retention curve — 2^(-t / (s * halfLife))
  const recency = Math.pow(2, -daysSinceActive / (strength * BASE_HALF_LIFE_DAYS));
  // Strength: logarithmic diminishing returns, capped at 5
  const strengthScore = Math.log2(strength + 1) / 5;
  // Combined weighted score
  return RECENCY_WEIGHT * recency + STRENGTH_WEIGHT * strengthScore + CONFIDENCE_WEIGHT * confidence;
}

export async function getAllMemoryForContext(db: D1Database): Promise<{ text: string; ids: number[] }> {
  const result = await db.prepare(
    'SELECT id, topic, fact, confidence, strength, last_recalled_at, created_at FROM memory_entries WHERE valid_until IS NULL ORDER BY topic, created_at DESC LIMIT ?'
  ).bind(MEMORY_FETCH_POOL).all();
  const entries = result.results as unknown as {
    id: number; topic: string; fact: string; confidence: number;
    strength: number; last_recalled_at: string | null; created_at: string;
  }[];

  if (entries.length === 0) return { text: '', ids: [] };

  const now = Date.now();

  // Score each entry with EWA temporal relevance
  const scored = entries.map(e => {
    const activeDate = e.last_recalled_at ?? e.created_at;
    const ts = activeDate.endsWith('Z') ? activeDate : activeDate + 'Z';
    const daysSince = Math.max(0, (now - new Date(ts).getTime()) / 86_400_000);
    const score = computeEwaScore(daysSince, e.strength ?? 1, e.confidence);
    return { ...e, score };
  });

  // Sort by score descending, take top MEMORY_CONTEXT_LIMIT
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MEMORY_CONTEXT_LIMIT);

  const ids = top.map(e => e.id);

  const byTopic = new Map<string, string[]>();
  for (const e of top) {
    const list = byTopic.get(e.topic) || [];
    list.push(`- ${e.fact} (confidence: ${e.confidence})`);
    byTopic.set(e.topic, list);
  }

  let text = '\n## Agent Memory\n';
  for (const [topic, facts] of byTopic) {
    text += `\n### ${topic}\n${facts.join('\n')}\n`;
  }
  return { text, ids };
}
