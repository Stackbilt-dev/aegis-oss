// Content Drip — publishes scheduled posts to Bluesky
// Runs in the hourly cron. Checks for posts where scheduled_at <= now and status = 'scheduled'.

import { type EdgeEnv } from '../dispatch.js';
import { postToBluesky } from '../../bluesky.js';

export async function runContentDrip(env: EdgeEnv): Promise<void> {
  if (!env.blueskyAppPassword) {
    console.log('[content-drip] No BLUESKY_APP_PASSWORD configured, skipping');
    return;
  }

  const due = await env.db.prepare(`
    SELECT id, content, media_url, link_url, platform
    FROM content_queue
    WHERE status = 'scheduled' AND scheduled_at <= datetime('now') AND platform = 'bluesky'
    ORDER BY scheduled_at ASC
    LIMIT 5
  `).all<{ id: string; content: string; media_url: string | null; link_url: string | null; platform: string }>();

  if (due.results.length === 0) return;

  const handle = env.blueskyHandle ?? 'your-handle.bsky.social';

  for (const post of due.results) {
    try {
      const result = await postToBluesky(handle, env.blueskyAppPassword, {
        text: post.content,
        imageUrl: post.media_url ?? undefined,
      });

      await env.db.prepare(`
        UPDATE content_queue SET status = 'published', published_at = datetime('now'), post_url = ?
        WHERE id = ?
      `).bind(result.url, post.id).run();

      console.log(`[content-drip] Published: ${result.url}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await env.db.prepare(`
        UPDATE content_queue SET status = 'failed', error = ?
        WHERE id = ?
      `).bind(msg, post.id).run();
      console.error(`[content-drip] Failed to post ${post.id}: ${msg}`);
    }
  }
}
