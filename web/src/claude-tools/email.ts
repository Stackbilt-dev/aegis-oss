// Email in-process tool definitions + handlers
// Sends email via Resend API

import { resolveEmailProfile } from '../email.js';

// ─── Tool definition ─────────────────────────────────────────

export const SEND_EMAIL_TOOL = {
  name: 'send_email',
  description: 'Send an email via Resend API',
  input_schema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text or HTML)' },
      profile: { type: 'string', description: 'Email profile to use (default: primary)' },
    },
    required: ['to', 'subject', 'body'],
  },
};

// ─── Handler ─────────────────────────────────────────────────

export async function handleEmailTool(
  name: string,
  input: Record<string, unknown>,
  resendApiKeys: { resendApiKey: string; resendApiKeyPersonal: string },
): Promise<string | null> {
  if (name !== 'send_email') return null;

  const to = input.to as string;
  const subject = input.subject as string;
  const body = input.body as string;
  const profile = (input.profile as string | undefined) ?? 'primary';

  const sender = resolveEmailProfile(profile, resendApiKeys);

  // If body looks like HTML (starts with <), use it as-is; otherwise wrap in simple HTML
  const html = body.trimStart().startsWith('<')
    ? body
    : body.split('\n').map(line => `<p style="margin:0 0 8px;color:#ccc">${line}</p>`).join('');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sender.apiKey}`,
      },
      body: JSON.stringify({
        from: sender.from,
        to: [to],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return `Email send failed (${res.status}): ${errText}`;
    }

    const data = await res.json() as { id?: string };
    return `Email sent to ${to} — subject: "${subject}" (id: ${data.id ?? 'unknown'})`;
  } catch (err) {
    return `Email send failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
