import type { SandboxToolSurface } from './harness.js';
import { redactHarnessText } from './harness.js';
import { buildRepositoryCloneCommand } from './git.js';

const MAX_EVIDENCE_CHARS = 4_000;

export interface BootstrapStep {
  name: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface BootstrapResult {
  repo: string;
  steps: BootstrapStep[];
}

export class SandboxBootstrapError extends Error {
  constructor(
    readonly result: BootstrapResult,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxBootstrapError';
  }
}

// A failed install's actual error is at the end of its output, so most of the
// budget goes to the tail. The container is gone by the time anyone reads this.
function evidence(value: string): string {
  const redacted = redactHarnessText(value);
  if (redacted.length <= MAX_EVIDENCE_CHARS) return redacted;
  const head = MAX_EVIDENCE_CHARS / 4;
  return `${redacted.slice(0, head)}\n...[truncated]...\n${redacted.slice(head - MAX_EVIDENCE_CHARS)}`;
}

export interface BootstrapCommand {
  name: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
}

/**
 * Per-repository dependency setup. Return the commands for `repo` (the bare
 * name for home-org repos, `owner/name` outside it), or null to use the
 * default lockfile install. Transcribe recipes from the repository's own CI
 * and rehearse them on a fresh clone before relying on them.
 */
export type BootstrapRecipe = (repo: string, token: string) => BootstrapCommand[] | null;

/**
 * Clones a sibling repository to /workspace/<repo>, next to the task repo at
 * /workspace/repo, so relative `file:` dependency links resolve as in CI.
 */
export function cloneSiblingCommand(org: string, repo: string, token: string): BootstrapCommand {
  return {
    name: `clone-${repo}`,
    command: buildRepositoryCloneCommand(repo, token, `/workspace/${repo}`, org),
    cwd: '/workspace',
  };
}

/** Frozen install from whichever lockfile the repository commits at its root. */
export const DEFAULT_INSTALL_STEP: BootstrapCommand = {
  name: 'install-dependencies',
  command: 'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; '
    + 'elif [ -f package-lock.json ]; then npm ci; '
    + "else echo 'no pnpm-lock.yaml or package-lock.json at the repository root; skipping install'; fi",
  cwd: '/workspace/repo',
  timeoutMs: 1_200_000,
};

export function bootstrapCommands(repo: string, token: string, recipe?: BootstrapRecipe): BootstrapCommand[] {
  return [
    { name: 'runtime', command: 'node --version && pnpm --version', cwd: '/workspace/repo' },
    ...(recipe?.(repo, token) ?? [DEFAULT_INSTALL_STEP]),
  ];
}

export async function bootstrapSandbox(options: {
  sandbox: SandboxToolSurface;
  repo: string;
  token: string;
  recipe?: BootstrapRecipe;
  onCheckpoint?: (result: BootstrapResult) => Promise<void>;
}): Promise<BootstrapResult> {
  const result: BootstrapResult = { repo: options.repo, steps: [] };
  for (const step of bootstrapCommands(options.repo, options.token, options.recipe)) {
    let execution;
    try {
      execution = await options.sandbox.exec(step.command, {
        cwd: step.cwd,
        timeout: step.timeoutMs ?? 300_000,
      });
    } catch (error) {
      execution = {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    const record: BootstrapStep = {
      ...step,
      command: redactHarnessText(step.command),
      ok: execution.success,
      exitCode: execution.exitCode,
      output: evidence(`${execution.stdout}${execution.stderr ? `\n${execution.stderr}` : ''}`),
    };
    result.steps.push(record);
    await options.onCheckpoint?.(result);
    if (!execution.success) {
      throw new SandboxBootstrapError(result, `sandbox bootstrap failed at ${step.name} (exit ${execution.exitCode})`);
    }
  }
  return result;
}

export const SANDBOX_RELEASE_TIMEOUT_MS = 30_000;

/** Rejects if `work` hasn't settled in time. The work itself can't be cancelled. */
export async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gives the container's instance back as soon as its task ends. Otherwise each
 * finished task holds a slot for `sleepAfter`, and the next task past
 * `max_instances` fails with a misleading 503. Neither a failure nor a hang here
 * can change the task's outcome or hold up the next task: the SDK's `destroy()`
 * can wait forever on an unresponsive control plane, and the instance still
 * sleeps on its own.
 */
export async function releaseSandbox(
  sandbox: { destroy(): Promise<void> },
  timeoutMs: number = SANDBOX_RELEASE_TIMEOUT_MS,
): Promise<void> {
  try {
    await settleWithin(sandbox.destroy(), timeoutMs);
  } catch (error) {
    console.warn(`[task-executor-do] sandbox release failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
