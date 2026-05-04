import { Agent } from 'agents';
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from '@cloudflare/voice';
import type { VoiceTurnContext } from '@cloudflare/voice';
import { buildEdgeEnv } from '../../edge-env.js';
import { KernelExecutorPort } from '../../kernel/executor-port.js';
import type { AegisTurnInput } from '../../kernel/port.js';
import type { Env } from '../../types.js';

// CF-specific mixin lives here and nowhere else — the kernel is never imported by voice code.
const VoiceAgent = withVoice(Agent);

export class AegisVoiceAdapter extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, ctx: VoiceTurnContext): Promise<AsyncIterable<string>> {
    const input: AegisTurnInput = {
      sessionId: ctx.connection.id,
      userId: 'default-operator',
      text: transcript,
    };

    const port = new KernelExecutorPort(buildEdgeEnv(this.env));
    const eventStream = port.dispatch(input);

    return (async function* () {
      for await (const event of eventStream) {
        if (event.type === 'text.delta') {
          yield event.text;
        }
      }
    })();
  }
}
