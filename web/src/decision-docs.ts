// Decision document generator stub for OSS build
// Full implementation is proprietary

import type { EdgeEnv } from './kernel/dispatch.js';

export async function generateDecisionDoc(
  topic: string,
  _env: EdgeEnv,
  _opts?: { days?: number; includeRaw?: boolean; repo?: string },
): Promise<string> {
  return `# Decision Document: ${topic}\n\n_Decision document generation is not available in the OSS build._`;
}
