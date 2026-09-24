import { LLMProviders } from '@stackbilt/llm-providers';
import type { LLMMessage, LLMRequest, Tool, ToolChoice, ToolExecutor } from '@stackbilt/llm-providers';
import type { Sandbox } from '@cloudflare/sandbox';

/** Default Workers AI coding model. Override with the executor config's `model`. */
export const SANDBOX_HARNESS_MODEL = '@cf/moonshotai/kimi-k2.7-code';
const MAX_FILE_CHARS = 40_000;
const MAX_TOOL_OUTPUT_CHARS = 12_000;
const MAX_TRANSCRIPT_EVENTS = 80;
const MAX_ARGUMENT_CHARS = 2_000;

interface HarnessTask {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  category: string;
}

interface HarnessEnv {
  AI: Ai;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
}

export interface HarnessEvent {
  tool: string;
  args: unknown;
  ok: boolean;
  output: string;
}

export interface SandboxHarnessResult {
  model: string;
  summary: string;
  iterations: number;
  events: HarnessEvent[];
  /** The final message carried a tool call as raw markup rather than a structured call (#766). */
  textToolCall?: boolean;
}

const TEXT_TOOL_CALL = /<\|tool_calls?_section_begin\|>|<\|tool_call_begin\|>/;

export function containsTextToolCall(message: string): boolean {
  return TEXT_TOOL_CALL.test(message);
}

export function buildHarnessProgressGuidance(events: HarnessEvent[], taskPrompt = ''): string {
  const changed = events.some((event) => event.ok
    && (event.tool === 'write_file' || event.tool === 'replace_in_file'));
  const verified = events.some((event) => event.ok && event.tool === 'run_verification');
  if (!changed) {
    const lastRead = [...events].reverse().find((event) => event.ok && event.tool === 'read_file');
    const args = lastRead?.args && typeof lastRead.args === 'object'
      ? lastRead.args as Record<string, unknown>
      : {};
    const snapshot = lastRead
      ? `\n\nLatest successful file snapshot (${String(args.path ?? 'unknown path')}):\n${bounded(lastRead.output, MAX_FILE_CHARS)}`
      : '';
    return `Progress requirement: no repository edit has succeeded yet. Make the requested edit now with replace_in_file or write_file. Copy old_text verbatim from the file snapshot; do not invent surrounding text. Call only tools from the provided tool list; apply_patch and arbitrary shell tools are unavailable.${snapshot}`;
  }
  if (!verified) {
    return 'Progress requirement: the repository has a successful edit, but no verification has passed. Run the requested focused checks with run_verification, using paths relative to the enforced package working directory.';
  }
  const commands = successfulVerificationCommands(events);
  const prompt = taskPrompt.toLowerCase();
  const missing = [
    /\b(?:test|vitest)\b/.test(prompt)
      && !commands.some((command) => /(?:\btest\b|\bvitest\b)/.test(command)) ? 'focused test' : '',
    /\b(?:typecheck|tsc)\b/.test(prompt)
      && !commands.some((command) => /(?:\btypecheck\b|\btsc\b)/.test(command)) ? 'typecheck' : '',
    prompt.includes('git diff --check')
      && !commands.some((command) => /^git\s+diff\s+--check(?:\s|$)/.test(command)) ? 'git diff --check' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    return `Progress requirement: the edit is present. Run the remaining requested checks with run_verification: ${missing.join(', ')}.`;
  }
  return 'Progress requirement: an edit and verification have succeeded. If the task still needs further edits, make them now with replace_in_file or write_file and re-run the focused check. Otherwise inspect the diff, then finish with a concise summary by responding without a tool call.';
}

function successfulVerificationCommands(events: HarnessEvent[]): string[] {
  return events
    .filter((event) => event.ok && event.tool === 'run_verification')
    .map((event) => {
      const args = event.args && typeof event.args === 'object'
        ? event.args as Record<string, unknown>
        : {};
      return typeof args.command === 'string' ? args.command.trim() : '';
    })
    .filter(Boolean);
}

export function pendingHarnessVerificationCommands(
  taskPrompt: string,
  events: HarnessEvent[],
): string[] {
  const commands = successfulVerificationCommands(events);
  const prompt = taskPrompt.toLowerCase();
  const pending: string[] = [];
  if (/\b(?:test|vitest)\b/.test(prompt)
    && !commands.some((command) => /(?:\btest\b|\bvitest\b)/.test(command))) {
    pending.push(taskPrompt.match(/pnpm\s+exec\s+vitest\s+run\s+[a-z0-9_./-]+/i)?.[0] ?? 'pnpm test');
  }
  if (/\b(?:typecheck|tsc)\b/.test(prompt)
    && !commands.some((command) => /(?:\btypecheck\b|\btsc\b)/.test(command))) {
    pending.push('pnpm run typecheck');
  }
  if (prompt.includes('git diff --check')
    && !commands.some((command) => /^git\s+diff\s+--check(?:\s|$)/.test(command))) {
    pending.push('git diff --check');
  }
  return pending;
}

