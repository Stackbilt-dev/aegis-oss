// Stub — full implementation not yet extracted to OSS

export interface ImgForgeConfig {
  fetcher: Fetcher;
  sbSecret: string;
  baseUrl: string;
}

type QualityTier = 'standard' | 'ultra' | 'ultra_plus';

const TEXT_CAPABLE_TIERS: QualityTier[] = ['ultra', 'ultra_plus'];

const NO_TEXT_SUFFIX = '\n\nDo not include any text, letters, words, or typography in the image.';

export async function generateHeroImage(
  config: ImgForgeConfig,
  prompt: string,
  tier: QualityTier = 'standard',
): Promise<string | null> {
  try {
    const finalPrompt = TEXT_CAPABLE_TIERS.includes(tier)
      ? prompt
      : prompt + NO_TEXT_SUFFIX;

    const response = await config.fetcher.fetch('https://internal/v2/generate', {
      method: 'POST',
      headers: {
        'X-Service-Binding': config.sbSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: finalPrompt,
        quality_tier: tier,
        sync: true,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { asset_url: string | null };
    if (!data.asset_url) return null;

    return `${config.baseUrl}${data.asset_url}`;
  } catch {
    return null;
  }
}
