// ─── Dream-scope fact writer (aegis#684 / aegis-oss#78) ────────
// Writes a fact into the wiki's `dreams` scope instead of the legacy
// memory-worker fragment store. Mirrors the pattern the daemon's
// synthesis.ts (PRISM) already proves in production: one wiki page per
// fact, scope: dreams, type: synthesis, confidence: drifting, unique
// timestamped slug — no merge/lint conflicts, subject to the same dreams
// lifecycle rules (archive if uncorroborated).
//
// Never throws — write failures log and fall through, matching the
// grounding-layer invariant that non-critical writes must not block the
// caller's scheduled task.

import { writePage } from '../../wiki/client.js';
import type { WikiClientEnv } from '../../wiki/client.js';

export interface DreamFactInput {
  fact: string;
  confidence: number;
  source: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function writeDreamFact(env: WikiClientEnv, input: DreamFactInput): Promise<void> {
  if (!env.wikiBinding || !env.wikiToken) return;

  const { fact, confidence, source } = input;
  const sourceSlug = slugify(source);
  const slug = `dream-${sourceSlug}-${Date.now()}`;

  try {
    await writePage(env, {
      slug,
      scope: 'dreams',
      type: 'synthesis',
      title: `${source}: ${fact.slice(0, 60)}`,
      summary: fact.slice(0, 200),
      body: [
        '## Fact',
        '',
        fact,
        '',
        '## Confidence',
        '',
        `${(confidence * 100).toFixed(0)}%`,
        '',
        '## Source',
        '',
        source,
      ].join('\n'),
      confidence: 'drifting',
      canonical: false,
      sources: [{ type: 'core_scheduled_task', ref: source, verified_date: new Date().toISOString().slice(0, 10) }],
    });
  } catch (err) {
    console.warn(`[dream-write] Failed to write dream page for source "${source}":`, err instanceof Error ? err.message : String(err));
  }
}
