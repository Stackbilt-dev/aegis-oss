import { askGroq } from '../../groq.js';
import { buildGroqSystemPrompt } from '../../operator/prompt-builder.js';
import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';

export async function executeGroq(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  const text = await askGroq(
    env.groqApiKey,
    env.groqResponseModel, // 8B model for greetings — fast + cheap
    buildGroqSystemPrompt(),
    intent.raw,
    env.groqBaseUrl,
  );
  return { text, cost: 0.0001 };
}
