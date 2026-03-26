// ARGUS Analytics: GA4 insight extraction
// Queries Google Analytics Data API daily, stores findings for the digest.
// Surfaces: traffic trends, top pages, traffic sources, bounce anomalies.
// Zero inference — pure API queries and threshold logic.

import { type EdgeEnv } from '../dispatch.js';

// ─── GA4 OAuth2 ──────────────────────────────────────────────

interface GACredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  property_id: string;
}

async function getAccessToken(creds: GACredentials): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json<{ access_token: string }>();
  return data.access_token;
}

// ─── GA4 Data API ────────────────────────────────────────────

interface GAReport {
  rows?: Array<{
    dimensionValues: Array<{ value: string }>;
    metricValues: Array<{ value: string }>;
  }>;
  rowCount?: number;
}

async function runReport(
  accessToken: string,
  propertyId: string,
  body: Record<string, unknown>,
): Promise<GAReport> {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 report failed: ${res.status} ${err}`);
  }

  return res.json<GAReport>();
}

// ─── Analytics Snapshot ──────────────────────────────────────

export interface AnalyticsSnapshot {
  // Traffic overview
  sessions_7d: number;
  sessions_prior_7d: number;
  users_7d: number;
  bounce_rate_7d: number;

  // Top pages
  top_pages: Array<{ path: string; sessions: number; bounce_rate: number }>;

  // Traffic sources
  top_sources: Array<{ source: string; medium: string; sessions: number }>;

  // Insights (derived)
  insights: string[];

  computed_at: string;
}

// ─── Main ────────────────────────────────────────────────────

export async function runArgusAnalytics(env: EdgeEnv): Promise<void> {
  // Daily gate — run at 08 UTC (before digest at 09)
  const hour = new Date().getUTCHours();
  if (hour !== 8) return;

  // Cooldown: 22 hours
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'argus_analytics'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.received_at + 'Z').getTime();
    if (elapsed < 22 * 60 * 60 * 1000) return;
  }

  // Parse credentials from env (JSON: { client_id, client_secret, refresh_token, property_id })
  const rawCreds = env.gaCredentials;
  if (!rawCreds) {
    console.log('[argus-analytics] Skipping — no GA_CREDENTIALS');
    return;
  }

  let creds: GACredentials;
  try {
    creds = JSON.parse(rawCreds);
  } catch {
    console.error('[argus-analytics] Failed to parse GA_CREDENTIALS');
    return;
  }

  const accessToken = await getAccessToken(creds);

  // Run reports in parallel
  const [trafficCurrent, trafficPrior, topPages, sources] = await Promise.all([
    // Total sessions + users + bounce rate (last 7 days)
    runReport(accessToken, creds.property_id, {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'bounceRate' },
      ],
    }),

    // Prior 7 days for comparison
    runReport(accessToken, creds.property_id, {
      dateRanges: [{ startDate: '14daysAgo', endDate: '8daysAgo' }],
      metrics: [{ name: 'sessions' }],
    }),

    // Top pages by sessions
    runReport(accessToken, creds.property_id, {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }, { name: 'bounceRate' }],
      limit: 10,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),

    // Traffic sources
    runReport(accessToken, creds.property_id, {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [{ name: 'sessions' }],
      limit: 10,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
  ]);

  // Parse results
  const currentRow = trafficCurrent.rows?.[0];
  const sessions_7d = parseInt(currentRow?.metricValues[0].value ?? '0');
  const users_7d = parseInt(currentRow?.metricValues[1].value ?? '0');
  const bounce_rate_7d = parseFloat(currentRow?.metricValues[2].value ?? '0');

  const priorRow = trafficPrior.rows?.[0];
  const sessions_prior_7d = parseInt(priorRow?.metricValues[0].value ?? '0');

  const top_pages = (topPages.rows ?? []).map(row => ({
    path: row.dimensionValues[0].value,
    sessions: parseInt(row.metricValues[0].value),
    bounce_rate: parseFloat(row.metricValues[1].value),
  }));

  const top_sources = (sources.rows ?? []).map(row => ({
    source: row.dimensionValues[0].value,
    medium: row.dimensionValues[1].value,
    sessions: parseInt(row.metricValues[0].value),
  }));

  // Generate insights
  const insights: string[] = [];

  // Traffic trend
  if (sessions_prior_7d > 0) {
    const delta = ((sessions_7d - sessions_prior_7d) / sessions_prior_7d * 100);
    if (delta > 50) {
      insights.push(`Traffic up ${Math.round(delta)}% week-over-week (${sessions_prior_7d} → ${sessions_7d} sessions). Find out what's driving it.`);
    } else if (delta < -30) {
      insights.push(`Traffic down ${Math.round(Math.abs(delta))}% week-over-week (${sessions_prior_7d} → ${sessions_7d} sessions). Check if something broke or if last week was an anomaly.`);
    }
  }

  // Bounce rate
  if (bounce_rate_7d > 0.8 && sessions_7d > 10) {
    insights.push(`Overall bounce rate is ${(bounce_rate_7d * 100).toFixed(0)}% — more than 4 out of 5 visitors leave immediately. Landing page isn't converting.`);
  }

  // High-bounce pages with traffic
  for (const page of top_pages) {
    if (page.bounce_rate > 0.9 && page.sessions >= 5) {
      insights.push(`${page.path} has ${(page.bounce_rate * 100).toFixed(0)}% bounce rate with ${page.sessions} sessions. Users are landing and leaving.`);
    }
  }

  // Zero-traffic detection (have pages but nobody's visiting)
  if (sessions_7d < 5) {
    insights.push(`Only ${sessions_7d} total sessions this week. No meaningful traffic. Distribution is the bottleneck, not product.`);
  }

  // New traffic source spike
  for (const src of top_sources) {
    if (src.sessions >= 10 && src.source !== '(direct)' && src.source !== '(not set)') {
      insights.push(`${src.sessions} sessions from ${src.source} (${src.medium}). Worth investigating — is this organic or a mention?`);
    }
  }

  const snapshot: AnalyticsSnapshot = {
    sessions_7d,
    sessions_prior_7d,
    users_7d,
    bounce_rate_7d,
    top_pages,
    top_sources,
    insights,
    computed_at: new Date().toISOString(),
  };

  // Store for digest
  await env.db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('analytics', ?)"
  ).bind(JSON.stringify(snapshot)).run();

  // Update watermark
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('argus_analytics', datetime('now'))"
  ).run();

  console.log(`[argus-analytics] ${sessions_7d} sessions (${sessions_prior_7d} prior), ${users_7d} users, ${(bounce_rate_7d * 100).toFixed(0)}% bounce, ${insights.length} insights`);
}
