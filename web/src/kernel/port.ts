// AegisExecutorPort — the sole contract between the kernel and all interface adapters.
// Adapters (voice, CLI, MCP) consume this port. The kernel never imports adapter types.

export interface AegisTurnInput {
  sessionId: string;
  userId: string;
  text: string;
  signal?: AbortSignal;
  context?: Record<string, unknown>;
}

export type AegisTurnEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; name: string; args: unknown }
  | { type: 'tool.result'; name: string; result: unknown }
  | { type: 'memory.write'; patch: unknown }
  | { type: 'warning'; message: string }
  | { type: 'done' };

export interface AegisExecutorPort {
  dispatch(input: AegisTurnInput): AsyncIterable<AegisTurnEvent>;
  cancel?(sessionId: string): Promise<void>;
}
