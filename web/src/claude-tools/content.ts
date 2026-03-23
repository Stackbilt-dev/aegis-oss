// Stub — full implementation not yet extracted to OSS
import type { EdgeEnv } from '../kernel/dispatch.js';

export const ROUNDTABLE_TOOLS: never[] = [];
export const DISPATCH_TOOLS: never[] = [];

export async function handleContentTool(
  _name: string,
  _input: Record<string, unknown>,
  _env: EdgeEnv,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return { content: [{ type: 'text', text: 'Content tools not available in OSS build' }] };
}
