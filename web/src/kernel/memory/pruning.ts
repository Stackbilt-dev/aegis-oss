import { BASE_HALF_LIFE_DAYS } from './semantic.js';

const RETENTION_THRESHOLD = 0.1;

// Prune expired + low-confidence old entries, and cap per-topic row count (#4)
export async function pruneMemory(db: D1Database): Promise<void> {
  // 1. Delete expired entries
  await db.prepare(
    "DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).run();

  // 2. Delete low-confidence active entries older than 30 days
  await db.prepare(
    "DELETE FROM memory_entries WHERE confidence < 0.5 AND valid_until IS NULL AND created_at < datetime('now', '-30 days')"
  ).run();

  // 3. Cap each topic at 20 active entries — keep highest confidence, then most recent
  const topics = await db.prepare(
    'SELECT DISTINCT topic FROM memory_entries WHERE valid_until IS NULL'
  ).all<{ topic: string }>();

  for (const { topic } of topics.results) {
    await db.prepare(`
      DELETE FROM memory_entries WHERE topic = ? AND valid_until IS NULL AND id NOT IN (
        SELECT id FROM memory_entries WHERE topic = ? AND valid_until IS NULL
        ORDER BY confidence DESC, updated_at DESC LIMIT 20
      )
    `).bind(topic, topic).run();
  }

  // 3b. Purge superseded entries older than 90 days (audit trail retention limit)
  await db.prepare(
    "DELETE FROM memory_entries WHERE valid_until IS NOT NULL AND valid_until < datetime('now', '-90 days')"
  ).run();

  // 3c. Retention-based pruning (#53) — soft-delete entries with decayed retention below threshold
  // Strength-1 entries prune after ~46 days; strength-5 after ~232 days
  const activeEntries = await db.prepare(
    'SELECT id, strength, last_recalled_at, created_at FROM memory_entries WHERE valid_until IS NULL'
  ).all<{ id: number; strength: number; last_recalled_at: string | null; created_at: string }>();

  const now = Date.now();
  for (const entry of activeEntries.results) {
    const activeDate = entry.last_recalled_at ?? entry.created_at;
    const ts = activeDate.endsWith('Z') ? activeDate : activeDate + 'Z';
    const daysSince = Math.max(0, (now - new Date(ts).getTime()) / 86_400_000);
    const retention = Math.pow(2, -daysSince / ((entry.strength ?? 1) * BASE_HALF_LIFE_DAYS));
    if (retention < RETENTION_THRESHOLD) {
      await db.prepare(
        "UPDATE memory_entries SET valid_until = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).bind(entry.id).run();
      console.log(`[memory] Retention-pruned entry #${entry.id} (R=${retention.toFixed(4)}, strength=${entry.strength})`);
    }
  }

  // 4. Prune stale event dedup entries (>48h)
  await db.prepare(
    "DELETE FROM web_events WHERE received_at < datetime('now', '-48 hours')"
  ).run();

  // 5. Prune old heartbeat results (keep last 100 or 30 days)
  await db.prepare(`
    DELETE FROM heartbeat_results
    WHERE id NOT IN (SELECT id FROM heartbeat_results ORDER BY created_at DESC LIMIT 100)
    AND created_at < datetime('now', '-30 days')
  `).run();
}
