// Stub — full implementation not yet extracted to OSS

import { sanitizeForBlog } from '../sanitize.js';

export interface RoundtableOutput {
  title: string;
  slug: string;
  meta_description: string;
  executive_summary: Array<{ metric: string; status: string; takeaway: string }>;
  quick_specs: Array<{ label: string; value: string }>;
  contributions: Array<{ persona: string; content: string; key_findings: string[] }>;
  synthesis: string;
}

const CTA_URLS: Record<string, string> = {
  'demo-app': 'https://demo-app.example.com',
  'img-forge': 'https://img-forge.example.com',
};

// ─── pickNextTopic ──────────────────────────────────────────

export async function pickNextTopic(
  db: D1Database,
): Promise<{ id: string; topic: string; context: string; cta_product: string } | null> {
  const topic = await db.prepare(
    "SELECT id, topic, context, cta_product FROM topic_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
  ).first<{ id: string; topic: string; context: string; cta_product: string }>();

  if (!topic) return null;

  await db.prepare(
    "UPDATE topic_queue SET status = 'used' WHERE id = ?"
  ).bind(topic.id).run();

  return topic;
}

// ─── generateRoundtable ─────────────────────────────────────

export async function generateRoundtable(
  apiKey: string,
  model: string,
  baseUrl: string,
  topic: string,
  context: string | null,
  ctaProduct: string | null,
): Promise<{ output: RoundtableOutput; cost: number }> {
  let userMessage = `Generate a roundtable discussion about: ${topic}`;
  if (context) userMessage += `\n\nCONTEXT: ${context}`;
  if (ctaProduct) userMessage += `\nCTA_PRODUCT: ${ctaProduct}`;

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  let text = data.content[0].text;
  text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');

  const parsed = JSON.parse(text);
  const output: RoundtableOutput = {
    title: parsed.title ?? '',
    slug: parsed.slug ?? '',
    meta_description: parsed.meta_description ?? '',
    executive_summary: Array.isArray(parsed.executive_summary) ? parsed.executive_summary : [],
    quick_specs: Array.isArray(parsed.quick_specs) ? parsed.quick_specs : [],
    contributions: (Array.isArray(parsed.contributions) ? parsed.contributions : []).map(
      (c: any) => ({
        persona: c.persona ?? '',
        content: sanitizeForBlog(c.content ?? ''),
        key_findings: Array.isArray(c.key_findings) ? c.key_findings : [],
      }),
    ),
    synthesis: parsed.synthesis ?? '',
  };

  if (!output.title || output.contributions.length === 0) {
    throw new Error('Invalid roundtable output structure');
  }

  const cost = (data.usage.input_tokens * 3 + data.usage.output_tokens * 15) / 1_000_000;

  return { output, cost };
}

// ─── writeRoundtable ────────────────────────────────────────

export async function writeRoundtable(
  db: D1Database,
  output: RoundtableOutput,
  ctaProduct: string | null,
  headerImageUrl: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  const ctaUrl = (ctaProduct && CTA_URLS[ctaProduct]) ?? 'https://example.com';

  await db.prepare(
    `INSERT INTO roundtables (id, topic, slug, meta_description, header_image_url, cta_url, status, executive_summary, quick_specs, synthesis)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).bind(
    id,
    output.title,
    output.slug,
    output.meta_description,
    headerImageUrl,
    ctaUrl,
    JSON.stringify(output.executive_summary),
    JSON.stringify(output.quick_specs),
    output.synthesis,
  ).run();

  for (const contribution of output.contributions) {
    await db.prepare(
      'INSERT INTO contributions (roundtable_id, persona, content, key_findings) VALUES (?, ?, ?, ?)'
    ).bind(id, contribution.persona, contribution.content, JSON.stringify(contribution.key_findings)).run();
  }

  return id;
}

// ─── queueRoundtableTopic ───────────────────────────────────

export async function queueRoundtableTopic(
  db: D1Database,
  topic: string,
  context: string | null,
  ctaProduct: string | null,
  source: string,
): Promise<string> {
  // Check for duplicate
  const existing = await db.prepare(
    "SELECT id FROM topic_queue WHERE topic = ? AND status = 'queued'"
  ).bind(topic).first<{ id: string }>();

  if (existing) return existing.id;

  const id = crypto.randomUUID();

  await db.prepare(
    'INSERT INTO topic_queue (id, topic, context, cta_product, source, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, topic, context, ctaProduct ?? 'general', source, 'queued').run();

  return id;
}
