import { buildLLMProviderFactory } from '../provider-factory.js';
import { buildGroqSystemPrompt } from '../../operator/prompt-builder.js';
import type { KernelIntent } from '../types.js';
import type { EdgeEnv } from '../dispatch.js';

export async function executeGroq(
  intent: KernelIntent,
  env: EdgeEnv,
): Promise<{ text: string; cost: number }> {
  const factory = buildLLMProviderFactory(env);
  const result = await factory.generateResponse({
    messages: [{ role: 'user', content: intent.raw }],
    model: env.groqResponseModel, // 8B — fast/cheap for greetings
    systemPrompt: buildGroqSystemPrompt(),
    temperature: 0.3,
    maxTokens: 500,
  });
  return { text: result.message || '(no response)', cost: result.usage.cost };
}