export function selectHarnessToolChoice(
  taskPrompt: string,
  events: HarnessEvent[],
  iteration: number,
): ToolChoice {
  const changed = events.some((event) => event.ok
    && (event.tool === 'write_file' || event.tool === 'replace_in_file'));
  if (!changed) {
    return iteration >= 4
      ? { type: 'function', function: { name: 'replace_in_file' } }
      : 'required';
  }

  const commands = successfulVerificationCommands(events);
  const prompt = taskPrompt.toLowerCase();
  const needsTest = /\b(?:test|vitest)\b/.test(prompt);
  const needsTypecheck = /\b(?:typecheck|tsc)\b/.test(prompt);
  const needsDiffCheck = prompt.includes('git diff --check');
  const hasTest = commands.some((command) => /(?:\btest\b|\bvitest\b)/.test(command));
  const hasTypecheck = commands.some((command) => /(?:\btypecheck\b|\btsc\b)/.test(command));
  const hasDiffCheck = commands.some((command) => /^git\s+diff\s+--check(?:\s|$)/.test(command));
  const explicitChecksSatisfied = (!needsTest || hasTest)
    && (!needsTypecheck || hasTypecheck)
    && (!needsDiffCheck || hasDiffCheck);
  const hasFallbackVerification = !needsTest && !needsTypecheck && !needsDiffCheck
    && commands.length > 0;

  return explicitChecksSatisfied && (commands.length > 0 || hasFallbackVerification)
    ? 'auto'
    : { type: 'function', function: { name: 'run_verification' } };
}

export function constrainHarnessTools(
  tools: Tool[],
  toolChoice: ToolChoice,
  verificationCommands: string[] = [],
): Tool[] {
  if (typeof toolChoice === 'object') {
    return tools
      .filter((tool) => tool.function.name === toolChoice.function.name)
      .map((tool) => tool.function.name === 'run_verification' && verificationCommands.length > 0
        ? {
            ...tool,
            function: {
              ...tool.function,
              parameters: {
                ...tool.function.parameters,
                properties: {
                  ...(tool.function.parameters.properties as Record<string, unknown>),
                  command: {
                    type: 'string',
                    enum: verificationCommands,
                    description: 'Run one remaining required verification command.',
                  },
                },
              },
            },
          }
        : tool);
  }
  return tools;
}

export function isHarnessExecutionComplete(taskPrompt: string, events: HarnessEvent[]): boolean {
  const changed = events.some((event) => event.ok
    && (event.tool === 'write_file' || event.tool === 'replace_in_file'));
  return changed && selectHarnessToolChoice(taskPrompt, events, Number.MAX_SAFE_INTEGER) === 'auto';
}

export class SandboxHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxHarnessError';
  }
}

export interface SandboxToolSurface {
  exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  readFile(path: string): Promise<{ content: string }>;
  writeFile(path: string, content: string): Promise<unknown>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
}

// Credential formats that are never legitimate repository content. Stripped
// from everything, including the tool output the model reads.
export function redactCredentials(value: string): string {
  return value
    .replace(/https:\/\/x-token-auth:[^@\s]+@github\.com/gi, 'https://x-token-auth:[REDACTED]@github.com')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]');
}

// Full redaction for persisted artifacts (checkpoints, harness.json, errors).
// The key=value rules also match ordinary source such as `token: string`, so
// they must never rewrite what the model reads: an exact-match edit built from
// a rewritten view can never apply (aegis#754).
export function redactHarnessText(value: string): string {
  return redactCredentials(value)
    .replace(/\bauthorization\s*[:=]\s*(?:bearer|basic)?\s*[^'"\s]+/gi, 'Authorization=[REDACTED]')
    .replace(/\b(authorization|token|secret|password)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]');
}

function bounded(value: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  const redacted = redactCredentials(value);
  return redacted.length <= max
    ? redacted
    : `${redacted.slice(0, max)}\n...[truncated ${redacted.length - max} chars]`;
}

function redactPersistedValue(value: unknown): unknown {
  if (typeof value === 'string') return redactHarnessText(value);
  if (Array.isArray(value)) return value.map(redactPersistedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, redactPersistedValue(entry)]),
    );
  }
  return value;
}

