// Cross-Repo Insight Cache (CRIX #106)
// In-memory TTL cache for validated insights from the Memory Worker.
// Keyword-scored matching injects relevant cross-repo intelligence into dispatch context.

import type { EdgeEnv } from './dispatch.js';

interface InsightEntry {
  fact: string;
  type: string;
  origin: string;
}

let cache: { entries: InsightEntry[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_DISPATCH = 3;

export async function fetchRelevantInsights(
  env: EdgeEnv,
  classification: string,
  rawQuery: string,
): Promise<string | null> {
  const now = Date.now();
  if (!cache || (now - cache.fetchedAt) > CACHE_TTL_MS) {
    try {
      const fragments = await env.memoryBinding!.recall('aegis', {
        topic: 'cross_repo_insights',
        limit: 20,
        min_confidence: 0.75,
      });

      cache = {
        entries: fragments.map(f => {
          // Parse "[type:pattern] (from repo-name) actual fact text"
          const prefixMatch = f.content.match(/^\[([^\]]+)\]\s*\(from\s+([^)]+)\)\s*(.+)$/s);
          return {
            fact: prefixMatch ? prefixMatch[3] : f.content,
            type: prefixMatch ? prefixMatch[1] : 'pattern',
            origin: prefixMatch ? prefixMatch[2] : 'unknown',
          };
        }),
        fetchedAt: now,
      };
    } catch {
      return null;
    }
  }

  if (!cache || cache.entries.length === 0) return null;

  // Keyword matching
  const queryWords = new Set(
    rawQuery.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
  );

  const scored = cache.entries.map(entry => {
    const factWords = entry.fact.toLowerCase().split(/\s+/);
    const matches = factWords.filter(w => queryWords.has(w)).length;
    return { ...entry, relevance: matches };
  }).filter(e => e.relevance > 0);

  scored.sort((a, b) => b.relevance - a.relevance);
  const top = scored.slice(0, MAX_PER_DISPATCH);

  if (top.length === 0) return null;

  const lines = top.map(i => `- [${i.type}] (from ${i.origin}) ${i.fact}`);
  return `[Cross-Repo Intelligence — validated patterns]\n${lines.join('\n')}`;
}

/** Reset cache — useful for testing */
export function resetInsightCache(): void {
  cache = null;
}
