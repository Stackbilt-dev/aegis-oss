// Phase 4: Pattern Synthesis (PRISM) — cross-topic connection discovery.
// Pulls recent facts from diverse memory topics, finds structural
// connections, validates utility before committing to meta_insight tier.

import type { EdgeEnv } from '../../dispatch.js';
import { recordMemory as recordMemoryAdapter } from '../../memory-adapter.js';
import { askWorkersAiOrGroq, parseJsonResponse } from './llm.js';

const SYNTHESIS_SYSTEM = `You are a pattern synthesis engine. You receive facts from different domains stored in an AI agent's memory. Your job is to find NON-OBVIOUS structural connections between facts from DIFFERENT topics.

Rules:
- Only propose connections between facts from DIFFERENT topics (cross-domain synthesis).
- Each connection must be ACTIONABLE — it must change a decision, reveal a risk, or unlock an optimization. "These two things are related" is not enough.
- Apply adversarial self-check: could this connection be a coincidence or superficial keyword overlap? If yes, discard it.
- Maximum 2 connections per run. Quality over quantity.

Return ONLY valid JSON (no markdown):
{
  "connections": [
    {
      "fact_a": "first fact (quote or paraphrase)",
      "topic_a": "topic of first fact",
      "fact_b": "second fact (quote or paraphrase)",
      "topic_b": "topic of second fact",
      "insight": "the non-obvious connection and WHY it matters",
      "action": "specific action this insight enables or decision it changes",
      "confidence": 0.8
    }
  ]
}

If no genuine cross-domain connections exist, return {"connections": []}.
Do NOT force connections. Empty is better than noise.`;

interface SynthesisResult {
  connections?: Array<{
    fact_a: string;
    topic_a: string;
    fact_b: string;
    topic_b: string;
    insight: string;
    action: string;
    confidence: number;
  }>;
}

export async function runPatternSynthesis(env: EdgeEnv): Promise<number> {
  if (!env.memoryBinding) return 0;

  const topicSamples: Array<{ topic: string; content: string }> = [];
  const sampleTopics = [
    'aegis', 'infrastructure', 'feed_intel',
    'compliance', 'finance', 'content',
  ];

  for (const topic of sampleTopics) {
    try {
      const facts = await env.memoryBinding.recall('aegis', {
        topic,
        limit: 3,
        min_confidence: 0.7,
      });
      for (const f of facts) {
        topicSamples.push({ topic: f.topic, content: f.content });
      }
    } catch { /* topic may not exist yet */ }
  }

  if (topicSamples.length < 6) {
    console.log(`[dreaming:prism] Too few facts for synthesis (${topicSamples.length})`);
    return 0;
  }

  // Deduplicate — max 3 per topic
  const byTopic: Record<string, typeof topicSamples> = {};
  for (const s of topicSamples) {
    if (!byTopic[s.topic]) byTopic[s.topic] = [];
    if (byTopic[s.topic].length < 3) byTopic[s.topic].push(s);
  }

  if (Object.keys(byTopic).length < 3) {
    console.log(`[dreaming:prism] Need 3+ topics for cross-domain synthesis (have ${Object.keys(byTopic).length})`);
    return 0;
  }

  const factsBlock = Object.entries(byTopic)
    .map(([topic, facts]) =>
      `[${topic}]\n${facts.map(f => `- ${f.content}`).join('\n')}`
    ).join('\n\n');

  try {
    const raw = await askWorkersAiOrGroq(env, SYNTHESIS_SYSTEM, factsBlock.slice(0, 8000));
    if (!raw) return 0;

    const result = parseJsonResponse<SynthesisResult>(raw);
    if (!result) return 0;

    let recorded = 0;
    for (const conn of (result.connections ?? []).slice(0, 2)) {
      if (!conn.insight || !conn.action || conn.insight.length < 30) continue;
      if (conn.topic_a === conn.topic_b) continue;
      if (conn.action.length < 20) continue;

      const metaFact = `[PRISM] Connection: ${conn.topic_a} ↔ ${conn.topic_b} — ${conn.insight}. Action: ${conn.action}`;
      await recordMemoryAdapter(
        env.memoryBinding,
        'meta_insight',
        metaFact,
        Math.min(conn.confidence ?? 0.8, 0.85),
        'pattern_synthesis',
      );
      recorded++;
      console.log(`[dreaming:prism] Meta-insight: ${conn.topic_a} ↔ ${conn.topic_b} — ${conn.insight.slice(0, 100)}`);
    }

    if (recorded === 0) {
      console.log('[dreaming:prism] No actionable cross-domain connections found (this is fine)');
    }
    return recorded;
  } catch (err) {
    console.warn('[dreaming:prism] Pattern synthesis failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
