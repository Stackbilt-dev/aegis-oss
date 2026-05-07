import type {
  ListPagesResult,
  PageSummary,
  ReadPageResult,
  SearchPagesResult,
  WikiPage,
  WriteInput,
  WritePageResult,
} from './types.js';

export interface WikiClientEnv {
  wikiBaseUrl?: string;
  wikiBinding?: Fetcher;
  wikiToken?: string;
}

export class WikiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WikiClientError';
  }
}

function requireWikiToken(env: WikiClientEnv): string {
  if (!env.wikiToken?.trim()) {
    throw new WikiClientError('AEGIS_WIKI_TOKEN is not configured', 503, 'Service Unavailable');
  }
  return env.wikiToken;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return Boolean(value);
}

// Emdash stores body as portableText (an array of blocks). Agents want readable
// prose, so serialize back to markdown-ish text. Walks blocks, applies heading
// prefixes by style, drops marks/links — lossy but agent-readable.
function portableTextToMarkdown(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const lines: string[] = [];
  for (const block of value) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const style = typeof b.style === 'string' ? b.style : 'normal';
    const children = Array.isArray(b.children) ? b.children : [];
    const text = children
      .map(c => (c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string'
        ? String((c as Record<string, unknown>).text)
        : ''))
      .join('');
    if (!text) { lines.push(''); continue; }
    if (style === 'h1') lines.push(`# ${text}`);
    else if (style === 'h2') lines.push(`## ${text}`);
    else if (style === 'h3') lines.push(`### ${text}`);
    else if (style === 'h4') lines.push(`#### ${text}`);
    else if (style === 'h5') lines.push(`##### ${text}`);
    else if (style === 'h6') lines.push(`###### ${text}`);
    else if (style === 'blockquote') lines.push(`> ${text}`);
    else lines.push(text);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Emdash response envelope: { data: { item: ContentItem, _rev?: string } }
// ContentItem shape:        { id, type, slug, status, data: <frontmatter+body>, ... }
// Returns merged WikiPage with frontmatter spread + top-level id/slug/status/_rev.
function normalizePage(value: unknown): WikiPage | null {
  const envelope = asObject(value);
  if (!envelope) return null;

  // Drill into the wrapper. Accept both { data: { item } } and a bare ContentItem
  // (in case the response shape ever flattens). Walk both shapes safely.
  const inner = asObject(envelope.data) ?? envelope;
  const item = asObject(inner.item) ?? inner;
  if (!item.slug && !item.id) return null;

  const data = asObject(item.data) ?? {};
  const canonical = coerceBoolean(data.canonical);

  const merged: WikiPage = {
    id: String(item.id ?? ''),
    slug: String(item.slug ?? data.slug ?? ''),
    status: typeof item.status === 'string' ? item.status : undefined,
    revision_id: typeof inner._rev === 'string' ? inner._rev : undefined,
    title: String(data.title ?? ''),
    scope: String(data.scope ?? ''),
    type: String(data.type ?? ''),
    confidence: String(data.confidence ?? ''),
    summary: typeof data.summary === 'string' ? data.summary : '',
    body: portableTextToMarkdown(data.body),
    canonical,
    last_verified: typeof data.last_verified === 'string' ? data.last_verified : undefined,
    sources: Array.isArray(data.sources) ? (data.sources as WikiPage['sources']) : undefined,
    related: Array.isArray(data.related) ? (data.related as string[]) : undefined,
    supersedes: Array.isArray(data.supersedes) ? (data.supersedes as string[]) : undefined,
    owners: Array.isArray(data.owners) ? (data.owners as string[]) : undefined,
    consumers: Array.isArray(data.consumers) ? (data.consumers as string[]) : undefined,
    guarded_paths: Array.isArray(data.guarded_paths) ? (data.guarded_paths as string[]) : undefined,
    updated_at: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  };

  // Preserve any additional fields from data that we didn't explicitly map.
  for (const [k, v] of Object.entries(data)) {
    if (!(k in merged)) merged[k] = v;
  }

  return merged;
}

// Handles both shapes:
//  - ContentItem (list endpoint): { id, slug, data: { title, scope, type, ... } }
//  - SearchHit (search endpoint):  { collection, id, slug, title, snippet, score }
// Search hits don't carry scope/type/confidence — those fields stay empty and the
// agent can call wiki_read for full details on any hit.
function normalizeContentItemToSummary(item: Record<string, unknown>): PageSummary {
  const data = asObject(item.data) ?? {};
  const summary: PageSummary = {
    slug: String(item.slug ?? ''),
    title: String(item.title ?? data.title ?? ''),
    scope: String(item.scope ?? data.scope ?? ''),
    type: typeof data.type === 'string' ? data.type : '', // top-level item.type is the collection name, not the wiki type
    confidence: String(data.confidence ?? ''),
    summary: typeof data.summary === 'string' ? data.summary : '',
    updated_at: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  };
  if (typeof item.snippet === 'string') summary.snippet = item.snippet;
  return summary;
}

function normalizeSummaryArray(value: unknown): PageSummary[] {
  const envelope = asObject(value);
  if (!envelope) return [];
  const inner = asObject(envelope.data) ?? envelope;

  // Cursor-based list: { data: { items: [...] } }
  // Search hits:       { data: { results: [...] } }
  const arr =
    (Array.isArray(inner.items) && inner.items) ||
    (Array.isArray(inner.results) && inner.results) ||
    (Array.isArray(inner.pages) && inner.pages) ||
    (Array.isArray(envelope.items) && envelope.items) ||
    (Array.isArray(envelope.results) && envelope.results) ||
    [];

  return (arr as unknown[])
    .map(item => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item)
    .map(normalizeContentItemToSummary);
}

function normalizeWriteResult(value: unknown, fallback: { slug: string; id?: string }): WritePageResult {
  const page = normalizePage(value);
  const id = page?.id || fallback.id || '';
  if (!id) {
    throw new WikiClientError('Wiki write response did not include an id', 502, 'Bad Gateway', value);
  }
  return {
    slug: page?.slug || fallback.slug,
    id,
    revision_id: page?.revision_id,
  };
}

async function requestJson<T>(env: WikiClientEnv, path: string, init: RequestInit = {}): Promise<T> {
  const token = requireWikiToken(env);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');

  const base = env.wikiBaseUrl ?? '';
  const request = new Request(`${base}${path}`, { ...init, headers });

  let response: Response;
  if (env.wikiBinding) {
    response = await env.wikiBinding.fetch(request);
  } else if (env.wikiBaseUrl) {
    response = await fetch(request);
  } else {
    throw new WikiClientError(
      'WikiClientEnv requires wikiBaseUrl or wikiBinding',
      503,
      'Service Unavailable',
    );
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new WikiClientError(
      `Wiki request failed: ${response.status} ${response.statusText}`,
      response.status,
      response.statusText,
      data,
    );
  }

  return data as T;
}

export async function readPage(env: WikiClientEnv, slug: string): Promise<ReadPageResult> {
  try {
    const data = await requestJson<unknown>(env, `/content/wiki/${encodeURIComponent(slug)}`);
    return { page: normalizePage(data) };
  } catch (err) {
    if (err instanceof WikiClientError && err.status === 404) {
      return { page: null };
    }
    throw err;
  }
}

export async function searchPages(
  env: WikiClientEnv,
  query: string,
  options: { limit?: number } = {},
): Promise<SearchPagesResult> {
  const params = new URLSearchParams({ q: query, collections: 'wiki' });
  params.set('limit', String(options.limit ?? 10));

  const data = await requestJson<unknown>(env, `/search?${params.toString()}`);
  const results = normalizeSummaryArray(data);

  // EmDash search hits don't carry scope/type in the response — client-side
  // filtering on those fields would silently discard all results. Use
  // wiki_list for scope-scoped enumeration (aegis#575).
  return { results };
}

// Emdash's write endpoints land content in a draft revision. A separate
// POST /publish call is required to promote the draft to live — otherwise
// GET returns the previous live revision and the write is silently invisible.
// See aegis#475 for the forensic trace.
async function publishRevision(env: WikiClientEnv, id: string): Promise<void> {
  await requestJson<unknown>(
    env,
    `/content/wiki/${encodeURIComponent(id)}/publish`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export async function writePage(env: WikiClientEnv, input: WriteInput): Promise<WritePageResult> {
  const { slug, ...rest } = input;
  const dataPayload = {
    canonical: false,
    confidence: 'drifting' as const,
    last_verified: todayIsoDate(),
    sources: [],
    related: [],
    supersedes: [],
    ...rest,
  };

  const existing = await readPage(env, slug);

  if (existing.page?.id) {
    const updateBody = {
      slug,
      status: existing.page.status ?? 'published',
      data: dataPayload,
      ...(existing.page.revision_id ? { _rev: existing.page.revision_id } : {}),
    };
    const data = await requestJson<unknown>(
      env,
      `/content/wiki/${encodeURIComponent(existing.page.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(updateBody),
      },
    );
    await publishRevision(env, existing.page.id);
    return normalizeWriteResult(data, { slug, id: existing.page.id });
  }

  const createBody = {
    slug,
    status: 'published',
    data: dataPayload,
  };
  const data = await requestJson<unknown>(env, '/content/wiki', {
    method: 'POST',
    body: JSON.stringify(createBody),
  });
  const result = normalizeWriteResult(data, { slug });
  await publishRevision(env, result.id);
  return result;
}

export async function listPages(
  env: WikiClientEnv,
  options: { scope?: string; limit?: number; cursor?: string } = {},
): Promise<ListPagesResult> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 50));
  if (options.cursor) params.set('cursor', options.cursor);

  const raw = await requestJson<unknown>(env, `/content/wiki?${params.toString()}`);

  let pages = normalizeSummaryArray(raw);
  // Emdash list endpoint doesn't filter by inner data fields — scope is client-side.
  if (options.scope) pages = pages.filter(p => p.scope === options.scope);

  const envelope = asObject(raw);
  const inner = asObject(envelope?.data) ?? envelope ?? {};
  const nextCursor = typeof inner.nextCursor === 'string' ? inner.nextCursor : undefined;

  return {
    pages,
    total: pages.length,
    nextCursor,
  };
}
