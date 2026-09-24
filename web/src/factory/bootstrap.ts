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

function evidence(value: string): string {
  const redacted = redactHarnessText(value);
  return redacted.length <= MAX_EVIDENCE_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_EVIDENCE_CHARS)}\n...[truncated]`;
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
