// Shared LLM helper — Workers AI with Groq fallback (zero-cost primary, paid fallback)

import type { EdgeEnv } from '../../dispatch.js';
import { askGroq } from '../../../groq.js';

export async function askWorkersAiOrGroq(
  env: EdgeEnv,
  system: string,
  user: string,
  useResponseModel = false,
): Promise<string> {
  if (env.ai) {
    const model = useResponseModel
      ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      : (env.gptOssModel || '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    const result = await env.ai.run(
      model as Parameters<Ai['run']>[0],
      { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    ) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
    return result.choices?.[0]?.message?.content ?? result.response ?? '';
  }
  const groqModel = useResponseModel ? env.groqResponseModel : env.groqModel;
  return askGroq(env.groqApiKey, groqModel, system, user, env.groqBaseUrl);
}

export function parseJsonResponse<T>(raw: string): T | null {
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