export function redactHarnessResult(result: SandboxHarnessResult): SandboxHarnessResult {
  return {
    ...result,
    summary: redactHarnessText(result.summary),
    events: result.events.map((event) => ({
      ...event,
      args: redactPersistedValue(event.args),
      output: redactHarnessText(event.output),
    })),
  };
}

const MAX_IDENTICAL_FAILURES = 3;

// A model repeating the same failing call will not recover by itself; stop
// before it spends the rest of the iteration budget.
export function detectRepeatedToolFailure(
  events: HarnessEvent[],
  limit = MAX_IDENTICAL_FAILURES,
): string | null {
  if (events.length < limit) return null;
  const recent = events.slice(-limit);
  const signature = JSON.stringify([recent[0].tool, recent[0].args]);
  const repeated = recent.every((event) => !event.ok
    && JSON.stringify([event.tool, event.args]) === signature);
  return repeated
    ? `${recent[0].tool} failed ${limit} times in a row with identical arguments: ${recent[0].output}`
    : null;
}

function safeArguments(value: unknown): unknown {
  if (typeof value === 'string') return bounded(value, MAX_ARGUMENT_CHARS);
  if (Array.isArray(value)) return value.slice(0, 20).map(safeArguments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, entry]) => [key, safeArguments(entry)]),
    );
  }
  return value;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function normalizeRepositoryPath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('path must be a string');
  const path = value.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  if (!path || path.includes('\0') || path.split('/').some((part) => part === '..')) {
    throw new Error('path must stay within the repository');
  }
  if (path === '.git' || path.startsWith('.git/')) {
    throw new Error('the .git directory is not editable');
  }
  return path;
}

