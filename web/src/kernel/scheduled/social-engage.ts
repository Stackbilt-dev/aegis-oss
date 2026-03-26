// Social Engagement — autonomous Bluesky interaction
// Runs every 6 hours. Likes replies, follows back real accounts,
// replies to substantive comments with Workers AI.

import { type EdgeEnv } from '../dispatch.js';
import {
  getNotifications,
  likePost,
  followAccount,
  getProfile,
  postToBluesky,
  type BlueskyNotification,
} from '../../bluesky.js';

// ─── Guardrails ─────────────────────────────────────────────

const MAX_ACTIONS_PER_RUN = 10;       // Rate limit — don't spam
const MIN_FOLLOWER_POSTS = 3;         // Skip accounts with <3 posts (likely bots)
const NOTIFICATION_WINDOW_MS = 48 * 60 * 60 * 1000; // Only engage with last 48h

// Patterns that indicate bot/spam accounts
const SPAM_PATTERNS = [
  /^follow.*back/i,
  /crypto.*airdrop/i,
  /onlyfans/i,
  /dm.*me/i,
  /free.*money/i,
];

function isLikelySpam(notification: BlueskyNotification): boolean {
  const text = notification.text ?? '';
  const name = notification.author.displayName ?? '';
  return SPAM_PATTERNS.some(p => p.test(text) || p.test(name));
}

// ─── Main ───────────────────────────────────────────────────

export async function runSocialEngagement(env: EdgeEnv): Promise<void> {
  // Time gate: every 6 hours (01, 07, 13, 19 UTC) — offset from entropy (00, 06, 12, 18)
  const hour = new Date().getUTCHours();
  if (hour % 6 !== 1) return;

  if (!env.blueskyAppPassword) {
    console.log('[social-engage] No BLUESKY_APP_PASSWORD, skipping');
    return;
  }

  const handle = env.blueskyHandle ?? 'your-handle.bsky.social';

  // Cooldown: check last run via web_events
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'social_engage'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < 5 * 60 * 60 * 1000) return; // 5h cooldown
  }

  let notifications: BlueskyNotification[];
  try {
    notifications = await getNotifications(handle, env.blueskyAppPassword, 50);
  } catch (err) {
    console.error('[social-engage] Failed to fetch notifications:', err instanceof Error ? err.message : String(err));
    return;
  }

  if (notifications.length === 0) {
    console.log('[social-engage] No notifications');
    await updateWatermark(env.db);
    return;
  }

  // Filter to recent notifications only
  const cutoff = Date.now() - NOTIFICATION_WINDOW_MS;
  const recent = notifications.filter(n =>
    new Date(n.indexedAt).getTime() > cutoff && !isLikelySpam(n)
  );

  let actions = 0;
  const liked = new Set<string>();
  const followed = new Set<string>();

  for (const n of recent) {
    if (actions >= MAX_ACTIONS_PER_RUN) break;

    // ─── Like replies to our posts ────────────────────────
    if (n.reason === 'reply' && n.uri && n.cid && !liked.has(n.uri)) {
      try {
        await likePost(handle, env.blueskyAppPassword, n.uri, n.cid);
        liked.add(n.uri);
        actions++;
        console.log(`[social-engage] Liked reply from @${n.author.handle}`);
      } catch { /* skip — might already be liked */ }
    }

    // ─── Like quote posts ─────────────────────────────────
    if (n.reason === 'quote' && n.uri && n.cid && !liked.has(n.uri)) {
      try {
        await likePost(handle, env.blueskyAppPassword, n.uri, n.cid);
        liked.add(n.uri);
        actions++;
        console.log(`[social-engage] Liked quote from @${n.author.handle}`);
      } catch { /* skip */ }
    }

    // ─── Follow back real accounts ────────────────────────
    if (n.reason === 'follow' && n.author.did && !followed.has(n.author.did)) {
      try {
        const profile = await getProfile(n.author.handle);
        if (profile.postsCount >= MIN_FOLLOWER_POSTS) {
          await followAccount(handle, env.blueskyAppPassword, n.author.did);
          followed.add(n.author.did);
          actions++;
          console.log(`[social-engage] Followed back @${n.author.handle} (${profile.postsCount} posts)`);
        } else {
          console.log(`[social-engage] Skipped follow-back @${n.author.handle} (${profile.postsCount} posts — below threshold)`);
        }
      } catch { /* skip — might already follow */ }
    }

    // ─── Reply to substantive comments (Workers AI) ───────
    if (n.reason === 'reply' && n.text && n.text.length > 40 && env.ai && actions < MAX_ACTIONS_PER_RUN) {
      try {
        const reply = await generateReply(env.ai, n.text, n.author.handle);
        if (reply) {
          // Need the parent post URI/CID for threading
          // The notification uri IS the reply post — we need to reply TO it
          await postToBluesky(handle, env.blueskyAppPassword, { text: reply });
          actions++;
          console.log(`[social-engage] Replied to @${n.author.handle}: ${reply.slice(0, 50)}...`);
        }
      } catch (err) {
        console.warn(`[social-engage] Reply generation failed:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  await updateWatermark(env.db);
  console.log(`[social-engage] Complete: ${actions} actions (${liked.size} likes, ${followed.size} follows)`);
}

async function updateWatermark(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('social_engage', datetime('now'))"
  ).run();
}

// ─── Reply Generation ───────────────────────────────────────

async function generateReply(
  ai: Ai,
  incomingText: string,
  authorHandle: string,
): Promise<string | null> {
  const result = await ai.run('@cf/meta/llama-3.1-8b-instruct' as Parameters<Ai['run']>[0], {
    messages: [
      {
        role: 'system',
        content: `You are the operator's social media voice. Direct, builder-energy, anti-corporate. No emoji spam. No "excited to announce." Keep replies under 200 chars. Be genuine and conversational. If you can't add value, return SKIP.`,
      },
      {
        role: 'user',
        content: `@${authorHandle} replied to our Bluesky post: "${incomingText}"\n\nWrite a brief, genuine reply. Return ONLY the reply text, or SKIP if there's nothing meaningful to add.`,
      },
    ],
    max_tokens: 100,
  }) as { response?: string };

  const reply = result.response?.trim();
  if (!reply || reply === 'SKIP' || reply.length < 5) return null;

  // Safety: truncate to 300 chars (Bluesky limit)
  return reply.length > 280 ? reply.slice(0, 277) + '...' : reply;
}
