import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../types.js';
import { McpClient } from '../mcp-client.js';
import { addAgendaItem } from '../kernel/memory/agenda.js';
import { FEEDBACK_CATEGORIES, validateEnum } from '../schema-enums.js';

const FEEDBACK_BODY_LIMIT = 100 * 1024;

export const feedback = new Hono<{ Bindings: Env }>();

// CORS preflight for cross-origin feedback submissions (Client App UI → AEGIS)
feedback.options('/api/feedback', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
});

// Middleware: add CORS headers to all feedback responses
feedback.use('/api/feedback', async (c, next) => {
  await next();
  c.header('Access-Control-Allow-Origin', '*');
});

feedback.post('/api/feedback', bodyLimit({ maxSize: FEEDBACK_BODY_LIMIT }), async (c) => {
  const body = await c.req.json<{ email?: string; category?: string; message?: string }>().catch(() => null);
  if (!body?.message || body.message.length < 5 || body.message.length > 5000) {
    return c.json({ error: 'message required (5-5000 chars)' }, 400);
  }
  const category = validateEnum(FEEDBACK_CATEGORIES, body.category, 'general');
  const id = crypto.randomUUID();
  const userAgent = c.req.header('User-Agent') ?? null;
  await c.env.DB.prepare(
    'INSERT INTO feedback (id, email, category, message, source, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, body.email ?? null, category, body.message, 'web', userAgent).run();

  // Notify operator via email
  if (c.env.RESEND_API_KEY) {
    const subject = `[Feedback] ${category}: ${body.message.slice(0, 60)}${body.message.length > 60 ? '…' : ''}`;
    const html = `<p><strong>Category:</strong> ${category}</p>
      <p><strong>From:</strong> ${body.email ?? 'anonymous'}</p>
      <p><strong>Message:</strong></p><p>${body.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'AEGIS <agent@example.com>', to: 'admin@example.com', subject, html }),
      });
    } catch { /* best-effort */ }
  }

  // ─── BizOps CRM integration ────────────────────────────────
  // Wire feedback to CRM contacts + interactions (mirrors voice funnel pattern)
  // TarotScript triage-cast runs first for deterministic classification
  const email = body.email;
  const message = body.message;
  if (email && c.env.BIZOPS && c.env.BIZOPS_TOKEN) {
    const crmWork = async () => {
      try {
        // ─── TarotScript triage-cast (zero-inference classification) ──
        let triage: { ticket_category?: string; urgency_level?: string; sentiment_signal?: string; complexity_tier?: string; needs_escalation?: boolean } = {};
        if (c.env.TAROTSCRIPT) {
          try {
            const triageRes = await c.env.TAROTSCRIPT.fetch('https://internal/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                spreadType: 'triage-cast',
                querent: {
                  id: email,
                  intention: message,
                  state: { source: 'human', channel: 'feedback_form', account_tier: 'free' },
                },
              }),
            });
            if (triageRes.ok) {
              const triageData = await triageRes.json<{ facts?: typeof triage }>();
              triage = triageData.facts ?? {};
              console.log(`[feedback] triage-cast: category=${triage.ticket_category} urgency=${triage.urgency_level} sentiment=${triage.sentiment_signal} escalation=${triage.needs_escalation}`);
            }
          } catch (err) {
            console.warn('[feedback] triage-cast failed:', err instanceof Error ? err.message : String(err));
          }
        }

        const bizops = new McpClient({
          url: 'https://your-bizops.example.com/mcp',
          token: c.env.BIZOPS_TOKEN,
          prefix: 'bizops',
          fetcher: c.env.BIZOPS,
          rpcPath: '/rpc',
        });

        const STACKBILT_ORG_ID = 'f876b6eb-332f-44a8-9683-342b2147d98b';

        // Upsert contact
        let contactId: string | undefined;
        try {
          const searchResult = await bizops.callTool('search_contacts', { query: email });
          const parsed = JSON.parse(searchResult);
          if (parsed.contacts?.length > 0) {
            contactId = parsed.contacts[0].id;
          }
        } catch {
          // Contact search failed — proceed to create
        }

        if (!contactId) {
          try {
            const name = email.split('@')[0] || 'Anonymous';
            const createResult = await bizops.callTool('create_contact', {
              org_id: STACKBILT_ORG_ID,
              name,
              email,
              source: 'FEEDBACK',
            });
            const parsed = JSON.parse(createResult);
            if (parsed.id) contactId = parsed.id;
          } catch {
            // Contact creation failed
          }
        }

        // Log interaction — enriched with triage-cast classification
        if (contactId) {
          const triageCategory = triage.ticket_category ?? category;
          const interactionBody = [
            `**Category:** ${triageCategory}`,
            triage.urgency_level ? `**Urgency:** ${triage.urgency_level}` : '',
            triage.sentiment_signal ? `**Sentiment:** ${triage.sentiment_signal}` : '',
            triage.complexity_tier ? `**Complexity:** ${triage.complexity_tier}` : '',
            triage.needs_escalation ? '**⚠ ESCALATION FLAGGED**' : '',
            `**Message:** ${message}`,
            userAgent ? `**User-Agent:** ${userAgent}` : '',
          ].filter(Boolean).join('\n');

          await bizops.callTool('log_interaction', {
            org_id: STACKBILT_ORG_ID,
            contact_id: contactId,
            type: 'FEEDBACK',
            direction: 'INBOUND',
            subject: `[${triageCategory}] ${message.slice(0, 80)}`,
            body: interactionBody.slice(0, 5000),
            channel: 'web_form',
            metadata_json: JSON.stringify({
              category: triageCategory,
              triage,
              user_agent: userAgent,
            }),
          });
        }

        // Create agenda item — priority informed by triage
        const triagePriority = triage.needs_escalation || triage.urgency_level === 'critical'
          ? 'high' as const
          : (category === 'bug' || triage.urgency_level === 'high')
            ? 'high' as const
            : 'medium' as const;
        await addAgendaItem(
          c.env.DB,
          `Follow up on ${triage.ticket_category ?? category} feedback from ${email}`,
          JSON.stringify({ feedback_id: id, category: triage.ticket_category ?? category, urgency: triage.urgency_level, sentiment: triage.sentiment_signal, email, message_preview: message.slice(0, 200) }),
          triagePriority,
        );
      } catch {
        // Non-fatal — feedback already stored in D1 + email sent
      }
    };

    if (c.executionCtx) {
      c.executionCtx.waitUntil(crmWork());
    } else {
      await crmWork();
    }
  }

  return c.json({ id, received: true });
});

feedback.get('/api/feedback', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const rows = await c.env.DB.prepare(
    'SELECT id, email, category, message, source, created_at FROM feedback ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();
  return c.json({ feedback: rows.results });
});
