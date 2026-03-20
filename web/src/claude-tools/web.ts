// Web research in-process tool definitions + handlers
// Extracted from claude-tools.ts for LOC governance

import { braveSearch, fetchUrlText } from '../search.js';

// ─── Tool definitions ────────────────────────────────────────

const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web using Brave Search. Use for: regulatory lookups, compliance deadlines, state filing requirements, news, competitive research, verifying current facts. Returns title + snippet + URL for each result.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Search query — be specific for best results' },
      max_results: { type: 'number', description: 'Number of results to return (default: 5, max: 10)' },
    },
    required: ['query'],
  },
};

const FETCH_URL_TOOL = {
  name: 'fetch_url',
  description: 'Fetch a URL and extract its text content. Use for: reading a specific web page, pulling reference data, getting full content from a search result. Strips HTML and returns clean text.',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Full URL to fetch (must start with https://)' },
    },
    required: ['url'],
  },
};

export const WEB_TOOLS = [WEB_SEARCH_TOOL, FETCH_URL_TOOL];

// ─── Handler ─────────────────────────────────────────────────

export async function handleWebTool(
  name: string,
  input: Record<string, unknown>,
  braveApiKey: string,
): Promise<string | null> {
  if (name === 'web_search') {
    const query = input.query as string;
    const maxResults = Math.min((input.max_results as number | undefined) ?? 5, 10);
    const results = await braveSearch(braveApiKey, query, maxResults);
    if (results.length === 0) return `No results found for: "${query}"`;
    return results.map((r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`
    ).join('\n\n');
  }

  if (name === 'fetch_url') {
    const url = input.url as string;
    const text = await fetchUrlText(url);
    return `Content from ${url}:\n\n${text}`;
  }

  return null;
}
