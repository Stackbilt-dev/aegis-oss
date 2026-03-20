// Hero image generation tests — verifies img-forge Service Binding integration,
// text-capability tier gating, and graceful failure handling.

import { describe, it, expect, vi } from 'vitest';
import { generateHeroImage, type ImgForgeConfig } from '../src/content/hero-image.js';

function createMockConfig(
  response: { ok: boolean; json: () => unknown } | 'throw',
): ImgForgeConfig {
  const fetcher = {
    fetch: response === 'throw'
      ? vi.fn().mockRejectedValue(new Error('network error'))
      : vi.fn().mockResolvedValue({
          ok: response.ok,
          json: async () => response.json(),
        }),
  } as unknown as Fetcher;

  return {
    fetcher,
    sbSecret: 'test-sb-secret',
    baseUrl: 'https://img.example.com',
  };
}

describe('generateHeroImage', () => {
  it('returns full URL on successful generation', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: '/v2/assets/abc123.png' }),
    });

    const result = await generateHeroImage(config, 'A test prompt');
    expect(result).toBe('https://img.example.com/v2/assets/abc123.png');
  });

  it('sends correct request body and headers', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: '/img.png' }),
    });

    await generateHeroImage(config, 'Test prompt', 'standard');

    const fetchFn = config.fetcher.fetch as ReturnType<typeof vi.fn>;
    expect(fetchFn).toHaveBeenCalledOnce();

    const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://internal/v2/generate');
    expect(opts.method).toBe('POST');

    const headers = opts.headers as Record<string, string>;
    expect(headers['X-Service-Binding']).toBe('test-sb-secret');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body as string);
    expect(body.quality_tier).toBe('standard');
    expect(body.sync).toBe(true);
  });

  it('appends no-text warning for non-Gemini tiers', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: '/img.png' }),
    });

    await generateHeroImage(config, 'A prompt', 'standard');

    const fetchFn = config.fetcher.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.prompt).toContain('Do not include any text, letters, words, or typography');
  });

  it('preserves prompt for text-capable tiers (ultra)', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: '/img.png' }),
    });

    await generateHeroImage(config, 'My prompt with text', 'ultra');

    const fetchFn = config.fetcher.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.prompt).toBe('My prompt with text');
  });

  it('preserves prompt for text-capable tiers (ultra_plus)', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: '/img.png' }),
    });

    await generateHeroImage(config, 'My prompt', 'ultra_plus');

    const fetchFn = config.fetcher.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.prompt).toBe('My prompt');
  });

  it('returns null when response is not ok', async () => {
    const config = createMockConfig({ ok: false, json: () => ({}) });
    const result = await generateHeroImage(config, 'Test');
    expect(result).toBeNull();
  });

  it('returns null when asset_url is null in response', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: null }),
    });
    const result = await generateHeroImage(config, 'Test');
    expect(result).toBeNull();
  });

  it('returns null on network error (graceful failure)', async () => {
    const config = createMockConfig('throw');
    const result = await generateHeroImage(config, 'Test');
    expect(result).toBeNull();
  });

  it('defaults tier to standard', async () => {
    const config = createMockConfig({
      ok: true,
      json: () => ({ asset_url: '/img.png' }),
    });

    await generateHeroImage(config, 'A prompt');

    const fetchFn = config.fetcher.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.quality_tier).toBe('standard');
    // Default 'standard' is not text-capable → should have no-text warning
    expect(body.prompt).toContain('Do not include any text');
  });
});
