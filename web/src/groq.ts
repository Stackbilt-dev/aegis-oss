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

// ─── Classification confidence helper ────────────────────────
// Provider-backed replacement for the former raw Groq logprobs call.
// llm-providers does not expose provider logprob request options yet, so
// tokenConfidence mirrors self-reported confidence until that contract lands.

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
  const { parsed } = await askGroqJson<{
    pattern?: string;
    complexity?: number;
    needs_tools?: boolean;
    confidence?: number;
  }>(apiKey, model, systemPrompt, userPrompt, baseUrl, { maxTokens: 200, temperature: 0.1 });
  const confidence = parsed.confidence ?? 0.5;

  return {
    pattern: (parsed.pattern ?? 'general_knowledge').toLowerCase().replace(/[^a-z_]/g, ''),
    complexity: parsed.complexity ?? 2,
    needs_tools: parsed.needs_tools ?? false,
    selfReportedConfidence: confidence,
    tokenConfidence: confidence,
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
