// Content pipeline in-process tool definitions + handlers
// Roundtable articles + Dispatch newsletter generation

import { runRoundtableGeneration, queueRoundtableTopic } from '../content/index.js';
import { runDispatchGeneration } from '../dispatch.js';

// ─── Tool definitions ────────────────────────────────────────

const LIST_ROUNDTABLE_DRAFTS_TOOL = {
  name: 'list_roundtable_drafts',
  description: 'List unpublished roundtable article drafts.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const PUBLISH_ROUNDTABLE_TOOL = {
  name: 'publish_roundtable',
  description: 'Publish a roundtable article draft by slug.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slug: { type: 'string', description: 'The draft slug to publish' },
    },
    required: ['slug'],
  },
};

const LIST_ROUNDTABLE_TOPICS_TOOL = {
  name: 'list_roundtable_topics',
  description: 'List queued roundtable topics.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'Filter by status (default: queued)' },
    },
    required: [],
  },
};

const GENERATE_ROUNDTABLE_TOOL = {
  name: 'generate_roundtable',
  description: 'Generate a new roundtable article from the topic queue.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const QUEUE_ROUNDTABLE_TOPIC_TOOL = {
  name: 'queue_roundtable_topic',
  description: 'Add a topic to the roundtable generation queue.',
  input_schema: {
    type: 'object' as const,
    properties: {
      topic: { type: 'string', description: 'Topic title' },
      context: { type: 'string', description: 'Why this topic is relevant' },
      cta_product: { type: 'string', description: 'Product to feature in the CTA' },
    },
    required: ['topic'],
  },
};

const LIST_DISPATCH_DRAFTS_TOOL = {
  name: 'list_dispatch_drafts',
  description: 'List unpublished dispatch newsletter drafts.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

const PUBLISH_DISPATCH_TOOL = {
  name: 'publish_dispatch',
  description: 'Publish a dispatch newsletter draft by slug.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slug: { type: 'string', description: 'The dispatch slug to publish' },
    },
    required: ['slug'],
  },
};

const GENERATE_DISPATCH_TOOL = {
  name: 'generate_dispatch',
  description: 'Generate a new dispatch newsletter.',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
};

export const ROUNDTABLE_TOOLS = [
  LIST_ROUNDTABLE_DRAFTS_TOOL,
  PUBLISH_ROUNDTABLE_TOOL,
  LIST_ROUNDTABLE_TOPICS_TOOL,
  GENERATE_ROUNDTABLE_TOOL,
  QUEUE_ROUNDTABLE_TOPIC_TOOL,
];

export const DISPATCH_TOOLS = [
  LIST_DISPATCH_DRAFTS_TOOL,
  PUBLISH_DISPATCH_TOOL,
  GENERATE_DISPATCH_TOOL,
];

// ─── Handler ─────────────────────────────────────────────────

export async function handleContentTool(
  name: string,
  input: Record<string, unknown>,
  roundtableDb: D1Database,
  aegisDb: D1Database,
  anthropicConfig?: { apiKey: string; model: string; baseUrl: string },
  githubToken?: string,
  githubRepo?: string,
): Promise<string | null> {
  // ── Roundtable tools ──
  if (name === 'list_roundtable_drafts') {
    const { results } = await roundtableDb.prepare(
      "SELECT slug, title, created_at FROM roundtables WHERE status = 'draft' ORDER BY created_at DESC LIMIT 20"
    ).all<{ slug: string; title: string; created_at: string }>();
    if (results.length === 0) return 'No draft roundtables found.';
    return results.map(r =>
      `**${r.title}** (${r.slug}) — ${r.created_at.slice(0, 10)} [preview]`
    ).join('\n');
  }

  if (name === 'publish_roundtable') {
    const slug = input.slug as string;
    const result = await roundtableDb.prepare(
      "UPDATE roundtables SET status = 'published', published_at = datetime('now') WHERE slug = ? AND status = 'draft'"
    ).bind(slug).run();
    if ((result.meta.changes ?? 0) === 0) return `No draft roundtable found with slug "${slug}".`;
    return `Published roundtable "${slug}".`;
  }

  if (name === 'list_roundtable_topics') {
    const status = (input.status as string | undefined) ?? 'queued';
    const { results } = await roundtableDb.prepare(
      "SELECT topic, cta_product, status, source FROM topic_queue WHERE status = ? ORDER BY created_at DESC LIMIT 20"
    ).bind(status).all<{ topic: string; cta_product: string; status: string; source: string }>();
    if (results.length === 0) return `No topics found with status "${status}".`;
    return results.map(t =>
      `- **${t.topic}** → ${t.cta_product} [${t.status}] (${t.source})`
    ).join('\n');
  }

  if (name === 'generate_roundtable') {
    if (!anthropicConfig) return 'Error: Anthropic config not available.';
    const result = await runRoundtableGeneration(
      roundtableDb, aegisDb,
      anthropicConfig.apiKey, anthropicConfig.model, anthropicConfig.baseUrl,
    );
    return `Generated roundtable: "${result.title}" (${result.slug}) — saved as draft. Cost: $${result.cost.toFixed(4)}`;
  }

  if (name === 'queue_roundtable_topic') {
    const topic = input.topic as string | undefined;
    if (!topic) return 'Error: topic is required.';
    const context = (input.context as string | undefined) ?? '';
    const ctaProduct = (input.cta_product as string | undefined) ?? '';
    await queueRoundtableTopic(roundtableDb, topic, context, ctaProduct, 'aegis_auto');
    return `Queued topic: "${topic}" → ${ctaProduct || 'no product'} (source: aegis_auto)`;
  }

  // ── Dispatch tools ──
  if (name === 'list_dispatch_drafts') {
    const { results } = await roundtableDb.prepare(
      "SELECT slug, title, paper_title, created_at FROM dispatches WHERE status = 'draft' ORDER BY created_at DESC LIMIT 20"
    ).all<{ slug: string; title: string; paper_title: string; created_at: string }>();
    if (results.length === 0) return 'No draft dispatches found.';
    return results.map(d =>
      `**${d.title}** (${d.slug}) — paper: ${d.paper_title} — ${d.created_at.slice(0, 10)}`
    ).join('\n');
  }

  if (name === 'publish_dispatch') {
    const slug = input.slug as string;
    const result = await roundtableDb.prepare(
      "UPDATE dispatches SET status = 'published', published_at = datetime('now') WHERE slug = ? AND status = 'draft'"
    ).bind(slug).run();
    if ((result.meta.changes ?? 0) === 0) return `No draft dispatch found with slug "${slug}".`;
    return `Published dispatch "${slug}".`;
  }

  if (name === 'generate_dispatch') {
    if (!anthropicConfig) return 'Error: Anthropic config not available.';
    const result = await runDispatchGeneration(
      roundtableDb, aegisDb,
      anthropicConfig.apiKey, anthropicConfig.model, anthropicConfig.baseUrl,
      githubToken, githubRepo,
    );
    return `Generated dispatch: "${result.title}" (${result.slug}) — saved as draft. Cost: $${result.cost.toFixed(4)}`;
  }

  return null;
}
