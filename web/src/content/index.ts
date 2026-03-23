// Stub — full implementation not yet extracted to OSS

export { type ImgForgeConfig } from './hero-image.js';

export async function runRoundtableGeneration(
  _roundtableDb: D1Database,
  _aegisDb: D1Database,
  _apiKey: string,
  _model: string,
  _baseUrl: string,
): Promise<{ title: string; slug: string; cost: number }> {
  throw new Error('not implemented');
}

export async function queueRoundtableTopic(
  _roundtableDb: D1Database,
  _topic: string,
  _context: string,
  _ctaProduct: string,
  _source: string,
): Promise<number> {
  throw new Error('not implemented');
}

export async function runJournalGeneration(env: any): Promise<{ ok: boolean }> {
  throw new Error('not implemented');
}
