// TarotScript Executor — symbolic consultation via Service Binding
//
// Calls the TarotScript worker's POST /run endpoint. Zero inference tokens
// (pure JS execution + optional Oracle call on the TarotScript side).
// Service binding = same colo, no network hop.

import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';

// Explicit tarot_* classifications (for internal triggers)
const MODE_MAP: Record<string, string> = {
  tarot_pulse: 'pulse',
  tarot_trajectory: 'trajectory',
  tarot_multi_angle: 'multi-angle',
  tarot_deep: 'deep',
  tarot_shadow: 'shadow',
  tarot_orchestration: 'orchestration',
  tarot_planning: 'planning',
  support_triage: 'triage',
};

// Mode → spread type (mirrors TarotScript's spread-selector.ts)
const SPREAD_MAP: Record<string, string> = {
  pulse: 'single',
  trajectory: 'three-card',
  'multi-angle': 'star',
  deep: 'celtic-cross',
  shadow: 'shadow-work',
  orchestration: 'pipeline-cast',
  planning: 'objective-cast',
  triage: 'triage-cast',
};

function detectMode(intent: KernelIntent): string {
  // Check explicit tarot_* classification first
  if (intent.classified && MODE_MAP[intent.classified]) {
    return MODE_MAP[intent.classified];
  }

  // Complexity-based fallback for symbolic_consultation
  const complexity = intent.complexity ?? 2;
  if (complexity <= 1) return 'pulse';
  if (complexity >= 3) return 'deep';
  return 'trajectory';
}

export async function executeTarotScript(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number; meta?: unknown }> {
  if (!env.tarotscriptFetcher) {
    return { text: 'TarotScript service binding not available.', cost: 0 };
  }

  const mode = detectMode(intent);
  const spreadType = SPREAD_MAP[mode] ?? 'three-card';

  const response = await env.tarotscriptFetcher.fetch('https://tarotscript-worker/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadType,
      querent: {
        id: intent.source.threadId,
        intention: intent.raw,
        state: {
          classification: intent.classified ?? 'symbolic_consultation',
          complexity: String(intent.complexity ?? 2),
          confidence: String(intent.confidence ?? 0.8),
        },
      },
      inscribe: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => `HTTP ${response.status}`);
    return { text: `TarotScript execution failed: ${err}`, cost: 0 };
  }

  const result = await response.json() as {
    output: string[];
    facts: Record<string, unknown>;
    analysis?: { dominantElement?: string; shadowDensity?: { ratio: number } };
    receipt: { hash: string; seed: number };
    spread?: { name: string };
  };

  const text = result.output.join('\n');

  return {
    text,
    cost: 0.001, // Nominal bookkeeping — no inference tokens, pure JS + optional Oracle
    meta: {
      source: 'tarotScript',
      spreadType: result.spread?.name ?? spreadType,
      mode,
      receipt: result.receipt,
      dominantElement: result.analysis?.dominantElement,
      shadowDensity: result.analysis?.shadowDensity?.ratio,
      facts: result.facts,
    },
  };
}
