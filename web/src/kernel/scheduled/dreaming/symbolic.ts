// Phase 5: Symbolic Reflection — nightly TarotScript SingleDraw
// mirrors the day's operational patterns via structured serendipity.

import type { EdgeEnv } from '../../dispatch.js';
import { recordMemory as recordMemoryAdapter } from '../../memory-adapter.js';
import { runReading, summarizeForMemory, formatSymbolicNote } from '../../symbolic.js';

export async function runSymbolicReflection(env: EdgeEnv): Promise<void> {
  if (!env.tarotscriptFetcher) return;

  try {
    const reading = await runReading(
      env.tarotscriptFetcher,
      'dreaming',
      "Reflect on today's operational patterns",
      { domain: 'reflection', situation: 'Nightly dreaming cycle mirror', timeframe: 'immediate' },
    );

    const summary = summarizeForMemory(reading, 'dreaming', "Reflect on today's operational patterns");
    const note = formatSymbolicNote(reading, 'dreaming');

    const memoryContent = `${note}\nReceipt: ${summary.receiptHash} | Seed: ${summary.seed}`;
    if (env.memoryBinding) {
      await recordMemoryAdapter(env.memoryBinding, 'symbolic_reflection', memoryContent, 0.7, 'dreaming_cycle');
    }

    console.log(`[dreaming:symbolic] SingleDraw complete — ${summary.dominantElement}, shadow ${summary.shadowDensity.toFixed(2)}, sephira ${summary.sephira}`);
  } catch (err) {
    console.warn('[dreaming:symbolic] TarotScript reading failed:', err instanceof Error ? err.message : String(err));
  }
}
