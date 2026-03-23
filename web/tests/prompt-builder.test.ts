// Prompt builder tests — verifies system prompt construction, persona preamble,
// Groq prompt, classify system, and task pattern generation.

import { describe, it, expect, vi } from 'vitest';

// vi.mock factories are hoisted — must not reference outer variables.
// Inline config directly in the factory.

vi.mock('../src/operator/index.js', () => {
  const cfg = {
    identity: { name: 'TestUser', possessive: "TestUser's" },
    persona: {
      tagline: 'pragmatic engineer',
      traits: ['Be direct', 'Think in systems'],
      channelNote: 'You are in web chat mode. {name} is messaging.',
    },
    entities: {
      names: ['AcmeCorp', 'BetaLLC'],
      memoryTopics: ['acme', 'beta'],
    },
    products: [
      { name: 'ProductA', description: 'A SaaS product', model: 'proprietary_saas', status: 'live', revenue: '$100/mo' },
      { name: 'ProductB', description: 'An API', model: 'proprietary_api', status: 'pre_launch' },
    ],
    selfModel: {
      identity: 'Test Agent',
      role: 'Test role description.',
      stakes: 'Test stakes.',
      principles: ['Principle 1', 'Principle 2'],
      interests: ['Interest A'],
      strengths: ['Strength X', 'Strength Y'],
      preferences: { communication: 'Direct', work: 'Incremental', learning: 'Papers' },
    },
    integrations: {
      bizops: { enabled: true, fallbackUrl: 'https://bizops.test', toolPrefix: 'BizOps' },
      github: { enabled: true },
      brave: { enabled: true },
      email: { profiles: { main: { from: 'test@test.com', defaultTo: 'admin@test.com', keyEnvField: 'resendApiKey' } }, defaultProfile: 'main' },
      goals: { enabled: true },
      cfObservability: { enabled: true },
      imgForge: { enabled: true, baseUrl: 'https://img.test' },
    },
    baseUrl: 'https://test.example',
    userAgent: 'Test/1.0',
  };
  return {
    operatorConfig: cfg,
    renderTemplate: (template: string) =>
      template.replace(/\{name\}/g, cfg.identity.name).replace(/\{possessive\}/g, cfg.identity.possessive),
  };
});

vi.mock('../src/operator/persona.js', () => ({
  default: `You are AEGIS — {possessive} AI agent. Personality: {persona_tagline}.

{bizops_section}

Traits:
{traits}

{channel_note}`,
}));

import {
  buildPersonaPreamble,
  buildSystemPrompt,
  buildGroqSystemPrompt,
  buildClassifySystem,
  getTaskPatterns,
} from '../src/operator/prompt-builder.js';

// ─── Tests ────────────────────────────────────────────────────

describe('buildPersonaPreamble', () => {
  it('includes identity and persona tagline', () => {
    const result = buildPersonaPreamble();
    expect(result).toContain('AEGIS');
    expect(result).toContain("TestUser's");
    expect(result).toContain('pragmatic engineer');
  });

  it('includes self-model role', () => {
    const result = buildPersonaPreamble();
    expect(result).toContain('Test role description');
  });

  it('warns against generic consultant advice', () => {
    const result = buildPersonaPreamble();
    expect(result).toContain('Never give generic consultant advice');
  });
});

describe('buildSystemPrompt', () => {
  it('replaces persona template placeholders', () => {
    const result = buildSystemPrompt();
    expect(result).toContain("TestUser's");
    expect(result).toContain('pragmatic engineer');
    expect(result).not.toContain('{name}');
    expect(result).not.toContain('{possessive}');
    expect(result).not.toContain('{persona_tagline}');
  });

  it('includes BizOps section when enabled', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('BizOps');
    expect(result).toContain("TestUser's");
  });

  it('includes traits from config', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('Be direct');
    expect(result).toContain('Think in systems');
  });

  it('includes channel note with rendered template', () => {
    const result = buildSystemPrompt();
    expect(result).toContain('TestUser is messaging');
  });

  it('does not include product context (moved to memory blocks)', () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain('Product Portfolio');
  });

  it('does not include self-model context (moved to memory blocks)', () => {
    const result = buildSystemPrompt();
    expect(result).not.toContain('Self-Model');
    expect(result).not.toContain('Principle 1');
  });
});

describe('buildGroqSystemPrompt', () => {
  it('returns short prompt with possessive', () => {
    const result = buildGroqSystemPrompt();
    expect(result).toContain('AEGIS');
    expect(result).toContain("TestUser's");
    expect(result).toContain('brief');
  });

  it('is a compact prompt under 1000 chars', () => {
    const groq = buildGroqSystemPrompt();
    expect(groq.length).toBeLessThan(1000);
    expect(groq.length).toBeGreaterThan(0);
  });
});

describe('buildClassifySystem', () => {
  it('includes all base category names', () => {
    const result = buildClassifySystem();
    expect(result).toContain('heartbeat');
    expect(result).toContain('general_knowledge');
    expect(result).toContain('memory_recall');
    expect(result).toContain('greeting');
    expect(result).toContain('code_task');
    expect(result).toContain('self_improvement');
    expect(result).toContain('web_research');
    expect(result).toContain('user_correction');
    expect(result).toContain('goal_execution');
  });

  it('includes BizOps categories when enabled', () => {
    const result = buildClassifySystem();
    expect(result).toContain('bizops_read');
    expect(result).toContain('bizops_mutate');
  });

  it('includes entity names for tiebreaker', () => {
    const result = buildClassifySystem();
    expect(result).toContain('AcmeCorp');
    expect(result).toContain('BetaLLC');
  });

  it('includes BizOps examples', () => {
    const result = buildClassifySystem();
    expect(result).toContain('compliance deadlines');
    expect(result).toContain('AcmeCorp');
  });

  it('ends with Message: prompt', () => {
    const result = buildClassifySystem();
    expect(result.trimEnd()).toMatch(/Message:\s*$/);
  });

  it('caches result on subsequent calls', () => {
    const first = buildClassifySystem();
    const second = buildClassifySystem();
    expect(first).toBe(second);
  });
});

describe('getTaskPatterns', () => {
  it('returns frozen array', () => {
    const patterns = getTaskPatterns();
    expect(Object.isFrozen(patterns)).toBe(true);
  });

  it('includes base patterns', () => {
    const patterns = getTaskPatterns();
    expect(patterns).toContain('heartbeat');
    expect(patterns).toContain('general_knowledge');
    expect(patterns).toContain('greeting');
    expect(patterns).toContain('code_task');
    expect(patterns).toContain('self_improvement');
    expect(patterns).toContain('goal_execution');
  });

  it('includes BizOps patterns when enabled', () => {
    const patterns = getTaskPatterns();
    expect(patterns).toContain('bizops_read');
    expect(patterns).toContain('bizops_mutate');
  });

  it('places BizOps patterns after heartbeat', () => {
    const patterns = getTaskPatterns();
    const heartbeatIdx = patterns.indexOf('heartbeat');
    const bizopsReadIdx = patterns.indexOf('bizops_read');
    const bizopsMutateIdx = patterns.indexOf('bizops_mutate');
    expect(bizopsReadIdx).toBe(heartbeatIdx + 1);
    expect(bizopsMutateIdx).toBe(heartbeatIdx + 2);
  });

  it('caches result on subsequent calls', () => {
    const first = getTaskPatterns();
    const second = getTaskPatterns();
    expect(first).toBe(second);
  });
});
