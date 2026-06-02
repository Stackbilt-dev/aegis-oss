// Edge-native Groq helpers backed by @stackbilt/llm-providers

import { createLLMProviderFactory, type LLMMessage } from '@stackbilt/llm-providers';
import { tokenize, jaccardSimilarity } from './kernel/memory/index.js';
import { cosineSimilarity } from './kernel/memory/semantic.js';
import type { MemoryServiceBinding } from './types.js';

function buildGroqFactory(apiKey: string, baseUrl: string) {
  return createLLMProviderFactory({
    groq: { apiKey, baseUrl },
    fallbackRules: [],
    enableCircuitBreaker: true,
    enableRetries: true,
  });
}

function coerceText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

export async function askGroq(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  baseUrl = 'https://api.groq.com',
): Promise<string> {
  try {
    const result = await buildGroqFactory(apiKey, baseUrl).generateResponse({
      model,
      systemPrompt,
      temperature: 0.3,
      maxTokens: 500,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });
    return coerceText(result.message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Groq API error: ${msg}`);
  }
}

// ─── Logprobs-enabled classification ─────────────────────────
// Requests logprobs from Groq's OpenAI-compatible API and computes
// geometric mean of token probabilities for the classification value.
// Returns both self-reported confidence and token-level confidence.

export interface LogprobClassification {
  pattern: string;
  complexity: number;
  needs_tools: boolean;
  selfReportedConfidence: number;
  tokenConfidence: number;
}

export async function askGroqWithLogprobs(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  baseUrl = 'https://api.groq.com',
): Promise<LogprobClassification> {
  const response = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      logprobs: true,
      top_logprobs: 3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq logprobs API error ${response.status}: ${errText}`);
  }

  interface LogprobToken {
    token: string;
    logprob: number;
  }

  const data = await response.json<{
    choices: {
      message: { content: string };
      logprobs?: { content?: LogprobToken[] };
    }[];
  }>();

  const raw = data.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(raw) as {
    pattern?: string;
    complexity?: number;
    needs_tools?: boolean;
    confidence?: number;
  };

  // Compute geometric mean of token logprobs
  let tokenConfidence = 0.5; // fallback if no logprobs
  const logprobTokens = data.choices[0]?.logprobs?.content;
  if (logprobTokens && logprobTokens.length > 0) {
    const sumLogprobs = logprobTokens.reduce((sum, t) => sum + t.logprob, 0);
    tokenConfidence = Math.exp(sumLogprobs / logprobTokens.length);
  }

  return {
    pattern: (parsed.pattern ?? 'general_knowledge').toLowerCase().replace(/[^a-z_]/g, ''),
    complexity: parsed.complexity ?? 2,
    needs_tools: parsed.needs_tools ?? false,
    selfReportedConfidence: parsed.confidence ?? 0.5,
    tokenConfidence,
  };
}

// ─── Self-consistency probe ──────────────────────────────────
// Fire 3 parallel Groq 8B calls and check agreement via cosine
// similarity (BGE embeddings from Memory Worker). Falls back to
// Jaccard when memoryBinding is unavailable.
// Returns σ metric: 0=all agree, 0.5=partial, 1.0=disagree.

const PROBE_TIMEOUT_MS = 3_000;
const JACCARD_AGREEMENT_THRESHOLD = 0.5;
const COSINE_AGREEMENT_THRESHOLD = 0.85;

export interface ProbeResult {
  sigma: number;           // 0, 0.5, or 1.0
  agreedText: string | null;
  responses: string[];
}

export async function probeConsistency(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  baseUrl = 'https://api.groq.com',
  memoryBinding?: MemoryServiceBinding,
): Promise<ProbeResult> {
  const call = () => askGroq(apiKey, model, systemPrompt, userPrompt, baseUrl);

  const responses = await Promise.race([
    Promise.all([call(), call(), call()]),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('Probe timeout')), PROBE_TIMEOUT_MS),
    ),
  ]);

  const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
  let similarities: number[];
  let threshold: number;

  // Prefer cosine similarity via Memory Worker embeddings
  if (memoryBinding) {
    try {
      const { embeddings } = await memoryBinding.embed('aegis', responses);
      similarities = pairs.map(([a, b]) => cosineSimilarity(embeddings[a], embeddings[b]));
      threshold = COSINE_AGREEMENT_THRESHOLD;
    } catch (err) {
      console.warn('[probe] cosine embed failed, falling back to Jaccard:', err instanceof Error ? err.message : String(err));
      const tokens = responses.map(r => tokenize(r));
      similarities = pairs.map(([a, b]) => jaccardSimilarity(tokens[a], tokens[b]));
      threshold = JACCARD_AGREEMENT_THRESHOLD;
    }
  } else {
    // Jaccard fallback when memoryBinding unavailable
    const tokens = responses.map(r => tokenize(r));
    similarities = pairs.map(([a, b]) => jaccardSimilarity(tokens[a], tokens[b]));
    threshold = JACCARD_AGREEMENT_THRESHOLD;
  }

  const minSim = Math.min(...similarities);
  const maxSim = Math.max(...similarities);

  if (minSim >= threshold) {
    // All pairs agree → σ=0
    return { sigma: 0, agreedText: responses[0], responses };
  }

  if (maxSim >= threshold) {
    // At least one pair agrees → σ=0.5 (partial)
    return { sigma: 0.5, agreedText: null, responses };
  }

  // No pair agrees → σ=1.0 (total disagreement)
  return { sigma: 1.0, agreedText: null, responses };
}

// JSON-mode variant — returns parsed JSON + raw string
export async function askGroqJson<T = unknown>(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  baseUrl = 'https://api.groq.com',
  options?: { maxTokens?: number; temperature?: number; prefill?: string },
): Promise<{ parsed: T; raw: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const messages: LLMMessage[] = [
    { role: 'user', content: userPrompt },
  ];
  // Prefilling: seed the assistant response to steer tone/format
  if (options?.prefill) {
    messages.push({ role: 'assistant', content: options.prefill });
  }

  try {
    const result = await buildGroqFactory(apiKey, baseUrl).generateResponse({
      model,
      systemPrompt,
      temperature: options?.temperature ?? 0.2,
      maxTokens: options?.maxTokens ?? 2000,
      response_format: { type: 'json_object' },
      messages,
    });

    const completion = result.message ?? '{}';
    // If prefilled, the model continues from the prefill — concatenate for valid JSON
    const raw = options?.prefill ? options.prefill + completion : completion;
    const parsed = JSON.parse(raw) as T;
    return {
      parsed,
      raw,
      usage: {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Groq API error: ${msg}`);
  }
}
