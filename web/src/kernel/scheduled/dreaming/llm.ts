// Shared LLM helper — Groq first (free, 70B quality), Workers AI 70B fallback.
// Never reaches a paid provider: the Workers AI step uses a Cloudflare-only
// factory, because the shared provider factory appends every configured
// provider (including Anthropic) to its fallback chain (#412).

import { createLLMProviderFactory } from '@stackbilt/llm-providers';
import type { EdgeEnv } from '../../dispatch.js';
import { askGroq } from '../../../groq.js';

const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function askWorkersAiOrGroq(
  env: EdgeEnv,
  system: string,
  user: string,
  useResponseModel = false,
): Promise<string> {
  const groqModel = useResponseModel ? env.groqResponseModel : env.groqModel;
  const promptChars = system.length + user.length;
  const failures: string[] = [];

  // Groq first — free tier, same 70B quality, eliminates neuron consumption
  if (env.groqApiKey) {
    try {
      return await askGroq(env.groqApiKey, groqModel, system, user, env.groqBaseUrl);
    } catch (err) {
      failures.push(`groq (${groqModel}): ${errMsg(err)}`);
      console.warn(`[llm] Groq failed (prompt ${promptChars} chars), falling back to Workers AI: ${errMsg(err)}`);
    }
  }

  // Workers AI fallback — Cloudflare only, so no further provider fallback
  if (env.ai) {
    try {
      const result = await createLLMProviderFactory({
        cloudflare: { ai: env.ai },
        fallbackRules: [],
        enableCircuitBreaker: false,
        enableRetries: true,
      }).generateResponse({
        model: WORKERS_AI_MODEL,
        systemPrompt: system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 2048,
        temperature: 0.2,
      });
      return result.message ?? '';
    } catch (err) {
      failures.push(`workers_ai (${WORKERS_AI_MODEL}): ${errMsg(err)}`);
    }
  }

  if (failures.length) {
    throw new Error(`[llm] All free providers failed (prompt ${promptChars} chars): ${failures.join('; ')}`);
  }
  throw new Error('[dreaming] No LLM provider available (groqApiKey and env.ai both missing)');
}

export function parseJsonResponse<T>(raw: string): T | null {
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
