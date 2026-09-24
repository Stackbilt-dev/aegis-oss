import { describe, expect, it } from 'vitest';
import { PlanValidationError, validatePlanSteps } from '../../src/factory/plan.js';

describe('validatePlanSteps', () => {
  it('rejects a missing steps array', () => {
    expect(() => validatePlanSteps(undefined)).toThrow(PlanValidationError);
  });

  it('rejects empty and whitespace-only plans', () => {
    expect(() => validatePlanSteps([])).toThrow('no executable steps');
    expect(() => validatePlanSteps(['', '  '])).toThrow('no executable steps');
  });

  it('returns normalized executable commands', () => {
    expect(validatePlanSteps(['  pnpm test  ', null, 'git diff --check'])).toEqual([
      'pnpm test',
      'git diff --check',
    ]);
  });
});
