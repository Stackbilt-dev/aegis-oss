import { describe, expect, it, vi } from 'vitest';
import { LLMProviders } from '@stackbilt/llm-providers';
import {
  buildHarnessProgressGuidance,
  buildSandboxHarnessTools,
  constrainHarnessTools,
  containsTextToolCall,
  detectRepeatedToolFailure,
  isAllowedVerificationCommand,
  isHarnessExecutionComplete,
  normalizeRepositoryPath,
  pendingHarnessVerificationCommands,
  redactHarnessResult,
  redactHarnessText,
  runSandboxHarness,
  SandboxHarnessError,
  selectHarnessToolChoice,
  SANDBOX_HARNESS_MODEL,
  type HarnessEvent,
  type SandboxHarnessResult,
  type SandboxToolSurface,
} from '../../src/factory/harness.js';
import {
  SandboxBootstrapError,
  DEFAULT_INSTALL_STEP,
  bootstrapCommands,
  cloneSiblingCommand,
  type BootstrapRecipe,
  bootstrapSandbox,
} from '../../src/factory/bootstrap.js';

function fakeSandbox(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const exec = vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
  }));
  const sandbox: SandboxToolSurface = {
    exec,
    readFile: async (path) => ({ content: files.get(path) ?? '' }),
    writeFile: async (path, content) => { files.set(path, content); },
    mkdir: async () => undefined,
  };
  return { sandbox, files, exec };
}

