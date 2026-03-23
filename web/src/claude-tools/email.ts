// Stub — full implementation not yet extracted to OSS
import type { EdgeEnv } from '../kernel/dispatch.js';

export const SEND_EMAIL_TOOL = {
  name: 'send_email',
  description: 'Send an email via Resend API',
  input_schema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (HTML)' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export async function handleEmailTool(
  _input: Record<string, unknown>,
  _env: EdgeEnv,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  return { content: [{ type: 'text', text: 'Email tool not available in OSS build' }] };
}
