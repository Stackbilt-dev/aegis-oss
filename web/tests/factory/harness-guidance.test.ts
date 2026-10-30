import { describe, expect, it, vi } from 'vitest';
import { LLMProviders } from '@stackbilt/llm-providers';
import { loadRepositoryGuidance, runSandboxHarness } from '../../src/factory/harness.js';

function sandboxWith(files: Record<string, string>) {
  return {
    exec: vi.fn(async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' })),
    readFile: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error('not found');
      return { content };
    },
    writeFile: async () => undefined,
    mkdir: async () => undefined,
  };
}

describe('loadRepositoryGuidance', () => {
  it('includes both files, labelled, in a fixed order', async () => {
    const guidance = await loadRepositoryGuidance(
      sandboxWith({ '/r/CLAUDE.md': 'claude rules', '/r/AGENTS.md': 'agent rules' }),
      '/r',
    );
    expect(guidance).toContain('--- AGENTS.md ---\nagent rules');
    expect(guidance).toContain('--- CLAUDE.md ---\nclaude rules');
    expect(guidance.indexOf('AGENTS.md')).toBeLessThan(guidance.indexOf('CLAUDE.md'));
  });

  it('adds nothing when the repository has neither file, or only empty ones', async () => {
    expect(await loadRepositoryGuidance(sandboxWith({}), '/r')).toBe('');
    expect(await loadRepositoryGuidance(sandboxWith({ '/r/AGENTS.md': '  \n' }), '/r')).toBe('');
  });

  it('keeps the other file when one cannot be read', async () => {
    const guidance = await loadRepositoryGuidance(sandboxWith({ '/r/CLAUDE.md': 'claude rules' }), '/r');
    expect(guidance).toContain('claude rules');
    expect(guidance).not.toContain('AGENTS.md');
  });

  it('bounds a long file and says where the rest is', async () => {
    const guidance = await loadRepositoryGuidance(sandboxWith({ '/r/AGENTS.md': 'x'.repeat(50_000) }), '/r');
    expect(guidance.length).toBeLessThan(6_300);
    expect(guidance).toContain('truncated; use read_file for the rest');
  });

  it('strips credentials a repository committed by mistake', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const guidance = await loadRepositoryGuidance(sandboxWith({ '/r/AGENTS.md': `token: ${token}` }), '/r');
    expect(guidance).not.toContain(token);
    expect(guidance).toContain('[REDACTED]');
  });
});

describe('runSandboxHarness', () => {
  it('sends the conventions in the task message, not the system prompt', async () => {
    let sent: { messages: { content: string }[]; systemPrompt: string } | undefined;
    const loop = vi.spyOn(LLMProviders.prototype, 'generateResponseWithTools' as never)
      .mockImplementation((async (request: typeof sent) => {
        sent = request;
        throw new Error('stop after the first request');
      }) as never);
    try {
      await expect(runSandboxHarness({
        sandbox: sandboxWith({ '/workspace/repo/AGENTS.md': 'use tabs' }) as never,
        repoPath: '/workspace/repo',
        task: { id: 't', title: 'T', repo: 'aegis', category: 'tests', prompt: 'Do the task.' },
        env: { AI: {} as Ai },
        signal: new AbortController().signal,
      })).rejects.toThrow();
      expect(sent?.messages[0].content).toContain('Do the task.');
      expect(sent?.messages[0].content).toContain('--- AGENTS.md ---\nuse tabs');
      expect(sent?.systemPrompt).not.toContain('use tabs');
    } finally {
      loop.mockRestore();
    }
  });
});
