// ─── Bluesky AT Protocol Client ──────────────────────────────
// Posts to Bluesky via the AT Protocol API.
// Auth: app password → createSession → accessJwt.
// Supports: text posts, links (facets), images (blob upload).

const BSKY_API = 'https://bsky.social/xrpc';

interface BlueskySession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

interface BlueskyPostResult {
  uri: string;
  cid: string;
  url: string; // human-readable URL
}

// ─── Auth ────────────────────────────────────────────────────

let cachedSession: { session: BlueskySession; expiresAt: number } | null = null;

async function createSession(handle: string, appPassword: string): Promise<BlueskySession> {
  // Reuse cached session if not expired (tokens last ~2 hours, refresh at 90 min)
  if (cachedSession && Date.now() < cachedSession.expiresAt) {
    return cachedSession.session;
  }

  const res = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky auth failed: ${res.status} ${err}`);
  }

  const session = await res.json() as BlueskySession;
  cachedSession = { session, expiresAt: Date.now() + 90 * 60 * 1000 };
  return session;
}

// ─── Facets (links in post text) ─────────────────────────────

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; did?: string }>;
}

function extractLinkFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  const urlRegex = /https?:\/\/[^\s)]+/g;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0];
    // Byte offsets (AT Protocol uses UTF-8 byte positions)
    const encoder = new TextEncoder();
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(url).length;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
  }

  return facets;
}

// ─── Image Upload ────────────────────────────────────────────

interface BlobRef {
  $type: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

async function uploadImage(
  session: BlueskySession,
  imageUrl: string,
): Promise<BlobRef> {
  // Fetch the image
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);

  const contentType = imgRes.headers.get('content-type') ?? 'image/png';
  const imageData = await imgRes.arrayBuffer();

  // Upload blob to Bluesky
  const uploadRes = await fetch(`${BSKY_API}/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': contentType,
    },
    body: imageData,
    signal: AbortSignal.timeout(30_000),
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Bluesky blob upload failed: ${uploadRes.status} ${err}`);
  }

  const result = await uploadRes.json() as { blob: BlobRef };
  return result.blob;
}

// ─── Post ────────────────────────────────────────────────────

export interface BlueskyPostOptions {
  text: string;
  imageUrl?: string;
  imageAlt?: string;
  langs?: string[];
}

// ─── Public API: re-export session creator for routes ────────

export { createSession, extractLinkFacets, uploadImage, BSKY_API };
export type { BlueskySession, BlobRef, Facet };

export async function postToBluesky(
  handle: string,
  appPassword: string,
  options: BlueskyPostOptions,
): Promise<BlueskyPostResult> {
  const session = await createSession(handle, appPassword);

  // Truncate to 300 chars (Bluesky limit)
  const text = options.text.length > 300
    ? options.text.slice(0, 297) + '...'
    : options.text;

  const facets = extractLinkFacets(text);

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text,
    langs: options.langs ?? ['en'],
    createdAt: new Date().toISOString(),
  };

  if (facets.length > 0) {
    record.facets = facets;
  }

  // Upload and embed image if provided
  if (options.imageUrl) {
    try {
      const blob = await uploadImage(session, options.imageUrl);
      record.embed = {
        $type: 'app.bsky.embed.images',
        images: [{
          alt: options.imageAlt ?? '',
          image: blob,
        }],
      };
    } catch (err) {
      console.warn('[bluesky] Image upload failed (posting without image):', err instanceof Error ? err.message : String(err));
    }
  }

  const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky post failed: ${res.status} ${err}`);
  }

  const result = await res.json() as { uri: string; cid: string };

  // Convert AT URI to web URL
  // at://did:plc:xxx/app.bsky.feed.post/rkey → https://bsky.app/profile/handle/post/rkey
  const rkey = result.uri.split('/').pop() ?? '';
  const url = `https://bsky.app/profile/${session.handle}/post/${rkey}`;

  console.log(`[bluesky] Posted: ${url}`);

  return { uri: result.uri, cid: result.cid, url };
}

// ─── Feed ───────────────────────────────────────────────────

export interface BlueskyFeedItem {
  uri: string;
  cid: string;
  text: string;
  createdAt: string;
  likeCount: number;
  repostCount: number;
  replyCount: number;
  url: string;
}

