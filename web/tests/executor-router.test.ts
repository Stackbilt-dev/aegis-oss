import { describe, it, expect } from 'vitest';
import { EXECUTOR_ROUTES, getExecutorRoute } from '../src/kernel/executor-router.js';
import type { Executor } from '../src/kernel/types.js';

// Non-LLM executors intentionally absent from EXECUTOR_ROUTES.
const NON_LLM_EXECUTORS: Executor[] = ['direct', 'claude_code', 'tarotscript', 'composite'];

const ALL_EXECUTORS: Executor[] = [
  'claude', 'claude_opus', 'gpt_oss', 'workers_ai', 'groq',
  'cerebras_mid', 'cerebras_reasoning',
  ...NON_LLM_EXECUTORS,
];

describe('executor-router', () => {
  it('every LLM executor has a route entry', () => {
    for (const ex of ALL_EXECUTORS) {
      if (NON_LLM_EXECUTORS.includes(ex)) continue;
      expect(EXECUTOR_ROUTES).toHaveProperty(ex);
    }
  });

  it('non-LLM executors return null from getExecutorRoute', () => {
    for (const ex of NON_LLM_EXECUTORS) {
      expect(getExecutorRoute(ex)).toBeNull();
    }
  });

  it('all routes have a provider and a model function', () => {
    for (const [name, route] of Object.entries(EXECUTOR_ROUTES)) {
      expect(typeof route.provider).toBe('string');
      expect(typeof route.model).toBe('function');
      expect(route.provider.length).toBeGreaterThan(0);
      expect(route.model.name !== undefined).toBe(true);
      // No route is missing its own entry (sanity)
      expect(getExecutorRoute(name as Executor)).toBe(route);
    }
  });

  it('model() returns a non-empty string given a minimal EdgeEnv', () => {
    const minEnv = {
      claudeModel: 'claude-sonnet-4-6',
      opusModel: 'claude-opus-4-7',
      gptOssModel: '@cf/openai/gpt-oss-120b',
      groqResponseModel: 'llama-3.1-8b-instant',
    } as any;

    expect(EXECUTOR_ROUTES.claude.model(minEnv)).toBe('claude-sonnet-4-6');
    expect(EXECUTOR_ROUTES.claude_opus.model(minEnv)).toBe('claude-opus-4-7');
    expect(EXECUTOR_ROUTES.gpt_oss.model(minEnv)).toBe('@cf/openai/gpt-oss-120b');
    expect(EXECUTOR_ROUTES.workers_ai.model(minEnv)).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(EXECUTOR_ROUTES.groq.model(minEnv)).toBe('llama-3.1-8b-instant');
    // cerebras placeholders are hardcoded strings
    expect(EXECUTOR_ROUTES.cerebras_mid.model(minEnv)).toBeTruthy();
    expect(EXECUTOR_ROUTES.cerebras_reasoning.model(minEnv)).toBeTruthy();
  });

  it('fallback chains are valid executor names', () => {
    for (const [, route] of Object.entries(EXECUTOR_ROUTES)) {
      if (route.fallback !== undefined) {
        expect(ALL_EXECUTORS).toContain(route.fallback);
      }
    }
  });

  it('claude and claude_opus both fall back to gpt_oss', () => {
    expect(EXECUTOR_ROUTES.claude.fallback).toBe('gpt_oss');
    expect(EXECUTOR_ROUTES.claude_opus.fallback).toBe('gpt_oss');
  });

  it('gpt_oss has no fallback (terminal)', () => {
    expect(EXECUTOR_ROUTES.gpt_oss.fallback).toBeUndefined();
  });
});
