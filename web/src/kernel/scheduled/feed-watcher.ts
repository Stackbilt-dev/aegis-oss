import { type EdgeEnv } from '../dispatch.js';
import { recordMemory } from '../memory-adapter.js';

// --- Feed Watcher ---
// Polls RSS/Atom feeds every 6 hours, stores new entries in D1,
// and records summaries to semantic memory for the dreaming cycle.
//
// Feeds are stored in `watched_feeds` table. New entries land in
// `feed_entries` and get recorded to memory under topic 'feed_intel'.

const FEED_POLL_HOURS = 6;
const MAX_NEW_ENTRIES_PER_FEED = 5;
const MAX_MEMORY_RECORDS_PER_RUN = 10;

interface FeedRow {
  id: string;
  url: string;
  title: string | null;
  category: string;
  last_entry_id: string | null;
}

interface ParsedEntry {
  id: string;
  title: string;
  link: string;
  summary: string;
  published: string | null;
}

// --- Lightweight RSS/Atom parser (no dependencies) ---

function extractTag(xml: string, tag: string): string {
  // Match <tag>...</tag> or <tag ...>...</tag>
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function parseEntries(xml: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  // Try Atom <entry> first, then RSS <item>
  const isAtom = xml.includes('<feed') || xml.includes('<entry');
  const tagName = isAtom ? 'entry' : 'item';
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
  const items = xml.match(re) || [];

  for (const item of items.slice(0, MAX_NEW_ENTRIES_PER_FEED * 2)) {
    const title = extractTag(item, 'title');
    if (!title) continue;

    let link = '';
    if (isAtom) {
      // Atom: <link href="..." rel="alternate" />
      link = extractAttr(item, 'link', 'href') || extractTag(item, 'link');
    } else {
      link = extractTag(item, 'link');
    }

    const id = isAtom
      ? extractTag(item, 'id') || link
      : extractTag(item, 'guid') || link;

    const summary = extractTag(item, 'summary')
      || extractTag(item, 'description')
      || extractTag(item, 'content');

    const published = extractTag(item, 'published')
      || extractTag(item, 'pubDate')
      || extractTag(item, 'updated')
      || null;

    if (id) {
      entries.push({
        id,
        title,
        link,
        summary: summary.replace(/<[^>]+>/g, '').slice(0, 500), // strip HTML, cap length
        published,
      });
    }
  }

  return entries;
}

// --- Main ---

export async function runFeedWatcher(env: EdgeEnv): Promise<void> {
  // Time gate: every 6 hours (0, 6, 12, 18 UTC)
  const hour = new Date().getUTCHours();
  if (hour % FEED_POLL_HOURS !== 0) return;

  // Cooldown: 5 hours since last run
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'feed_watcher'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < 5 * 60 * 60 * 1000) return;
  }

  // Fetch enabled feeds
  const feeds = await env.db.prepare(
    'SELECT id, url, title, category, last_entry_id FROM watched_feeds WHERE enabled = 1'
  ).all<FeedRow>();

  if (!feeds.results?.length) {
    console.log('[feed-watcher] No feeds configured -- skipping');
    return;
  }

  let totalNew = 0;
  let memoryRecords = 0;

  for (const feed of feeds.results) {
    try {
      const resp = await fetch(feed.url, {
        headers: { 'User-Agent': 'AEGIS-FeedWatcher/1.0' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        console.warn(`[feed-watcher] ${feed.url} returned ${resp.status}`);
        continue;
      }

      const xml = await resp.text();
      const entries = parseEntries(xml);

      if (!entries.length) continue;

      // Find new entries (not yet in DB)
      let newCount = 0;
      for (const entry of entries) {
        if (newCount >= MAX_NEW_ENTRIES_PER_FEED) break;

        // Skip if already ingested
        const existing = await env.db.prepare(
          'SELECT 1 FROM feed_entries WHERE feed_id = ? AND entry_id = ?'
        ).bind(feed.id, entry.id).first();

        if (existing) continue;

        // Insert new entry
        await env.db.prepare(
          `INSERT INTO feed_entries (feed_id, entry_id, title, link, summary, published_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(feed.id, entry.id, entry.title, entry.link, entry.summary, entry.published).run();

        newCount++;
        totalNew++;

        // Record to memory if binding available
        if (env.memoryBinding && memoryRecords < MAX_MEMORY_RECORDS_PER_RUN) {
          try {
            const fact = `[${feed.category}] ${feed.title || 'Feed'}: "${entry.title}"${entry.summary ? ` -- ${entry.summary.slice(0, 200)}` : ''}${entry.link ? ` (${entry.link})` : ''}`;
            await recordMemory(
              env.memoryBinding,
              'feed_intel',
              fact,
              0.75,
              'feed_watcher',
            );
            await env.db.prepare(
              'UPDATE feed_entries SET recorded_to_memory = 1 WHERE feed_id = ? AND entry_id = ?'
            ).bind(feed.id, entry.id).run();
            memoryRecords++;
          } catch (err) {
            console.warn('[feed-watcher] Memory record failed:', err instanceof Error ? err.message : String(err));
          }
        }
      }

      // Update watermark
      if (entries.length > 0) {
        await env.db.prepare(
          "UPDATE watched_feeds SET last_fetched_at = datetime('now'), last_entry_id = ? WHERE id = ?"
        ).bind(entries[0].id, feed.id).run();
      }

      if (newCount > 0) {
        console.log(`[feed-watcher] ${feed.title || feed.url}: ${newCount} new entries`);
      }
    } catch (err) {
      console.warn(`[feed-watcher] Error fetching ${feed.url}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Update watermark
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('feed_watcher', datetime('now'))"
  ).run();

  if (totalNew > 0) {
    console.log(`[feed-watcher] Done: ${totalNew} new entries, ${memoryRecords} recorded to memory`);
  }
}
