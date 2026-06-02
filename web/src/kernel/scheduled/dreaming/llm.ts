// Shared LLM helper — Groq first (free, 70B quality), Workers AI 70B fallback

import type { EdgeEnv } from '../../dispatch.js';
import { buildLLMProviderFactory } from '../../provider-factory.js';
import { askGroq } from '../../../groq.js';

export async function askWorkersAiOrGroq(
  env: EdgeEnv,
  system: string,
  user: string,
  useResponseModel = false,
): Promise<string> {
  const groqModel = useResponseModel ? env.groqResponseModel : env.groqModel;
  // Groq first — free tier, same 70B quality, eliminates neuron consumption
  if (env.groqApiKey) {
    try {
      return await askGroq(env.groqApiKey, groqModel, system, user, env.groqBaseUrl);
    } catch {
      // fall through to Workers AI
    }
  }
  // Workers AI fallback — only fires if Groq is unavailable or throws
  if (env.ai) {
    const result = await buildLLMProviderFactory(env).generateResponse({
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      systemPrompt: system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 2048,
      temperature: 0.2,
    });
    return result.message ?? '';
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
