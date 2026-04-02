// Bluesky API routes — direct AT Protocol operations via stored credentials
// All endpoints require bearer auth (same as other /api/* routes).

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../types.js';
import {
  postToBluesky,
  getAuthorFeed,
  likePost,
  repostPost,
  deleteBlueskyPost,
  getNotifications,
} from '../bluesky.js';

const BLUESKY_BODY_LIMIT = 100 * 1024;

const bluesky = new Hono<{ Bindings: Env }>();

function getCredentials(env: Env) {
  const handle = env.BLUESKY_HANDLE;
  const appPassword = env.BLUESKY_APP_PASSWORD;
  if (!handle || !appPassword) {
    throw new Error('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be configured');
  }
  return { handle, appPassword };
}

// POST /api/bluesky/post — create a new post
bluesky.post('/api/bluesky/post', bodyLimit({ maxSize: BLUESKY_BODY_LIMIT }), async (c) => {
  try {
    const { handle, appPassword } = getCredentials(c.env);
    const body = await c.req.json<{
      text: string;
      image_url?: string;
      image_alt?: string;
      link_url?: string;
      langs?: string[];
    }>();

    if (!body.text) return c.json({ error: 'text is required' }, 400);

    const result = await postToBluesky(handle, appPassword, {
      text: body.text,
      imageUrl: body.image_url,
      imageAlt: body.image_alt,
      langs: body.langs,
    });

    // Record in content_queue as published (live DB uses `content`/`media_url` columns)
    const id = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO content_queue (id, platform, content, media_url, link_url, scheduled_at, status, published_at, post_url)
      VALUES (?, 'bluesky', ?, ?, ?, datetime('now'), 'published', datetime('now'), ?)
    `).bind(id, body.text, body.image_url ?? null, body.link_url ?? null, result.url).run();

    return c.json({ uri: result.uri, cid: result.cid, url: result.url, queue_id: id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bluesky/post]', msg);
    return c.json({ error: msg }, 500);
  }
});

// GET /api/bluesky/feed — get our recent posts
bluesky.get('/api/bluesky/feed', async (c) => {
  const handle = c.env.BLUESKY_HANDLE || 'your-handle.bsky.social';
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);

  const posts = await getAuthorFeed(handle, limit);
  return c.json({ posts, count: posts.length });
});

// POST /api/bluesky/like — like a post
bluesky.post('/api/bluesky/like', bodyLimit({ maxSize: BLUESKY_BODY_LIMIT }), async (c) => {
  const { handle, appPassword } = getCredentials(c.env);
  const body = await c.req.json<{ uri: string; cid: string }>();

  if (!body.uri || !body.cid) return c.json({ error: 'uri and cid are required' }, 400);

  const result = await likePost(handle, appPassword, body.uri, body.cid);
  return c.json(result);
});

// POST /api/bluesky/repost — repost a post
bluesky.post('/api/bluesky/repost', bodyLimit({ maxSize: BLUESKY_BODY_LIMIT }), async (c) => {
  const { handle, appPassword } = getCredentials(c.env);
  const body = await c.req.json<{ uri: string; cid: string }>();

  if (!body.uri || !body.cid) return c.json({ error: 'uri and cid are required' }, 400);

  const result = await repostPost(handle, appPassword, body.uri, body.cid);
  return c.json(result);
});

// DELETE /api/bluesky/post — delete a post
bluesky.delete('/api/bluesky/post', async (c) => {
  const { handle, appPassword } = getCredentials(c.env);
  const body = await c.req.json<{ uri: string }>();

  if (!body.uri) return c.json({ error: 'uri is required' }, 400);

  await deleteBlueskyPost(handle, appPassword, body.uri);
  return c.json({ deleted: true, uri: body.uri });
});

// GET /api/bluesky/notifications — check notifications
bluesky.get('/api/bluesky/notifications', async (c) => {
  const { handle, appPassword } = getCredentials(c.env);
  const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);

  const notifications = await getNotifications(handle, appPassword, limit);
  return c.json({ notifications, count: notifications.length });
});

export { bluesky };