export async function getAuthorFeed(
  actor: string,
  limit = 20,
): Promise<BlueskyFeedItem[]> {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=${limit}&filter=posts_no_replies`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky feed fetch failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { feed: Array<{ post: Record<string, unknown> }> };

  return data.feed.map((item) => {
    const p = item.post as Record<string, unknown>;
    const rec = p.record as Record<string, unknown>;
    const author = p.author as Record<string, unknown>;
    const handle = (author.handle as string) ?? actor;
    const rkey = (p.uri as string).split('/').pop() ?? '';
    return {
      uri: p.uri as string,
      cid: p.cid as string,
      text: (rec.text as string) ?? '',
      createdAt: (rec.createdAt as string) ?? '',
      likeCount: (p.likeCount as number) ?? 0,
      repostCount: (p.repostCount as number) ?? 0,
      replyCount: (p.replyCount as number) ?? 0,
      url: `https://bsky.app/profile/${handle}/post/${rkey}`,
    };
  });
}

// ─── Like ───────────────────────────────────────────────────

export async function likePost(
  handle: string,
  appPassword: string,
  targetUri: string,
  targetCid: string,
): Promise<{ uri: string }> {
  const session = await createSession(handle, appPassword);

  const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.like',
      record: {
        $type: 'app.bsky.feed.like',
        subject: { uri: targetUri, cid: targetCid },
        createdAt: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky like failed: ${res.status} ${err}`);
  }

  const result = await res.json() as { uri: string };
  return { uri: result.uri };
}

// ─── Repost ─────────────────────────────────────────────────

export async function repostPost(
  handle: string,
  appPassword: string,
  targetUri: string,
  targetCid: string,
): Promise<{ uri: string }> {
  const session = await createSession(handle, appPassword);

  const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.repost',
      record: {
        $type: 'app.bsky.feed.repost',
        subject: { uri: targetUri, cid: targetCid },
        createdAt: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky repost failed: ${res.status} ${err}`);
  }

  const result = await res.json() as { uri: string };
  return { uri: result.uri };
}

// ─── Delete Post ────────────────────────────────────────────

export async function deleteBlueskyPost(
  handle: string,
  appPassword: string,
  postUri: string,
): Promise<void> {
  const session = await createSession(handle, appPassword);
  const rkey = postUri.split('/').pop() ?? '';

  const res = await fetch(`${BSKY_API}/com.atproto.repo.deleteRecord`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      rkey,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky delete failed: ${res.status} ${err}`);
  }
}

// ─── Notifications ──────────────────────────────────────────

export interface BlueskyNotification {
  uri: string;
  cid: string;
  reason: string; // 'like' | 'repost' | 'follow' | 'mention' | 'reply' | 'quote'
  author: { handle: string; displayName?: string; did: string };
  indexedAt: string;
  text?: string;
}

export async function getNotifications(
  handle: string,
  appPassword: string,
  limit = 30,
): Promise<BlueskyNotification[]> {
  const session = await createSession(handle, appPassword);

  const res = await fetch(`${BSKY_API}/app.bsky.notification.listNotifications?limit=${limit}`, {
    headers: { 'Authorization': `Bearer ${session.accessJwt}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky notifications failed: ${res.status} ${err}`);
  }

  const data = await res.json() as { notifications: Array<Record<string, unknown>> };

  return data.notifications.map((n) => {
    const author = n.author as Record<string, unknown>;
    const rec = n.record as Record<string, unknown> | undefined;
    return {
      uri: n.uri as string,
      cid: n.cid as string,
      reason: n.reason as string,
      author: {
        handle: author.handle as string,
        displayName: author.displayName as string | undefined,
        did: author.did as string,
      },
      indexedAt: n.indexedAt as string,
      text: rec?.text as string | undefined,
    };
  });
}

// ─── Follow ─────────────────────────────────────────────────

export async function followAccount(
  handle: string,
  appPassword: string,
  targetDid: string,
): Promise<{ uri: string }> {
  const session = await createSession(handle, appPassword);

  const res = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.accessJwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.graph.follow',
      record: {
        $type: 'app.bsky.graph.follow',
        subject: targetDid,
        createdAt: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Bluesky follow failed: ${res.status} ${err}`);
  }

  const result = await res.json() as { uri: string };
  return { uri: result.uri };
}

// ─── Profile ────────────────────────────────────────────────

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
}

export async function getProfile(actor: string): Promise<BlueskyProfile> {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Profile fetch failed: ${res.status}`);

  const data = await res.json() as Record<string, unknown>;
  return {
    did: data.did as string,
    handle: data.handle as string,
    displayName: data.displayName as string | undefined,
    description: data.description as string | undefined,
    followersCount: (data.followersCount as number) ?? 0,
    followsCount: (data.followsCount as number) ?? 0,
    postsCount: (data.postsCount as number) ?? 0,
  };
}
