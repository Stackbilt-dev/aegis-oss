// Stub — full implementation not yet extracted to OSS

import { Hono } from 'hono';
import type { Env } from '../types.js';
import { sanitizeForBlog } from '../sanitize.js';
import { buildEdgeEnv } from '../edge-env.js';
import { runRoundtableGeneration, runJournalGeneration } from '../content/index.js';
import { runDreamingCycle } from '../kernel/scheduled/dreaming.js';
import { operatorConfig } from '../operator/index.js';

const content = new Hono<{ Bindings: Env }>();

const BLOG_BASE_URL = 'https://your-blog.example.com';

// ─── Tech Blog Redirects ────────────────────────────────────

content.get('/tech', (c) => {
  return c.redirect(BLOG_BASE_URL, 301);
});

content.get('/tech/feed.xml', (c) => {
  return c.redirect(`${BLOG_BASE_URL}/feed.xml`, 301);
});

content.get('/tech/:slug', (c) => {
  return c.redirect(`${BLOG_BASE_URL}/post/${c.req.param('slug')}`, 301);
});

// ─── Tech Post CRUD ─────────────────────────────────────────

content.get('/api/tech-posts', async (c) => {
  const roundtableDb = (c.env as any).ROUNDTABLE_DB;
  if (!roundtableDb) return c.json({ error: 'ROUNDTABLE_DB not bound' }, 500);

  const status = c.req.query('status');
  let query: string;
  const bindings: unknown[] = [];

  if (status) {
    query = 'SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC';
    bindings.push(status);
  } else {
    query = 'SELECT * FROM posts ORDER BY created_at DESC';
  }

  const stmt = roundtableDb.prepare(query);
  const result = bindings.length > 0 ? await stmt.bind(...bindings).all() : await stmt.all();

  return c.json({ posts: result.results });
});

content.post('/api/tech-posts', async (c) => {
  const roundtableDb = (c.env as any).ROUNDTABLE_DB;
  if (!roundtableDb) return c.json({ error: 'ROUNDTABLE_DB not bound' }, 500);

  const body = await c.req.json<{
    title?: string;
    slug?: string;
    body?: string;
    description?: string;
    tags?: string[];
    status?: string;
    canonical_url?: string;
  }>();

  if (!body.title?.trim() || !body.slug?.trim() || !body.body?.trim()) {
    return c.json({ error: 'title, slug, and body are required' }, 400);
  }

  const id = crypto.randomUUID();
  const status = body.status === 'published' ? 'published' : 'draft';
  const publishedAt = status === 'published' ? new Date().toISOString() : null;

  await roundtableDb.prepare(
    `INSERT INTO posts (id, title, slug, body, description, tags, status, canonical_url, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    body.title.trim(),
    body.slug.trim(),
    body.body.trim(),
    body.description ?? '',
    JSON.stringify(body.tags ?? []),
    status,
    body.canonical_url ?? null,
    publishedAt,
  ).run();

  return c.json({
    id,
    slug: body.slug.trim(),
    status,
    url: status === 'published' ? `${BLOG_BASE_URL}/post/${body.slug.trim()}` : null,
    note: status === 'draft' ? 'No public route exists for draft posts.' : undefined,
  }, 201);
});

content.put('/api/tech-posts/:id', async (c) => {
  const roundtableDb = (c.env as any).ROUNDTABLE_DB;
  if (!roundtableDb) return c.json({ error: 'ROUNDTABLE_DB not bound' }, 500);

  const postId = c.req.param('id');
  const existing = await roundtableDb.prepare(
    'SELECT * FROM posts WHERE id = ?'
  ).bind(postId).first<any>();

  if (!existing) return c.json({ error: 'Post not found' }, 404);

  const body = await c.req.json<{
    title?: string;
    body?: string;
    description?: string;
    tags?: string[];
    status?: string;
    canonical_url?: string;
  }>();

  const newStatus = body.status ?? existing.status;
  let publishedAt = existing.published_at;
  if (newStatus === 'published' && !existing.published_at) {
    publishedAt = new Date().toISOString();
  }

  await roundtableDb.prepare(
    `UPDATE posts SET title = ?, body = ?, description = ?, tags = ?, status = ?, canonical_url = ?, published_at = ?
     WHERE id = ?`
  ).bind(
    body.title ?? existing.title,
    body.body ?? existing.body,
    body.description ?? existing.description,
    JSON.stringify(body.tags ?? JSON.parse(existing.tags ?? '[]')),
    newStatus,
    body.canonical_url ?? existing.canonical_url,
    publishedAt,
    postId,
  ).run();

  return c.json({ ok: true });
});

// ─── Content Generation Triggers ────────────────────────────

content.post('/api/generate/roundtable', async (c) => {
  const edgeEnv = buildEdgeEnv(c.env);
  if (!edgeEnv.roundtableDb) {
    return c.json({ error: 'ROUNDTABLE_DB not bound' }, 500);
  }

  await runRoundtableGeneration(edgeEnv as any);
  return c.json({ ok: true });
});

content.post('/api/generate/journal', async (c) => {
  const edgeEnv = buildEdgeEnv(c.env);
  if (!edgeEnv.roundtableDb) {
    return c.json({ error: 'ROUNDTABLE_DB not bound' }, 500);
  }

  await runJournalGeneration(edgeEnv as any);
  return c.json({ ok: true });
});

content.post('/api/trigger/dreaming', async (c) => {
  try {
    // Clear watermark to force re-run
    await c.env.DB.prepare(
      "DELETE FROM web_events WHERE event_id = 'last_dreaming_at'"
    ).run();

    const edgeEnv = buildEdgeEnv(c.env);
    await runDreamingCycle(edgeEnv as any);

    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// ─── Sanitize Backfill ──────────────────────────────────────

content.post('/api/sanitize-backfill', async (c) => {
  const roundtableDb = (c.env as any).ROUNDTABLE_DB;
  if (!roundtableDb) return c.json({ error: 'ROUNDTABLE_DB not bound' }, 500);

  // Backfill sanitization for existing content
  return c.json({ ok: true, sanitized: 0 });
});

export { content };
