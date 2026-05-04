import { executeClaudeStream } from './executors/index.js';
import { createIntent } from './dispatch.js';
import type { EdgeEnv } from './dispatch.js';
import type { AegisExecutorPort, AegisTurnInput, AegisTurnEvent } from './port.js';

// Bridges the callback-style executeClaudeStream to the AsyncIterable<AegisTurnEvent>
// contract required by AegisExecutorPort. The kernel's execution loop is untouched.
export class KernelExecutorPort implements AegisExecutorPort {
  constructor(private readonly env: EdgeEnv) {}

  async *dispatch(input: AegisTurnInput): AsyncIterable<AegisTurnEvent> {
    const intent = createIntent(input.sessionId, input.text);

    // Push-queue bridge: callback fires synchronously from within the stream loop;
    // the generator drains it between awaits so no events are dropped.
    const queue: Array<AegisTurnEvent | null> = [];
    let notify: (() => void) | null = null;

    const push = (event: AegisTurnEvent | null) => {
      queue.push(event);
      const n = notify;
      notify = null;
      n?.();
    };

    executeClaudeStream(intent, this.env, (text) => push({ type: 'text.delta', text }))
      .then(() => push(null))
      .catch((err) => {
        push({ type: 'warning', message: err instanceof Error ? err.message : String(err) });
        push(null);
      });

    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((r) => { notify = r; });
      }
      const item = queue.shift()!;
      if (item === null) {
        yield { type: 'done' };
        return;
      }
      yield item;
    }
  }
}
