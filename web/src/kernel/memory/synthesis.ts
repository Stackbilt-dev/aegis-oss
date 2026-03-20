// ─── Cross-Domain Synthesis Engine ───────────────────────────
// Generates new knowledge by finding connections across memory topics.
// Uses knowledge graph (kg_nodes/kg_edges) spreading activation to
// discover cross-topic entity links, then prompts Groq 70B to
// synthesize emergent patterns.
//
// Cost: ~$0.001/cycle (one Groq 70B call)
// Rate limit: max 3 synthetic insights per cycle

import type { EdgeEnv } from '../dispatch.js';
import type { MemoryServiceBinding, MemoryFragmentResult } from '../../types.js';
import { activateGraph } from './graph.js';
import { recallForQuery } from './recall.js';
import { askGroqJson } from '../../groq.js';
import { recordMemory } from '../memory-adapter.js';

const TENANT = 'aegis';
const MIN_TOPICS = 3;
const MAX_INSIGHTS_PER_CYCLE = 3;
const CONFIDENCE_GATE = 0.75;
const TOP_ENTRIES_PER_TOPIC = 5;

const SYNTHESIS_SYSTEM_PROMPT = `You are a cross-domain knowledge synthesizer. You receive facts from different knowledge domains/topics and connected entities from a knowledge graph.

Your job: identify non-obvious connections, implications, and emergent patterns that span multiple source topics. Each insight must reference concepts from at least 2 different source topics.

Output a JSON object with a single key "insights" containing an array of objects:
{ "insights": [{ "topic": "synthesis_<descriptive_slug>", "fact": "<the synthesized insight>", "confidence": <0.0-1.0>, "source_topics": ["topic_a", "topic_b"] }] }

Rules:
- Each fact must be a concrete, actionable insight — not a vague observation
- confidence reflects how well-supported the synthesis is by the source facts
- Only include insights where you see a genuine connection, not forced associations
- Maximum 3 insights
- topic should be "synthesis_" followed by a short descriptive slug (lowercase, underscores)`;

interface SynthesisInsight {
  topic: string;
  fact: string;
  confidence: number;
  source_topics: string[];
}

interface SynthesisResult {
  insights: SynthesisInsight[];
}

export async function runCrossDomainSynthesis(env: EdgeEnv): Promise<void> {
  if (!env.memoryBinding) {
    console.log('[synthesis] Skipped: Memory Worker binding unavailable');
    return;
  }

  try {
    // Step 1: Get active topics from memory stats
    const stats = await env.memoryBinding.stats(TENANT);
    const activeTopics = stats.topics
      .filter(t => t.count >= 2)
      .sort((a, b) => b.count - a.count);

    if (activeTopics.length < MIN_TOPICS) {
      console.log(`[synthesis] Skipped: only ${activeTopics.length} active topics (need ${MIN_TOPICS})`);
      return;
    }

    // Step 2: Pick 2-3 topics with the most entries (most active)
    const selectedTopics = activeTopics.slice(0, 3).map(t => t.topic);

    // Step 3: Fetch top entries from each topic by confidence
    const topicEntries = new Map<string, MemoryFragmentResult[]>();
    for (const topic of selectedTopics) {
      const entries = await env.memoryBinding.recall(TENANT, {
        topic,
        min_confidence: 0.5,
        limit: TOP_ENTRIES_PER_TOPIC,
      });
      if (entries.length > 0) {
        topicEntries.set(topic, entries);
      }
    }

    if (topicEntries.size < 2) {
      console.log(`[synthesis] Skipped: only ${topicEntries.size} topics returned entries`);
      return;
    }

    // Step 4: Recall pipeline — find cross-topic entity connections via unified recall
    const allTopicLabels = [...topicEntries.keys()].join(' ');
    const recallResult = await recallForQuery(allTopicLabels, { db: env.db, memoryBinding: env.memoryBinding, mindspringFetcher: env.mindspringFetcher, mindspringToken: env.mindspringToken }, { includeGraph: true });
    const graphNodes = await activateGraph(env.db, allTopicLabels, 2);

    // Step 5: Build prompt with facts and graph context
    const factsBlock = buildFactsBlock(topicEntries);
    const graphBlock = graphNodes.length > 0
      ? `\n\nConnected entities from knowledge graph:\n${graphNodes.map(n => `- ${n.label} (${n.type}, activation: ${n.activation.toFixed(2)})`).join('\n')}`
      : '';
    const recallBlock = recallResult.facts.length > 0
      ? `\n\nRecall pipeline results (${recallResult.facts.length} facts, expansions: ${recallResult.graphExpansions.join(', ')}):\n${recallResult.facts.slice(0, 5).map(f => `- ${f.text} (score: ${f.score.toFixed(3)}, source: ${f.source})`).join('\n')}`
      : '';

    const userPrompt = `Here are facts from ${topicEntries.size} different knowledge domains:\n\n${factsBlock}${graphBlock}${recallBlock}\n\nFind cross-domain connections and synthesize new insights.`;

    // Step 6: Ask Groq 70B for synthesis
    const { parsed } = await askGroqJson<SynthesisResult>(
      env.groqApiKey,
      env.groqModel,
      SYNTHESIS_SYSTEM_PROMPT,
      userPrompt,
      env.groqBaseUrl,
      { maxTokens: 800, temperature: 0.4 },
    );

    if (!parsed.insights || !Array.isArray(parsed.insights)) {
      console.log('[synthesis] No valid insights returned from Groq');
      return;
    }

    // Step 7: Filter and store insights
    let stored = 0;
    for (const insight of parsed.insights) {
      if (stored >= MAX_INSIGHTS_PER_CYCLE) break;

      // Validate structure
      if (!insight.fact || !insight.topic || typeof insight.confidence !== 'number') continue;

      // Confidence gate
      if (insight.confidence < CONFIDENCE_GATE) continue;

      // Must reference ≥2 source topics
      if (!insight.source_topics || insight.source_topics.length < 2) continue;

      // Normalize topic
      const topic = insight.topic.startsWith('synthesis_')
        ? insight.topic.toLowerCase().replace(/[^a-z0-9_]/g, '')
        : `synthesis_${insight.topic.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;

      await recordMemory(
        env.memoryBinding,
        topic,
        insight.fact,
        insight.confidence,
        'synthesis',
      );
      stored++;
      console.log(`[synthesis] Stored insight: ${topic} (confidence: ${insight.confidence})`);
    }

    console.log(`[synthesis] Cycle complete: ${stored} insights stored from ${topicEntries.size} topics`);
  } catch (err) {
    console.error('[synthesis] Cross-domain synthesis failed:', err instanceof Error ? err.message : String(err));
  }
}

function buildFactsBlock(topicEntries: Map<string, MemoryFragmentResult[]>): string {
  const sections: string[] = [];
  for (const [topic, entries] of topicEntries) {
    const facts = entries.map(e => `  - ${e.content} (confidence: ${e.confidence})`).join('\n');
    sections.push(`### ${topic}\n${facts}`);
  }
  return sections.join('\n\n');
}
