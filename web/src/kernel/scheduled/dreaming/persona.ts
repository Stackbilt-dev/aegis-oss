// Phase 3: Persona Extraction — analyze conversation threads for
// behavioral patterns and personality dimensions.

import type { EdgeEnv } from '../../dispatch.js';
import { recordMemory as recordMemoryAdapter } from '../../memory-adapter.js';
import { askWorkersAiOrGroq, parseJsonResponse } from './llm.js';

const PERSONA_SYSTEM = `You analyze conversations to extract personality dimensions — how someone thinks, communicates, decides, and what they value. You are NOT extracting facts or preferences. You are observing behavioral patterns.

Analyze the conversations and return ONLY valid JSON (no markdown):
{
  "observations": [
    {
      "dimension": "cognitive_style|communication|values|delegation|decision_making|emotional",
      "observation": "specific behavioral pattern observed with evidence",
      "confidence": 0.7
    }
  ]
}

Dimensions:
- cognitive_style: pattern-matching vs sequential, systems-thinking, attention patterns, how they process information
- communication: directness, brevity, humor style, when they elaborate vs stay terse, energy signals
- values: what they protect, what they trade off, aesthetic sensibility, what "good" means to them
- delegation: how they assign work, trust calibration, review depth, feedback style
- decision_making: speed, what they weigh, what they dismiss, how they handle uncertainty, reversibility awareness
- emotional: what energizes them, what drains them, confidence vs insecurity signals, momentum patterns

Rules:
- Only record patterns with clear behavioral evidence from the conversation
- Be specific: "commits to architectural decisions within one exchange" not "makes fast decisions"
- Look for HOW they engage, not WHAT they discuss
- 3-5 observations max. Skip if the conversations are too transactional to reveal personality
- Return empty observations array if nothing personality-relevant is visible`;

interface PersonaResult {
  observations?: Array<{ dimension: string; observation: string; confidence: number }>;
}

export async function extractPersonaDimensions(env: EdgeEnv, threadContents: string[]): Promise<number> {
  if (threadContents.length === 0) return 0;

  let rawResponse: string;
  try {
    rawResponse = await askWorkersAiOrGroq(env, PERSONA_SYSTEM, threadContents.join('\n\n').slice(0, 15000), true);
  } catch (err) {
    console.warn('[dreaming:persona] LLM call failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }

  if (!rawResponse) return 0;

  const result = parseJsonResponse<PersonaResult>(rawResponse);
  if (!result) {
    console.warn('[dreaming:persona] Failed to parse response');
    return 0;
  }

  let recorded = 0;
  for (const obs of (result.observations ?? []).slice(0, 5)) {
    if (!obs.observation || obs.observation.length < 20 || !obs.dimension) continue;
    const fact = `[${obs.dimension}] ${obs.observation}`;
    try {
      if (!env.memoryBinding) continue;
      await recordMemoryAdapter(env.memoryBinding, 'operator_persona', fact, obs.confidence ?? 0.7, 'persona_extraction');
      recorded++;
      console.log(`[dreaming:persona] ${fact.slice(0, 80)}`);
    } catch { /* non-fatal */ }
  }

  if (recorded > 0) {
    console.log(`[dreaming:persona] Extracted ${recorded} persona observations`);
  }
  return recorded;
}
