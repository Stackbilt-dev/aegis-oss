// Per-conversation fact extraction (#324)
// Complements the dreaming cycle (daily, batch) with near-real-time
// fact capture from operator chat sessions. Runs every 2 hours,
// processes conversations updated since last run. Uses Workers AI (free).

import { type EdgeEnv } from '../dispatch.js';
import { recordMemory as recordMemoryAdapter } from '../memory-adapter.js';
import { askGroq } from '../../groq.js';

const WATERMARK_KEY = 'conversation_facts_watermark';
const MAX_CONVERSATIONS = 5;
const MAX_MESSAGES_PER_CONV = 20;
const MAX_FACTS_PER_CONV = 5;
const RUN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

const BLOCKED_TOPIC_PREFIXES = ['synthesis_', 'cross_repo_insight'];
const ALLOWED_TOPICS = new Set([
  'aegis',
  'auth',
  'bizops',
  'charter',
  'codebeast',
  'compliance',
  'content',
  'feed_intel',
  'finance',
  'img_forge',
  'infrastructure',
  'mcp_strategy',
  'meta_insight',
  'operator_persona',
  'operator_preferences',
  'organization',
  'project',
  'self_improvement',
  'tarotscript',
]);

const TOPIC_ALIASES: Record<string, string> = {
  operator_persona: 'operator_persona',
  operator_preferences: 'operator_preferences',
  stackbilt: 'project',
  stackbilt_auth: 'auth',
  roundtable: 'content',
  memory_worker: 'aegis',
  colonyos: 'project',
  edgestack: 'project',
  wip_techhuman: 'project',
};

const EXTRACTION_SYSTEM = `You extract durable facts from an AI assistant conversation. Focus on:
- Business decisions, commitments, deadlines
- Technical architecture changes or constraints
- User preferences and corrections
- New information not derivable from code

Return ONLY valid JSON (no markdown fences):
{
  "facts": [
    { "topic": "category", "fact": "specific durable fact", "confidence": 0.8 }
  ]
}

Rules:
- Max 5 facts. Fewer is better if conversation is routine.
- Return {"facts":[]} if nothing worth remembering.
- topic must be one of: aegis, auth, bizops, charter, codebeast, compliance, content, feed_intel, finance, img_forge, infrastructure, mcp_strategy, meta_insight, operator_persona, operator_preferences, organization, project, self_improvement, tarotscript
- Each fact must be a complete sentence with concrete details (names, numbers, dates).
- Do NOT extract: greetings, tool outputs, code snippets, or ephemeral task state.
- confidence: 0.9 for explicit statements, 0.7 for inferences.`;

interface ExtractedFact {
  topic: string;
  fact: string;
  confidence: number;
}

function normalizeTopic(topic: string): string {
  const normalized = topic.toLowerCase().trim().replace(/\s+/g, '_');
  return TOPIC_ALIASES[normalized] ?? normalized;
}

async function askAi(
  env: EdgeEnv,
  system: string,
  user: string,
): Promise<string> {
  if (env.ai) {
    const result = await env.ai.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as Parameters<Ai['run']>[0],
      { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    ) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
    return result.choices?.[0]?.message?.content ?? result.response ?? '';
  }
  return askGroq(env.groqApiKey, env.groqResponseModel, system, user, env.groqBaseUrl);
}

export async function runConversationFactExtraction(env: EdgeEnv): Promise<void> {
  // Time gate: run every 2 hours (uses web_events for watermark, same as other scheduled tasks)
  const lastRun = await env.db.prepare(
    'SELECT received_at FROM web_events WHERE event_id = ?',
  ).bind(WATERMARK_KEY).first<{ received_at: string }>().catch(() => null);

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < RUN_INTERVAL_MS) return;
  }

  // Find conversations with recent activity (since last run or last 2h)
  const since = lastRun?.received_at ?? new Date(Date.now() - RUN_INTERVAL_MS).toISOString().replace('Z', '');

  const conversations = await env.db.prepare(`
    SELECT c.id, c.title, COUNT(m.id) as msg_count
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE m.created_at > ? AND m.role = 'user'
    GROUP BY c.id
    HAVING msg_count >= 2
    ORDER BY MAX(m.created_at) DESC
    LIMIT ?
  `).bind(since, MAX_CONVERSATIONS).all<{ id: string; title: string; msg_count: number }>();

  if (conversations.results.length === 0) {
    await advanceWatermark(env.db);
    return;
  }

  let totalFacts = 0;

  for (const conv of conversations.results) {
    const messages = await env.db.prepare(`
      SELECT role, content FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(conv.id, MAX_MESSAGES_PER_CONV).all<{ role: string; content: string }>();

    // Reverse to chronological order (queried DESC for recency limit)
    const thread = messages.results.reverse();
    if (thread.length < 2) continue;

    const transcript = thread
      .map((message) => `${message.role === 'user' ? 'operator' : 'AEGIS'}: ${message.content.slice(0, 1000)}`)
      .join('\n\n');

    let rawResponse: string;
    try {
      rawResponse = await askAi(env, EXTRACTION_SYSTEM, transcript.slice(0, 12000));
    } catch (err) {
      console.warn(`[conv-facts] LLM failed for ${conv.id}:`, err instanceof Error ? err.message : String(err));
      continue;
    }

    if (!rawResponse) continue;

    const cleaned = rawResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed: { facts?: ExtractedFact[] };
    try {
      parsed = JSON.parse(cleaned) as { facts?: ExtractedFact[] };
    } catch {
      console.warn(`[conv-facts] Failed to parse response for ${conv.id}: ${cleaned.slice(0, 100)}`);
      continue;
    }

    if (!parsed.facts || !Array.isArray(parsed.facts)) continue;

    for (const fact of parsed.facts.slice(0, MAX_FACTS_PER_CONV)) {
      if (!fact.topic || !fact.fact || fact.fact.length < 20) continue;

      const topicLower = normalizeTopic(fact.topic);
      if (BLOCKED_TOPIC_PREFIXES.some((prefix) => topicLower.startsWith(prefix))) continue;
      if (!ALLOWED_TOPICS.has(topicLower)) {
        console.log(`[conv-facts] Blocked unknown topic '${fact.topic}'`);
        continue;
      }

      try {
        if (!env.memoryBinding) continue;
        await recordMemoryAdapter(
          env.memoryBinding,
          topicLower,
          fact.fact,
          fact.confidence ?? 0.8,
          'conversation_extraction',
        );
        totalFacts++;
        console.log(`[conv-facts] Extracted: [${topicLower}] ${fact.fact.slice(0, 80)}`);
      } catch (err) {
        console.warn('[conv-facts] Failed to record:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  await advanceWatermark(env.db);
  console.log(`[conv-facts] Processed ${conversations.results.length} conversations, extracted ${totalFacts} facts`);
}

async function advanceWatermark(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES (?, datetime('now'))",
  ).bind(WATERMARK_KEY).run().catch(() => {});
}
