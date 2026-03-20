// Fetch-based web search and URL fetching — no external SDK
// Follows the same pattern as groq.ts

import { operatorConfig } from './operator/index.js';

// ─── Brave Search ────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function braveSearch(
  apiKey: string,
  query: string,
  maxResults: number = 5,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 10)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      console.warn('[search] Brave Search timed out after 10s');
      return [];
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brave Search API error ${response.status}: ${errText}`);
  }

  const data = await response.json<{
    web?: {
      results?: Array<{
        title: string;
        url: string;
        description?: string;
        extra_snippets?: string[];
      }>;
    };
  }>();

  const results = data.web?.results ?? [];
  return results.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? r.extra_snippets?.[0] ?? '',
  }));
}

// ─── URL Fetch + Text Extraction ─────────────────────────────

const STRIP_TAGS = /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi;
const COLLAPSE_WHITESPACE = /\s{2,}/g;

export async function fetchUrlText(url: string, maxChars: number = 8000): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': operatorConfig.userAgent,
        'Accept': 'text/html,text/plain,application/json',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return `[Error: request to ${url} timed out after 10s]`;
    }
    throw err;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();

  let text: string;
  if (contentType.includes('application/json')) {
    // Prettify JSON for readability
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else {
    // Strip HTML tags, collapse whitespace
    text = raw
      .replace(STRIP_TAGS, ' ')
      .replace(COLLAPSE_WHITESPACE, ' ')
      .trim();
  }

  return text.length > maxChars
    ? text.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars — full page is ${text.length} chars ...]`
    : text;
}
