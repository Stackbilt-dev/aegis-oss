// Search utility tests — braveSearch and fetchUrlText
// Mocks global fetch and operator config

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    userAgent: 'aegis-test/1.0',
    identity: { name: 'AEGIS' },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: [], memoryTopics: [] },
    integrations: {
      bizops: { enabled: false, toolPrefix: '', fallbackUrl: '' },
      github: { enabled: false },
      brave: { enabled: true },
      email: { profiles: {}, defaultProfile: 'stackbilt' },
      goals: { enabled: false },
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

const { braveSearch, fetchUrlText } = await import('../src/search.js');

describe('braveSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed search results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        web: {
          results: [
            { title: 'Result 1', url: 'https://example.com', description: 'A description' },
            { title: 'Result 2', url: 'https://example.org', extra_snippets: ['Snippet'] },
          ],
        },
      }),
    }));

    const results = await braveSearch('test-key', 'query');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: 'Result 1', url: 'https://example.com', snippet: 'A description' });
    expect(results[1].snippet).toBe('Snippet');
  });

  it('returns empty array on timeout', async () => {
    const err = new DOMException('Timeout', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

    const results = await braveSearch('test-key', 'query');
    expect(results).toEqual([]);
  });

  it('throws on non-timeout errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    await expect(braveSearch('test-key', 'query')).rejects.toThrow('Network error');
  });

  it('throws on non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    }));

    await expect(braveSearch('test-key', 'query')).rejects.toThrow('Brave Search API error 401');
  });

  it('handles empty web results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ web: {} }),
    }));

    const results = await braveSearch('test-key', 'query');
    expect(results).toEqual([]);
  });

  it('caps maxResults at 10', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ web: { results: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await braveSearch('key', 'query', 20);
    expect(fetchMock.mock.calls[0][0]).toContain('count=10');
  });
});

describe('fetchUrlText', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('strips HTML tags and collapses whitespace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: vi.fn().mockResolvedValue('<html><body><p>Hello</p>  <p>World</p></body></html>'),
    }));

    const text = await fetchUrlText('https://example.com');
    expect(text).not.toContain('<');
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });

  it('strips script and style tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: vi.fn().mockResolvedValue('<html><script>alert("xss")</script><style>body{}</style><p>Content</p></html>'),
    }));

    const text = await fetchUrlText('https://example.com');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('body{}');
    expect(text).toContain('Content');
  });

  it('prettifies JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: vi.fn().mockResolvedValue('{"key":"value"}'),
    }));

    const text = await fetchUrlText('https://example.com/api');
    expect(text).toContain('"key": "value"');
  });

  it('truncates at maxChars', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: vi.fn().mockResolvedValue('x'.repeat(200)),
    }));

    const text = await fetchUrlText('https://example.com', 50);
    expect(text).toContain('truncated at 50 chars');
    expect(text).toContain('full page is 200 chars');
  });

  it('returns timeout error message', async () => {
    const err = new DOMException('Timeout', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

    const text = await fetchUrlText('https://example.com');
    expect(text).toContain('timed out after 10s');
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await expect(fetchUrlText('https://example.com')).rejects.toThrow('HTTP 500');
  });
});