describe('sandbox harness safety', () => {
  it('uses a Workers AI model with native multi-turn function calling', () => {
    expect(SANDBOX_HARNESS_MODEL).toBe('@cf/moonshotai/kimi-k2.7-code');
  });

  it('delegates binding-safe continuation to the managed provider tool loop', async () => {
    const path = '/workspace/repo/web/tests/example.test.ts';
    const { sandbox } = fakeSandbox({ [path]: 'const value = 1;\n' });
    const managedLoop = vi.spyOn(LLMProviders.prototype, 'generateResponseWithTools')
      .mockImplementation(async (request, executor, options) => {
        expect(request.toolChoice).toBe('required');
        await executor.execute('replace_in_file', {
          path: 'web/tests/example.test.ts',
          old_text: 'value = 1',
          new_text: 'value = 2',
        });
        await options?.onIteration?.(1, {
          iteration: 1,
          cumulativeCost: 0,
          messageCount: 3,
          lastToolCalls: [{
            id: 'edit-1',
            type: 'function',
            function: { name: 'replace_in_file', arguments: '{}' },
          }],
        });
        expect(request.toolChoice).toEqual({
          type: 'function', function: { name: 'run_verification' },
        });
        expect(request.tools?.map((tool) => tool.function.name)).toEqual(['run_verification']);

        for (const command of [
          'pnpm exec vitest run tests/example.test.ts',
          'pnpm run typecheck',
          'git diff --check',
        ]) {
          await executor.execute('run_verification', { command });
        }
        await options?.onIteration?.(2, {
          iteration: 2,
          cumulativeCost: 0,
          messageCount: 5,
          lastToolCalls: [{
            id: 'verify-1',
            type: 'function',
            function: { name: 'run_verification', arguments: '{}' },
          }],
        });
        // Tools stay available after the checks pass so a further edit is not lost (#766).
        expect(request.toolChoice).toBe('auto');
        expect(request.tools?.map((tool) => tool.function.name)).toContain('replace_in_file');
        return {
          message: 'Completed the requested change.',
          provider: 'cloudflare',
          model: SANDBOX_HARNESS_MODEL,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
          metadata: { toolIterations: 2 },
        };
      });

    try {
      const result = await runSandboxHarness({
        sandbox: sandbox as never,
        repoPath: '/workspace/repo',
        task: {
          id: 'task-1',
          title: 'Managed loop test',
          repo: 'aegis',
          category: 'tests',
          prompt: 'Add a test. Run pnpm exec vitest run tests/example.test.ts, typecheck, and git diff --check.',
        },
        env: { AI: {} as Ai },
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        summary: 'Completed the requested change.',
        iterations: 2,
        textToolCall: false,
      });
      expect(managedLoop).toHaveBeenCalledOnce();
    } finally {
      managedLoop.mockRestore();
    }
  });

  it('keeps the tool loop focused on the next unmet execution phase', () => {
    expect(buildHarnessProgressGuidance([])).toContain('replace_in_file or write_file');
    expect(buildHarnessProgressGuidance([{
      tool: 'replace_in_file', args: {}, ok: true, output: 'updated file',
    }])).toContain('no verification has passed');
    expect(buildHarnessProgressGuidance([
      { tool: 'replace_in_file', args: {}, ok: true, output: 'updated file' },
      { tool: 'run_verification', args: {}, ok: true, output: 'exit 0' },
    ])).toContain('finish with a concise summary');
    expect(buildHarnessProgressGuidance([
      { tool: 'replace_in_file', args: {}, ok: true, output: 'updated file' },
      { tool: 'run_verification', args: { command: 'pnpm exec vitest run tests/x.test.ts' }, ok: true, output: 'exit 0' },
    ], 'Run vitest, typecheck, and git diff --check.')).toContain('typecheck, git diff --check');
    expect(buildHarnessProgressGuidance([
      { tool: 'read_file', args: { path: 'web/tests/x.test.ts' }, ok: true, output: 'exact file body' },
      { tool: 'read_file', args: { path: 'ignored.ts' }, ok: false, output: 'unavailable' },
    ])).toContain('Latest successful file snapshot (web/tests/x.test.ts):\nexact file body');
  });

  it('enforces edit and requested verification phases with named tool choices', () => {
    const prompt = 'Add a test. Run vitest, typecheck, and git diff --check.';
    expect(selectHarnessToolChoice(prompt, [], 0)).toBe('required');
    expect(selectHarnessToolChoice(prompt, [], 4)).toEqual({
      type: 'function', function: { name: 'replace_in_file' },
    });

    const events: HarnessEvent[] = [
      { tool: 'replace_in_file', args: {}, ok: true, output: 'updated file' },
    ];
    expect(selectHarnessToolChoice(prompt, events, 5)).toEqual({
      type: 'function', function: { name: 'run_verification' },
    });
    events.push(
      { tool: 'run_verification', args: { command: 'pnpm exec vitest run tests/x.test.ts' }, ok: true, output: 'exit 0' },
      { tool: 'run_verification', args: { command: 'pnpm run typecheck' }, ok: true, output: 'exit 0' },
      { tool: 'run_verification', args: { command: 'git diff --check' }, ok: true, output: 'exit 0' },
    );
    expect(selectHarnessToolChoice(prompt, events, 8)).toBe('auto');
  });

  it('structurally narrows named phases to the required tool', () => {
    const { tools } = buildSandboxHarnessTools(fakeSandbox().sandbox, '/workspace/repo', []);
    expect(constrainHarnessTools(tools, 'required')).toHaveLength(tools.length);
    expect(constrainHarnessTools(tools, {
      type: 'function', function: { name: 'replace_in_file' },
    }).map((tool) => tool.function.name)).toEqual(['replace_in_file']);
    const verification = constrainHarnessTools(tools, {
      type: 'function', function: { name: 'run_verification' },
    }, ['pnpm run typecheck', 'git diff --check']);
    expect(verification[0]?.function.parameters.properties?.command).toMatchObject({
      enum: ['pnpm run typecheck', 'git diff --check'],
    });
  });

  it('recognizes the verification boundary for prose-only completion', () => {
    const prompt = 'Run pnpm exec vitest run tests/x.test.ts, typecheck, and git diff --check.';
    const events: HarnessEvent[] = [
      { tool: 'replace_in_file', args: {}, ok: true, output: 'updated' },
      { tool: 'run_verification', args: { command: 'pnpm exec vitest run tests/x.test.ts' }, ok: true, output: 'exit 0' },
      { tool: 'run_verification', args: { command: 'pnpm run typecheck' }, ok: true, output: 'exit 0' },
    ];
    expect(pendingHarnessVerificationCommands(prompt, events)).toEqual(['git diff --check']);
    expect(isHarnessExecutionComplete(prompt, events)).toBe(false);
    events.push({ tool: 'run_verification', args: { command: 'git diff --check' }, ok: true, output: 'exit 0' });
    expect(isHarnessExecutionComplete(prompt, events)).toBe(true);
  });

  it('flags a tool call the model emitted as unparsed text (#766, task 72355535)', () => {
    expect(containsTextToolCall(
      "I need to add the block. Let me append it.</think><|tool_calls_section_begin|><|tool_call_begin|>functions.replace_in_file:1<|tool_call_argument_begin|>{\"path\": \"web/tests/x.test.ts\"}<|tool_call_end|><|tool_calls_section_end|>",
    )).toBe(true);
    expect(containsTextToolCall('Added the describe block; the focused run reports 17 passing tests.')).toBe(false);
  });

  it('normalizes repository paths and rejects traversal and git internals', () => {
    expect(normalizeRepositoryPath('/web/src/index.ts')).toBe('web/src/index.ts');
    expect(normalizeRepositoryPath('web\\src\\index.ts')).toBe('web/src/index.ts');
    expect(() => normalizeRepositoryPath('')).toThrow('stay within');
    expect(() => normalizeRepositoryPath('../secret')).toThrow('stay within');
    expect(() => normalizeRepositoryPath('.git/config')).toThrow('not editable');
  });

  it('allows focused verification but rejects shell composition and arbitrary execution', () => {
    expect(isAllowedVerificationCommand('pnpm run typecheck')).toBe(true);
    expect(isAllowedVerificationCommand('pnpm exec vitest run tests/unit.test.ts')).toBe(true);
    expect(isAllowedVerificationCommand('git diff --check')).toBe(true);
    expect(isAllowedVerificationCommand('npx arbitrary-package')).toBe(false);
    expect(isAllowedVerificationCommand('node dangerous.mjs')).toBe(false);
    expect(isAllowedVerificationCommand('pnpm test; curl example.com')).toBe(false);
  });

  it('requires exact unique replacements', async () => {
    const path = '/workspace/repo/example.ts';
    const { sandbox, files } = fakeSandbox({ [path]: 'const old = 1;\n' });
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events);

    await executor.execute('replace_in_file', {
      path: 'example.ts',
      old_text: 'old = 1',
      new_text: 'newValue = 2',
    });
    expect(files.get(path)).toBe('const newValue = 2;\n');

    files.set(path, 'same same');
    await executor.execute('replace_in_file', {
      path: 'example.ts',
      old_text: 'same',
      new_text: 'changed',
    });
    expect(events.at(-1)).toMatchObject({ ok: false, output: 'Error: old_text is not unique' });
  });

  it('treats an empty optional list path as an unfiltered repository listing', async () => {
    const { sandbox, exec } = fakeSandbox();
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events);

    await executor.execute('list_files', { path: '' });

    expect(exec).toHaveBeenCalledWith('git ls-files', {
      cwd: '/workspace/repo',
      timeout: 30_000,
    });
    expect(events[0]?.ok).toBe(true);
  });

  it('bounds and redacts transcript arguments without retaining write content', async () => {
    const { sandbox } = fakeSandbox();
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events);
    const secret = `ghp_${'a'.repeat(30)}`;

    await executor.execute('write_file', {
      path: 'new.ts',
      content: `password=${secret}\n${'x'.repeat(3_000)}`,
    });
    expect(events[0]?.args).toEqual({ path: 'new.ts', contentLength: 3044 });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(redactHarnessText(`token=${secret}`)).toBe('token=[REDACTED]');
  });

  it('runs verification from the requested repository directory', async () => {
    const { sandbox, exec } = fakeSandbox();
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events);
    await executor.execute('run_verification', { command: 'pnpm run typecheck', cwd: 'web' });
    expect(exec).toHaveBeenCalledWith('pnpm run typecheck', {
      cwd: '/workspace/repo/web',
      timeout: 300_000,
    });
    expect(events[0]?.ok).toBe(true);
  });

  it('forces AEGIS package verification into web while keeping git inspection at root', async () => {
    const { sandbox, exec } = fakeSandbox();
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events, 'web');

    await executor.execute('run_verification', { command: 'pnpm run typecheck' });
    await executor.execute('run_verification', { command: 'git diff --check' });
    await executor.execute('run_verification', { command: 'pnpm test', cwd: 'cli' });

    expect(exec.mock.calls[0]?.[1]).toMatchObject({ cwd: '/workspace/repo/web' });
    expect(exec.mock.calls[1]?.[1]).toMatchObject({ cwd: '/workspace/repo' });
    expect(events[2]).toMatchObject({ ok: false, output: 'Error: package verification must run from web' });
  });

  it('bounds oversized tool output in the persisted transcript', async () => {
    const { sandbox, exec } = fakeSandbox();
    exec.mockResolvedValueOnce({
      success: true,
      exitCode: 0,
      stdout: 'x'.repeat(20_000),
      stderr: '',
    });
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events);

    const output = await executor.execute('run_verification', { command: 'git status --short' });
    expect(String(output)).toContain('[truncated');
    expect(events[0]?.output.length).toBeLessThan(12_100);
  });

  it('shows the model verbatim file content, stripping only credential formats (aegis#754)', async () => {
    const path = '/workspace/repo/web/src/auth.ts';
    const secret = `ghp_${'b'.repeat(30)}`;
    const source = `interface Opts {\n  token: string;\n  password: z.string().min(8),\n}\nconst gh = '${secret}';\n`;
    const { sandbox, files } = fakeSandbox({ [path]: source });
    const events: HarnessEvent[] = [];
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', events);

    const read = String(await executor.execute('read_file', { path: 'web/src/auth.ts' }));
    expect(read).toContain('  token: string;');
    expect(read).toContain('  password: z.string().min(8),');
    expect(read).not.toContain(secret);

    await executor.execute('replace_in_file', {
      path: 'web/src/auth.ts',
      old_text: '  token: string;',
      new_text: '  token: string | null;',
    });
    expect(events.at(-1)?.ok).toBe(true);
    expect(files.get(path)).toContain('  token: string | null;');
  });

  it('returns files up to the file limit rather than the tool-output limit', async () => {
    const path = '/workspace/repo/big.ts';
    const { sandbox } = fakeSandbox({ [path]: 'y'.repeat(20_000) });
    const { executor } = buildSandboxHarnessTools(sandbox, '/workspace/repo', []);

    const read = String(await executor.execute('read_file', { path: 'big.ts' }));
    expect(read).toHaveLength(20_000);
  });

  it('applies full key=value redaction to persisted results only', () => {
    const redacted = redactHarnessResult({
      model: SANDBOX_HARNESS_MODEL,
      summary: 'set token: aegis_live_value',
      iterations: 1,
      events: [{
        tool: 'replace_in_file',
        args: { old_text: "sanitize('token: aegis_live_value')" },
        ok: false,
        output: "  token: aegis_live_value\n  password: hunter2",
      }],
    });
    expect(JSON.stringify(redacted)).not.toContain('aegis_live_value');
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('detects identical consecutive failing tool calls', () => {
    const fail = (oldText: string): HarnessEvent => ({
      tool: 'replace_in_file', args: { path: 'a.ts', old_text: oldText }, ok: false, output: 'Error: old_text was not found',
    });
    expect(detectRepeatedToolFailure([fail('x'), fail('x')])).toBeNull();
    expect(detectRepeatedToolFailure([fail('x'), fail('y'), fail('x')])).toBeNull();
    expect(detectRepeatedToolFailure([
      fail('x'), { tool: 'read_file', args: {}, ok: true, output: 'body' }, fail('x'), fail('x'),
    ])).toBeNull();
    expect(detectRepeatedToolFailure([fail('y'), fail('x'), fail('x'), fail('x')]))
      .toContain('replace_in_file failed 3 times in a row');
  });

  it('aborts on repeated identical failures and persists only redacted checkpoints', async () => {
    const path = '/workspace/repo/web/tests/example.test.ts';
    const { sandbox } = fakeSandbox({ [path]: "expect(f('token: aegis_live_value'));\n" });
    const checkpoints: SandboxHarnessResult[] = [];
    let lastSignal: unknown;
    const managedLoop = vi.spyOn(LLMProviders.prototype, 'generateResponseWithTools')
      .mockImplementation(async (_request, executor, options) => {
        const read = await executor.execute('read_file', { path: 'web/tests/example.test.ts' });
        expect(read).toContain('token: aegis_live_value');
        for (let iteration = 1; iteration <= 3; iteration++) {
          await executor.execute('replace_in_file', {
            path: 'web/tests/example.test.ts',
            old_text: 'token=[REDACTED]',
            new_text: 'token: fake',
          });
          lastSignal = await options?.onIteration?.(iteration, {
            iteration, cumulativeCost: 0, messageCount: 1, lastToolCalls: [],
          });
        }
        throw new Error('Tool loop aborted');
      });

    try {
      await expect(runSandboxHarness({
        sandbox: sandbox as never,
        repoPath: '/workspace/repo',
        task: { id: 'task-2', title: 'Repeat', repo: 'aegis', category: 'tests', prompt: 'Replace the fixture.' },
        env: { AI: {} as Ai },
        signal: new AbortController().signal,
        onCheckpoint: async (result) => { checkpoints.push(result); },
      })).rejects.toBeInstanceOf(SandboxHarnessError);
      expect(lastSignal).toMatchObject({ abort: true });
      expect(String((lastSignal as { reason: string }).reason)).toContain('failed 3 times in a row');
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(JSON.stringify(checkpoints)).not.toContain('aegis_live_value');
    } finally {
      managedLoop.mockRestore();
    }
  });
});

