// Operator config tests — validates config loading, possessive derivation,
// validation errors, and template rendering.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each test needs a fresh module to avoid config caching across tests.

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    identity: { name: 'Kurt' },
    persona: { tagline: 'test', traits: ['trait1'], channelNote: 'note' },
    entities: { names: [], memoryTopics: [] },
    selfModel: {
      identity: 'id', role: 'role', stakes: 'stakes',
      principles: [], interests: [], strengths: [],
      preferences: { communication: '', work: '', learning: '' },
    },
    integrations: {
      bizops: { enabled: false, fallbackUrl: '', toolPrefix: '' },
      github: { enabled: false }, brave: { enabled: false },
      email: { profiles: {}, defaultProfile: '' },
      goals: { enabled: false }, cfObservability: { enabled: false },
      imgForge: { enabled: false, baseUrl: '' },
    },
    baseUrl: '', userAgent: '',
    ...overrides,
  };
}

describe('operator config validation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('auto-derives possessive for names not ending in s', async () => {
    vi.doMock('../src/operator/config.js', () => ({
      default: makeConfig({ identity: { name: 'Kurt' } }),
    }));

    const { operatorConfig } = await import('../src/operator/index.js');
    expect(operatorConfig.identity.possessive).toBe("Kurt's");
  });

  it('auto-derives possessive for names ending in s', async () => {
    vi.doMock('../src/operator/config.js', () => ({
      default: makeConfig({ identity: { name: 'James' } }),
    }));

    const { operatorConfig } = await import('../src/operator/index.js');
    expect(operatorConfig.identity.possessive).toBe("James'");
  });

  it('preserves explicit possessive when provided', async () => {
    vi.doMock('../src/operator/config.js', () => ({
      default: makeConfig({ identity: { name: 'Alice', possessive: 'Custom Possessive' } }),
    }));

    const { operatorConfig } = await import('../src/operator/index.js');
    expect(operatorConfig.identity.possessive).toBe('Custom Possessive');
  });

  it('freezes the config object', async () => {
    vi.doMock('../src/operator/config.js', () => ({
      default: makeConfig(),
    }));

    const { operatorConfig } = await import('../src/operator/index.js');
    expect(Object.isFrozen(operatorConfig)).toBe(true);
  });
});

describe('renderTemplate', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('replaces {name} and {possessive} placeholders', async () => {
    vi.doMock('../src/operator/config.js', () => ({
      default: makeConfig({ identity: { name: 'Kurt' } }),
    }));

    const { renderTemplate } = await import('../src/operator/index.js');
    const result = renderTemplate('Hello {name}, this is {possessive} agent.');
    expect(result).toBe("Hello Kurt, this is Kurt's agent.");
  });

  it('replaces multiple occurrences of the same placeholder', async () => {
    vi.doMock('../src/operator/config.js', () => ({
      default: makeConfig({ identity: { name: 'Kurt' } }),
    }));

    const { renderTemplate } = await import('../src/operator/index.js');
    const result = renderTemplate('{name} said {name} likes it');
    expect(result).toBe('Kurt said Kurt likes it');
  });
});
