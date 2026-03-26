import { type EdgeEnv } from '../dispatch.js';

// --- Developer Activity Snapshot ---
// Calls auth service via service binding to collect API key
// creation/usage metrics and user signup data. Writes to
// digest_sections for the daily brief.
// Runs at 08 UTC -- same window as argus-analytics.

export async function runDevActivity(env: EdgeEnv): Promise<void> {
  // Time gate: 08 UTC (lands before 09 UTC digest)
  const now = new Date();
  if (now.getUTCHours() !== 8) return;

  // Cooldown: 22 hours
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'dev_activity'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < 22 * 60 * 60 * 1000) return;
  }

  if (!env.authBinding) {
    console.log('[dev-activity] Skipping -- no AUTH binding');
    return;
  }

  const report = await env.authBinding.getDeveloperActivity();

  // Write to digest_sections for the daily brief
  await env.db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('dev_activity', ?)"
  ).bind(JSON.stringify(report)).run();

  // Update watermark
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('dev_activity', datetime('now'))"
  ).run();

  console.log(
    `[dev-activity] Snapshot: ${report.total_users} users, ${report.keys_active_24h} active keys (24h), ${report.keys_created_7d} keys created (7d)`,
  );
}