describe('sandbox bootstrap', () => {
  it('installs from the committed lockfile by default', () => {
    const commands = bootstrapCommands('any-repo', 'secret-token');
    expect(commands.map((step) => step.name)).toEqual(['runtime', 'install-dependencies']);
    expect(commands[1]).toBe(DEFAULT_INSTALL_STEP);
    expect(commands[1]?.command).toContain('pnpm install --frozen-lockfile');
    expect(commands[1]?.command).toContain('npm ci');
  });

  it('runs a recipe instead of the default install, with credential-safe sibling clones', () => {
    const recipe: BootstrapRecipe = (repo, token) => (repo === 'app'
      ? [
          cloneSiblingCommand('example-org', 'shared-lib', token),
          { name: 'install-shared-lib', command: 'npm ci', cwd: '/workspace/shared-lib' },
          { name: 'install-app', command: 'pnpm install --frozen-lockfile', cwd: '/workspace/repo/web' },
        ]
      : null);
    const commands = bootstrapCommands('app', 'secret-token', recipe);
    expect(commands.map((step) => step.name)).toEqual(['runtime', 'clone-shared-lib', 'install-shared-lib', 'install-app']);
    expect(commands[1]?.command).toContain("'https://github.com/example-org/shared-lib.git'");
    expect(commands[1]?.command).toContain(`Authorization: Basic ${btoa('x-access-token:secret-token')}`);
    expect(commands[1]?.command).not.toContain('secret-token');
    expect(bootstrapCommands('other', 'secret-token', recipe).map((step) => step.name)).toEqual(['runtime', 'install-dependencies']);
  });

  it('preserves a redacted checkpoint and classifies a failed stage', async () => {
    const { sandbox, exec } = fakeSandbox();
    exec.mockResolvedValueOnce({
      success: false,
      exitCode: 127,
      stdout: '',
      stderr: `token=ghp_${'b'.repeat(30)}`,
    });
    const checkpoints: string[] = [];

    await expect(bootstrapSandbox({
      sandbox,
      repo: 'other-repo',
      token: 'unused',
      onCheckpoint: async (result) => { checkpoints.push(JSON.stringify(result)); },
    })).rejects.toBeInstanceOf(SandboxBootstrapError);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toContain('[REDACTED]');
    expect(checkpoints[0]).not.toContain('ghp_');
  });
});
