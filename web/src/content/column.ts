// Stub — full implementation not yet extracted to OSS

import { sanitizeForBlog } from '../sanitize.js';

export interface ColumnOutput {
  title: string;
  slug: string;
  meta_description: string;
  body: string;
}

export async function generateColumn(
  apiKey: string,
  model: string,
  baseUrl: string,
  activityContext: string,
): Promise<{ output: ColumnOutput; cost: number }> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: `Write an AEGIS column based on recent activity:\n\n${activityContext}` }],
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
  const output: ColumnOutput = {
    title: parsed.title ?? '',
    slug: parsed.slug ?? '',
    meta_description: parsed.meta_description ?? '',
    body: sanitizeForBlog(parsed.body ?? ''),
  };

  if (!output.title || !output.slug || !output.body) {
    throw new Error('Invalid column output structure');
  }

  const cost = (data.usage.input_tokens * 3 + data.usage.output_tokens * 15) / 1_000_000;

  return { output, cost };
}

export async function writeColumn(
  db: D1Database,
  output: ColumnOutput,
): Promise<string> {
  const id = crypto.randomUUID();

  await db.prepare(
    `INSERT INTO roundtables (id, topic, slug, meta_description, header_image_url, cta_url, status, quick_specs, synthesis)
     VALUES (?, 'aegis_column', ?, ?, NULL, ?, 'draft', '[]', ?)`,
  ).bind(
    id,
    output.slug,
    output.meta_description,
    'https://example.com',
    output.body,
  ).run();

  return id;
}
