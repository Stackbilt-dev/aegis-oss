// Symbolic Consultation — TarotScript service binding client
// Structured serendipity: deterministic symbolic computation that surfaces
// tensions analytical reasoning suppresses.
//
// See: artifacts/symbolic-consultation-protocol.md

// ─── Types (mirrors TarotScript ReadingAnalysis) ─────────────────────────────

export type Element = 'Fire' | 'Water' | 'Air' | 'Earth';

export interface CardSummary {
  position: string;
  name: string;
  arcana: 'major' | 'minor';
  number: number;
  suit: string | null;
  element: Element;
  orientation: 'upright' | 'reversed';
  keywords: string[];
  courtRank: string | null;
}

export interface DignityPair {
  positions: [string, string];
  cards: [string, string];
  relationship: string;
  elements: [Element, Element];
  description: string;
  score: number;
}

export interface ReadingAnalysis {
  cards: CardSummary[];
  elementalCensus: Record<Element, number>;
  dominantElement: Element;
  shadowDensity: { reversed: number; total: number; ratio: number };
  dignities: DignityPair[];
  courtCards: CardSummary[];
  majorArcana: CardSummary[];
  numerology: { sum: number; reduced: number; sephira: string; keyword: string };
  tensions: Array<{ elements: [Element, Element]; counts: [number, number]; description: string }>;
}

export interface ReadingResult {
  output: string;
  facts: Record<string, unknown>;
  spread: { name: string; positions: Record<string, unknown> } | null;
  analysis: ReadingAnalysis | null;
  seed: number;
  receipt: { hash: string; script: string; querentId: string };
}

export type SpreadType = 'single' | 'three-card' | 'star' | 'horseshoe' | 'celtic-cross' | 'shadow-work' | 'dreaming';

export interface SymbolicContext {
  domain: 'product' | 'architecture' | 'hiring' | 'strategy' | 'operations' | 'reflection';
  situation: string;
  tensionsKnown?: string[];
  timeframe?: 'immediate' | 'this-week' | 'this-quarter' | 'long-term';
}

// ─── Memory summary (what AEGIS stores per reading) ──────────────────────────

export interface SymbolicMemoryEntry {
  type: 'symbolic_consultation';
  receiptHash: string;
  seed: number;
  spreadType: SpreadType;
  intention: string;
  dominantElement: Element;
  shadowDensity: number;
  topTensions: Array<{ pair: [Element, Element]; count: number }>;
  sephira: string;
  sephiraKeyword: string;
  timestamp: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export async function runReading(
  fetcher: Fetcher,
  spreadType: SpreadType,
  intention: string,
  context?: SymbolicContext,
  seed?: number,
): Promise<ReadingResult> {
  const response = await fetcher.fetch('https://internal/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadType,
      querent: {
        id: 'aegis',
        intention,
        state: context ? {
          domain: context.domain,
          situation: context.situation,
          tensions_known: context.tensionsKnown?.join(', '),
          timeframe: context.timeframe,
        } : undefined,
      },
      seed,
      inscribe: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TarotScript error ${response.status}: ${body}`);
  }

  return response.json() as Promise<ReadingResult>;
}

export function summarizeForMemory(
  reading: ReadingResult,
  spreadType: SpreadType,
  intention: string,
): SymbolicMemoryEntry {
  const analysis = reading.analysis;
  return {
    type: 'symbolic_consultation',
    receiptHash: reading.receipt.hash,
    seed: reading.seed,
    spreadType,
    intention,
    dominantElement: analysis?.dominantElement ?? 'Earth',
    shadowDensity: analysis?.shadowDensity?.ratio ?? 0,
    topTensions: (analysis?.tensions ?? []).slice(0, 3).map(t => ({
      pair: t.elements,
      count: t.counts[0] + t.counts[1],
    })),
    sephira: analysis?.numerology?.sephira ?? 'unknown',
    sephiraKeyword: analysis?.numerology?.keyword ?? 'unknown',
    timestamp: new Date().toISOString(),
  };
}

export function formatSymbolicNote(reading: ReadingResult, spreadType: SpreadType): string {
  const analysis = reading.analysis;
  if (!analysis) return `Symbolic note (TarotScript): ${spreadType} reading completed, no analysis available.`;

  const shadow = analysis.shadowDensity.ratio;
  const readiness = shadow < 0.2 ? 'clear — act' : shadow < 0.5 ? 'partially hidden — proceed with awareness' : 'mostly concealed — may not be the moment to decide';

  const cards = analysis.cards.map(c => `${c.name} (${c.orientation})`).join(', ');
  const tensions = analysis.tensions.slice(0, 2).map(t => t.description).join('; ');

  return [
    `Symbolic note (TarotScript ${spreadType}):`,
    `Cards: ${cards}`,
    `Dominant element: ${analysis.dominantElement} | Shadow density: ${shadow.toFixed(2)} (${readiness})`,
    `Numerology: ${analysis.numerology.sephira} — ${analysis.numerology.keyword}`,
    tensions ? `Tensions: ${tensions}` : null,
  ].filter(Boolean).join('\n');
}
