export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

export function validatePlanSteps(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PlanValidationError('model plan did not contain a steps array');
  }
  const steps = value.filter((step): step is string => typeof step === 'string')
    .map((step) => step.trim())
    .filter(Boolean);
  if (steps.length === 0) {
    throw new PlanValidationError('model plan contained no executable steps');
  }
  return steps;
}
