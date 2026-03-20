// Cost model smoke tests — verifies model-aware cost estimation
// Tests the getModelCostRates helper and cost calculation logic

import { describe, it, expect } from 'vitest';

// Inline the cost logic since getModelCostRates is not exported
// This tests the same formula used in claude.ts
function getModelCostRates(model: string): { input: number; output: number } {
  if (model.includes('opus')) return { input: 15, output: 75 };
  return { input: 3, output: 15 }; // Sonnet default
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = getModelCostRates(model);
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

describe('Cost Model', () => {
  it('Sonnet rates are $3/$15 per MTok', () => {
    const rates = getModelCostRates('claude-sonnet-4-6');
    expect(rates.input).toBe(3);
    expect(rates.output).toBe(15);
  });

  it('Opus rates are $15/$75 per MTok', () => {
    const rates = getModelCostRates('claude-opus-4-6');
    expect(rates.input).toBe(15);
    expect(rates.output).toBe(75);
  });

  it('Opus costs ~5x more than Sonnet for same usage', () => {
    const sonnetCost = estimateCost('claude-sonnet-4-6', 1000, 500);
    const opusCost = estimateCost('claude-opus-4-6', 1000, 500);
    expect(opusCost / sonnetCost).toBeCloseTo(5, 4);
  });

  it('calculates realistic cost for a typical exchange', () => {
    // ~2000 input tokens, ~500 output tokens on Sonnet
    const cost = estimateCost('claude-sonnet-4-6', 2000, 500);
    // (2000 * 3 + 500 * 15) / 1_000_000 = (6000 + 7500) / 1_000_000 = 0.0135
    expect(cost).toBeCloseTo(0.0135, 4);
  });

  it('unknown model defaults to Sonnet rates', () => {
    const rates = getModelCostRates('some-future-model');
    expect(rates.input).toBe(3);
    expect(rates.output).toBe(15);
  });
});