export function isAllowedVerificationCommand(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const command = value.trim();
  if (!command || /[;&|><`$\n\r]/.test(command)) return false;
  return /^pnpm\s+--version$/.test(command)
    || /^pnpm\s+test(?:\s|$)/.test(command)
    || /^pnpm\s+run\s+(?:test|typecheck|check|build)(?::[a-z0-9:_-]+)?(?:\s|$)/i.test(command)
    || /^pnpm\s+exec\s+(?:vitest|tsc)(?:\s|$)/.test(command)
    || /^(?:npx|yarn)\s+(?:vitest|tsc)(?:\s|$)/.test(command)
    || /^npm\s+test(?:\s|$)/.test(command)
    || /^npm\s+run\s+(?:test|typecheck|check|build)(?::[a-z0-9:_-]+)?(?:\s|$)/i.test(command)
    || /^git\s+(?:diff|status)(?:\s|$)/.test(command);
}


export function buildSandboxHarnessTools(
  sandbox: SandboxToolSurface,
  repoPath: string,
  events: HarnessEvent[],
  verificationCwd = '',
): { tools: Tool[]; executor: ToolExecutor } {
  const tools: Tool[] = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List tracked repository files. Use this before assuming a path exists.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional repository-relative directory or glob.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: 'Search tracked text files with git grep and return matching paths and lines.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Literal text to search for.' },
            path: { type: 'string', description: 'Optional repository-relative path or glob.' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a repository file. Paths must come from list_files or search_text.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or replace one repository file with complete text content.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description: 'Replace one exact, unique text occurrence in an existing repository file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_text: { type: 'string' },
            new_text: { type: 'string' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_verification',
        description: 'Run a non-interactive package/test/typecheck or read-only git verification command.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Allowed: pnpm/npm test, approved run scripts, pnpm exec vitest/tsc, pnpm --version, or git diff/status.' },
            cwd: { type: 'string', description: 'Repository-relative working directory; defaults to repo root.' },
          },
          required: ['command'],
        },
      },
    },
  ];

  const record = (
    tool: string,
    args: unknown,
    ok: boolean,
    output: string,
    max = MAX_TOOL_OUTPUT_CHARS,
  ): string => {
    const safeOutput = bounded(output, max);
    if (events.length < MAX_TRANSCRIPT_EVENTS) {
      events.push({ tool, args: safeArguments(args), ok, output: safeOutput });
    }
    return safeOutput;
  };

  const executor: ToolExecutor = {
    async execute(name: string, argsValue: unknown): Promise<unknown> {
      const args = argsValue && typeof argsValue === 'object'
        ? argsValue as Record<string, unknown>
        : {};
      try {
        if (name === 'list_files') {
          const path = typeof args.path === 'string' && args.path.trim()
            ? normalizeRepositoryPath(args.path)
            : null;
          const suffix = path ? ` -- ${quoteShell(path)}` : '';
          const result = await sandbox.exec(`git ls-files${suffix}`, { cwd: repoPath, timeout: 30_000 });
          return record(name, args, result.success, result.stdout || result.stderr || '(no tracked files)');
        }

        if (name === 'search_text') {
          if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
          const path = typeof args.path === 'string' && args.path.trim()
            ? normalizeRepositoryPath(args.path)
            : null;
          const suffix = path ? ` -- ${quoteShell(path)}` : '';
          const result = await sandbox.exec(
            `git grep -n -I -F -e ${quoteShell(args.query)}${suffix}`,
            { cwd: repoPath, timeout: 30_000 },
          );
          const output = result.stdout || (result.exitCode === 1 ? '(no matches)' : result.stderr);
          return record(name, args, result.exitCode === 0 || result.exitCode === 1, output);
        }

        if (name === 'read_file') {
          const path = normalizeRepositoryPath(args.path);
          const file = await sandbox.readFile(`${repoPath}/${path}`);
          return record(name, args, true, file.content, MAX_FILE_CHARS);
        }

        if (name === 'write_file') {
          const path = normalizeRepositoryPath(args.path);
          if (typeof args.content !== 'string') throw new Error('content must be a string');
          if (args.content.length > MAX_FILE_CHARS) throw new Error(`content exceeds ${MAX_FILE_CHARS} characters`);
          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          if (parent) await sandbox.mkdir(`${repoPath}/${parent}`, { recursive: true });
          await sandbox.writeFile(`${repoPath}/${path}`, args.content);
          return record(name, { path, contentLength: args.content.length }, true, `wrote ${path}`);
        }

        if (name === 'replace_in_file') {
          const path = normalizeRepositoryPath(args.path);
          if (typeof args.old_text !== 'string' || !args.old_text) throw new Error('old_text is required');
          if (typeof args.new_text !== 'string') throw new Error('new_text must be a string');
          const file = await sandbox.readFile(`${repoPath}/${path}`);
          const first = file.content.indexOf(args.old_text);
          if (first < 0) throw new Error('old_text was not found');
          if (file.content.indexOf(args.old_text, first + args.old_text.length) >= 0) {
            throw new Error('old_text is not unique');
          }
          const content = `${file.content.slice(0, first)}${args.new_text}${file.content.slice(first + args.old_text.length)}`;
          if (content.length > MAX_FILE_CHARS) throw new Error(`result exceeds ${MAX_FILE_CHARS} characters`);
          await sandbox.writeFile(`${repoPath}/${path}`, content);
          return record(name, { path, oldTextLength: args.old_text.length, newTextLength: args.new_text.length }, true, `updated ${path}`);
        }

        if (name === 'run_verification') {
          if (!isAllowedVerificationCommand(args.command)) throw new Error('command is outside the verification allowlist');
          const requestedCwd = args.cwd === undefined ? '' : normalizeRepositoryPath(args.cwd);
          const packageCommand = !args.command.trim().startsWith('git ');
          if (packageCommand && verificationCwd && requestedCwd && requestedCwd !== verificationCwd) {
            throw new Error(`package verification must run from ${verificationCwd}`);
          }
          const cwd = packageCommand && verificationCwd ? verificationCwd : requestedCwd;
          const result = await sandbox.exec(args.command.trim(), {
            cwd: cwd ? `${repoPath}/${cwd}` : repoPath,
            timeout: 300_000,
          });
          const output = `exit ${result.exitCode}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`;
          return record(name, { command: args.command, cwd }, result.success, output);
        }

        throw new Error(`unknown tool: ${name}`);
      } catch (error) {
        return record(name, args, false, `Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };

  return { tools, executor };
}

export async function runSandboxHarness(options: {
  sandbox: Sandbox;
  repoPath: string;
  task: HarnessTask;
  env: HarnessEnv;
  signal: AbortSignal;
  /** Workers AI model id. Defaults to SANDBOX_HARNESS_MODEL. */
  model?: string;
  /** Repository-relative directory package commands run from. Defaults to the root. */
  verificationCwd?: string;
  onCheckpoint?: (result: SandboxHarnessResult) => Promise<void>;
}): Promise<SandboxHarnessResult> {
  const model = options.model ?? SANDBOX_HARNESS_MODEL;
  const events: HarnessEvent[] = [];
  // Events keep what the model saw; every persisted copy gets full redaction.
  const checkpoint = async (result: SandboxHarnessResult): Promise<void> => {
    await options.onCheckpoint?.(redactHarnessResult(result));
  };
  const verificationCwd = options.verificationCwd ?? '';
  const { tools, executor } = buildSandboxHarnessTools(
    options.sandbox,
    options.repoPath,
    events,
    verificationCwd,
  );
  const llm = new LLMProviders({
    cloudflare: {
      ai: options.env.AI,
      accountId: options.env.CF_ACCOUNT_ID,
      ...(options.env.AI_GATEWAY_ID ? { gateway: { id: options.env.AI_GATEWAY_ID } } : {}),
    },
    preferredProvider: 'cloudflare',
    defaultProvider: 'cloudflare',
    costOptimization: false,
    enableRetries: true,
  });

  let iterations = 0;
  let response;
  try {
    const taskMessage: LLMMessage = {
      role: 'user',
      content: `Task ID: ${options.task.id}\nRepository: ${options.task.repo}\nCategory: ${options.task.category}\n\n${options.task.prompt}`,
    };
    const systemPrompt = `You are a careful autonomous coding agent working inside a cloned repository.
Inspect the repository with tools before editing; never invent paths or APIs. Make only the requested changes.
Use write_file or replace_in_file for edits. Run focused verification and inspect git diff before finishing.
Call only tools from the provided tool list. apply_patch and arbitrary shell commands are unavailable.
${verificationCwd ? `Run package tests and typecheck from ${verificationCwd}/; the tool enforces that workspace.` : ''}
Do not edit .git, deploy, publish, commit, push, or open a pull request; the governed executor owns publication.
If verification fails, diagnose and repair it within the available iterations. Finish with a concise factual summary.`;

    const request: LLMRequest = {
      model,
      maxTokens: 2048,
      temperature: 0.1,
      tools,
      toolChoice: 'required',
      messages: [taskMessage],
      systemPrompt,
    };
    let allowedToolNames = new Set(tools.map((tool) => tool.function.name));
    const configureNextIteration = (iteration: number): void => {
      if (isHarnessExecutionComplete(options.task.prompt, events)) {
        // Keep tools available. Forcing 'none' here ended the loop after the
        // first edit; a second edit the task still needed came back as unparsed
        // tool-call text and was lost (#766). The acceptance gate judges completeness.
        request.tools = tools;
        request.toolChoice = 'auto';
      } else {
        const toolChoice = selectHarnessToolChoice(options.task.prompt, events, iteration);
        request.tools = constrainHarnessTools(
          tools,
          toolChoice,
          pendingHarnessVerificationCommands(options.task.prompt, events),
        );
        request.toolChoice = toolChoice;
      }
      request.systemPrompt = `${systemPrompt}\n\n${buildHarnessProgressGuidance(events, options.task.prompt)}`;
      allowedToolNames = new Set(request.tools.map((tool) => tool.function.name));
    };
    configureNextIteration(0);

    response = await llm.generateResponseWithTools(request, executor, {
      maxIterations: 14,
      abortSignal: options.signal,
      onIteration: async (iteration, state) => {
        iterations = iteration;
        for (const call of state.lastToolCalls) {
          if (allowedToolNames.has(call.function.name) || events.length >= MAX_TRANSCRIPT_EVENTS) continue;
          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = call.function.arguments;
          }
          events.push({
            tool: call.function.name,
            args: safeArguments(args),
            ok: false,
            output: `Error: model requested unavailable tool '${call.function.name}'`,
          });
        }
        configureNextIteration(iteration);
        await checkpoint({
          model,
          summary: buildHarnessProgressGuidance(events, options.task.prompt),
          iterations,
          events: [...events],
        });
        const repeated = detectRepeatedToolFailure(events);
        if (repeated) return { abort: true, reason: repeated };
      },
    });
    iterations = Math.max(iterations, Number(response.metadata?.toolIterations ?? 0));
  } catch (error) {
    const message = redactHarnessText(error instanceof Error ? error.message : String(error));
    await checkpoint({
      model,
      summary: `Error: ${message}`,
      iterations,
      events: [...events],
    });
    throw new SandboxHarnessError(message);
  }

  const summary = response.message ?? '';
  const result: SandboxHarnessResult = {
    model,
    summary,
    iterations,
    events,
    textToolCall: containsTextToolCall(summary),
  };
  const changed = events.some((event) => event.ok
    && (event.tool === 'write_file' || event.tool === 'replace_in_file'));
  const verified = events.some((event) => event.ok && event.tool === 'run_verification');
  await checkpoint(result);
  if (!changed) throw new SandboxHarnessError('tool loop finished without making a repository change');
  if (!verified) throw new SandboxHarnessError('tool loop finished without a successful verification command');
  return redactHarnessResult(result);
}
