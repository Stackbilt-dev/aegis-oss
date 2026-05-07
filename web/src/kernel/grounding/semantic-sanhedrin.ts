// Semantic Sanhedrin — post-generation wiki-contradiction gate (aegis#573).
//
// Catches factual claims that slip past the structured fabrication detector
// (agenda/task mutation language, referential slugs) because they have no
// regex signature: "our Worker runs at X", "pricing is $Y", "version is Z".
//
// Pipeline:
//   1. Skip short responses (< MIN_RESPONSE_WORDS) — not worth the model call.
//   2. wiki_search on the first 200 chars of the response to get domain context.
//   3. Extract candidate claim sentences (factual markers, non-questions, ≥10 words).
//   4. Workers AI llama-3.1-8b: "do any of these statements contradict wiki facts?"
//   5. Parse JSON result, filter by confidence ≥ MIN_CONFIDENCE.
//
// Posture: flag, don't strip. Non-fatal.

import { searchPages } from '../../wiki/client.js';
import type { WikiClientEnv } from '../../wiki/client.js';

const MIN_RESPONSE_WORDS = 150;
const WIKI_SEARCH_LIMIT = 3;
const MAX_WIKI_EXCERPT_CHARS = 300;
const MAX_RESPONSE_CHARS = 800;
const MAX_CANDIDATE_SENTENCES = 15;
const MIN_CONFIDENCE = 0.8;
const SANHEDRIN_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_TOKENS = 300;

export interface WikiContradiction {
  statement: string;
  wiki_source: string;
  confidence: number;
}

export interface WikiContradictionReport {
  checked: number;
  contradictions: WikiContradiction[];
}

export interface SanhedrinEnv extends WikiClientEnv {
  ai?: Ai;
}

// ─── Candidate sentence extraction ─────────────────────────────────────

const FACTUAL_SIGNAL_RE = /\b(?:is|are|was|were|costs?|deployed|version|currently|runs?|uses?|our|aegis|worker|pricing|endpoint|url|located|serves?|hosts?|available)\b/i;
const QUESTION_RE = /\?/;
const MIN_SENTENCE_WORDS = 10;

export function extractCandidateSentences(text: string): string[] {
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  const candidates: string[] = [];
  for (const s of sentences) {
    if (candidates.length >= MAX_CANDIDATE_SENTENCES) break;
    if (QUESTION_RE.test(s)) continue;
    if (s.split(/\s+/).length < MIN_SENTENCE_WORDS) continue;
    if (!FACTUAL_SIGNAL_RE.test(s)) continue;
    candidates.push(s);
  }
  return candidates;
}

// ─── Workers AI call ────────────────────────────────────────────────────

function buildPrompt(wikiContext: string, candidates: string[]): string {
  const numbered = candidates.map((s, i) => `${i + 1}. "${s}"`).join('\n');
  return [
    'You are a factual accuracy auditor. Check if any candidate statements contradict the wiki facts below.',
    '',
    'WIKI FACTS:',
    wikiContext,
    '',
    'CANDIDATE STATEMENTS:',
    numbered,
    '',
    'Respond with ONLY valid JSON — no prose, no markdown fences:',
    '{"contradictions":[{"statement":"...","wiki_source":"page title","confidence":0.0}]}',
    'Only include contradictions with confidence >= 0.7. If none found: {"contradictions":[]}',
  ].join('\n');
}

function parseAiResponse(raw: string): WikiContradiction[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).contradictions)) {
    return [];
  }

  const raw_list = (parsed as { contradictions: unknown[] }).contradictions;
  const result: WikiContradiction[] = [];
  for (const item of raw_list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const statement = typeof c.statement === 'string' ? c.statement.trim() : '';
    const wiki_source = typeof c.wiki_source === 'string' ? c.wiki_source.trim() : 'unknown';
    const confidence = typeof c.confidence === 'number' ? c.confidence : 0;
    if (!statement) continue;
    result.push({ statement, wiki_source, confidence });
  }
  return result;
}

async function runWorkersAi(ai: Ai, prompt: string): Promise<WikiContradiction[]> {
  const result = await (ai.run as (model: string, options: unknown) => Promise<{ response?: string }>)(
    SANHEDRIN_MODEL,
    {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: MAX_TOKENS,
    },
  );
  const text = result.response ?? '';
  return parseAiResponse(text);
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function semanticSanhedrinCheck(
  responseText: string,
  env: SanhedrinEnv,
): Promise<WikiContradictionReport> {
  const wordCount = responseText.trim().split(/\s+/).length;
  if (wordCount < MIN_RESPONSE_WORDS) return { checked: 0, contradictions: [] };
  if (!env.ai || !env.wikiBinding) return { checked: 0, contradictions: [] };

  const searchQuery = responseText.slice(0, 200).replace(/[^\w\s]/g, ' ').trim();
  const { results } = await searchPages(env, searchQuery, { limit: WIKI_SEARCH_LIMIT });
  if (results.length === 0) return { checked: 0, contradictions: [] };

  const wikiContext = results
    .map(p => `[${p.title}]\n${(p.summary || p.snippet || '').slice(0, MAX_WIKI_EXCERPT_CHARS)}`)
    .join('\n\n');

  const candidates = extractCandidateSentences(responseText.slice(0, MAX_RESPONSE_CHARS * 2));
  if (candidates.length === 0) return { checked: 0, contradictions: [] };

  const prompt = buildPrompt(wikiContext, candidates);
  const all = await runWorkersAi(env.ai, prompt);
  const filtered = all.filter(c => c.confidence >= MIN_CONFIDENCE);

  return { checked: candidates.length, contradictions: filtered };
}

export function formatContradictions(report: WikiContradictionReport): string[] {
  return report.contradictions.map(c =>
    `semantic: "${c.statement.slice(0, 120)}" — contradicts wiki:${c.wiki_source} (confidence: ${c.confidence.toFixed(2)})`,
  );
}
