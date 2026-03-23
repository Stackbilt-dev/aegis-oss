// Stub — full implementation not yet extracted to OSS

import { sanitizeForBlog } from '../sanitize.js';

export interface JournalOutput {
  title: string;
  slug: string;
  meta_description: string;
  body: string;
  mood: string;
  tags: string[];
}

export async function generateJournal(
  apiKey: string,
  model: string,
  baseUrl: string,
  activityContext: string,
): Promise<{ output: JournalOutput; cost: number }> {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1536,
      messages: [{ role: 'user', content: `Write an AEGIS journal entry based on recent activity:\n\n${activityContext}` }],
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
  const output: JournalOutput = {
    title: parsed.title ?? '',
    slug: parsed.slug ?? '',
    meta_description: parsed.meta_description ?? '',
    body: sanitizeForBlog(parsed.body ?? ''),
    mood: parsed.mood ?? 'focused',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };

  if (!output.title || !output.slug || !output.body) {
    throw new Error('Invalid journal output structure');
  }

  const cost = (data.usage.input_tokens * 3 + data.usage.output_tokens * 15) / 1_000_000;

  return { output, cost };
}

export async function writeJournal(
  db: D1Database,
  output: JournalOutput,
  headerImageUrl: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();

  const quickSpecs = JSON.stringify([
    { label: 'Mood', value: output.mood },
    ...output.tags.map(tag => ({ label: 'Tag', value: tag })),
  ]);

  await db.prepare(
    `INSERT INTO roundtables (id, topic, slug, meta_description, header_image_url, cta_url, status, quick_specs, synthesis)
     VALUES (?, 'aegis_journal', ?, ?, ?, 'https://example.com', 'published', ?, ?)`,
  ).bind(
    id,
    output.slug,
    output.meta_description,
    headerImageUrl,
    quickSpecs,
    output.body,
  ).run();

  return id;
}
