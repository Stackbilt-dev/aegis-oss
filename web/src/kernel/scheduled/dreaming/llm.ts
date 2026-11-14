// Shared LLM helper for scheduled work — Groq first (free, 70B quality),
// Workers AI fallback. Free providers only: never reaches a paid provider (#412).
//
// Both providers are called directly rather than through
// @stackbilt/llm-providers. The factory appends every configured provider
// (including Anthropic) to its fallback chain, and wraps each provider in an
// isolate-global circuit breaker whose "rejected request" error replaces the
// real cause once a provider has failed earlier in the same cron run.

import type { EdgeEnv } from '../../dispatch.js';

const WORKERS_AI_70B = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** Max chars kept from each provider error (bodies can be whole HTML pages). */
const MAX_ERROR_CHARS = 300;

export interface FreeLlmOptions {
  groqModel: string;
  workersAiModel: string;
  groqMaxTokens?: number;
  groqTemperature?: number;
  workersAiMaxTokens?: number;
  workersAiTemperature?: number;
  /** Prefix for log lines and errors, e.g. "conv-facts". */
  label?: string;
}

function clip(s: string, max = MAX_ERROR_CHARS): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function errMsg(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err));
}

/**
 * OpenAI-compatible chat completions URL for a configured Groq base.
 * A bare host (`https://api.groq.com`) needs `/openai/v1`; an AI Gateway base
 * (`.../{gateway}/groq`) or an explicit `/openai/v1` base is used as given.
 */
export function groqChatCompletionsUrl(baseUrl?: string): string {
  const base = (baseUrl || 'https://api.groq.com').replace(/\/+$/, '');
  const path = new URL(base).pathname;
  return path === '' || path === '/' ? `${base}/openai/v1/chat/completions` : `${base}/chat/completions`;
}

async function callGroq(env: EdgeEnv, system: string, user: string, o: FreeLlmOptions): Promise<string> {
  const res = await fetch(groqChatCompletionsUrl(env.groqBaseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: o.groqModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: o.groqMaxTokens ?? 500,
      temperature: o.groqTemperature ?? 0.3,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${clip(await res.text().catch(() => ''))}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return text;
}

async function callWorkersAi(env: EdgeEnv, system: string, user: string, o: FreeLlmOptions): Promise<string> {
  const ai = env.ai as unknown as { run(model: string, input: unknown): Promise<unknown> };
  const out = (await ai.run(o.workersAiModel, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: o.workersAiMaxTokens ?? 2048,
    temperature: o.workersAiTemperature ?? 0.2,
  })) as { response?: unknown; choices?: { message?: { content?: string | null } }[] } | null;
  const text = typeof out?.response === 'string' ? out.response : out?.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return text;
}

/** Ask Groq, then Workers AI. Throws with both providers' (truncated) errors if both fail. */
export async function askFreeLlm(env: EdgeEnv, system: string, user: string, o: FreeLlmOptions): Promise<string> {
  const label = o.label ?? 'llm';
  const promptChars = system.length + user.length;
  const failures: string[] = [];

  if (env.groqApiKey) {
    try {
      return await callGroq(env, system, user, o);
    } catch (err) {
      failures.push(`groq (${o.groqModel}): ${errMsg(err)}`);
      console.warn(`[${label}] Groq failed (prompt ${promptChars} chars), falling back to Workers AI: ${errMsg(err)}`);
    }
  }

  if (env.ai) {
    try {
      return await callWorkersAi(env, system, user, o);
    } catch (err) {
      failures.push(`workers_ai (${o.workersAiModel}): ${errMsg(err)}`);
    }
  }

  if (failures.length) {
    throw new Error(`[${label}] All free providers failed (prompt ${promptChars} chars): ${failures.join('; ')}`);
  }
  throw new Error(`[${label}] No LLM provider available (groqApiKey and env.ai both missing)`);
}

export async function askWorkersAiOrGroq(
  env: EdgeEnv,
  system: string,
  user: string,
  useResponseModel = false,
): Promise<string> {
  return askFreeLlm(env, system, user, {
    groqModel: useResponseModel ? env.groqResponseModel : env.groqModel,
    workersAiModel: WORKERS_AI_70B,
    label: 'dreaming',
  });
}

export function parseJsonResponse<T>(raw: string): T | null {
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
