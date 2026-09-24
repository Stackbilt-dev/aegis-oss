import type { ExecResult } from '@cloudflare/sandbox';

const MAX_DIAGNOSTIC_CHARS = 4_000;
const MAX_DIFF_CHARS = 1_000_000;
/** Hex chars of the change digest kept for branch names — 48 bits of identity. */
const CHANGE_KEY_CHARS = 12;

export type PublicationFailureKind =
  | 'git_add_failed'
  | 'git_diff_failed'
  | 'no_changes'
  | 'git_commit_failed'
  | 'git_push_failed'
  | 'pr_create_failed';

export type PublicationStage =
  | 'git_add'
  | 'staged_files'
  | 'staged_diff'
  | 'rename_branch'
  | 'git_status'
  | 'git_commit'
  | 'commit_sha'
  | 'git_push'
  | 'create_pr';

export interface PublicationStageResult {
  stage: PublicationStage;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface PublicationArtifacts {
  branch: string;
  changeKey?: string;
  commitSha?: string;
  prUrl?: string;
  attached?: boolean;
  stages: PublicationStageResult[];
}

export interface PublishBranchOptions {
  repoPath: string;
  branch: string;
  commitMessage: string;
  exec(command: string): Promise<ExecResult>;
  writeArtifact(path: string, content: string): Promise<void>;
  /** Opens the PR for `branch`, which is the derived branch when one is used. */
  createPullRequest(branch: string): Promise<string>;
  artifactPrefix?: string;
  secrets?: string[];
  pushAuthHeader?: string;
  /** Remote the branch is pushed to. Fork mode pushes to `fork`; default `origin`. */
  pushRemote?: string;
  /**
   * Derives the publication branch from the change's content identity. Supplied
   * by callers that want one branch per distinct change rather than one per
   * attempt. Omit to publish to `branch` as given (prior behavior).
   */
  branchForChange?(changeKey: string): string;
  /**
   * Open PR whose head is `branch`, if any. When it returns a URL the change is
   * already under review and publication attaches to it instead of pushing.
   */
  findOpenPullRequest?(branch: string): Promise<string | null>;
}

export interface PublishBranchResult {
  branch: string;
  commitSha: string;
  prUrl: string;
  /** Content identity of the published change. */
  changeKey?: string;
  /** True when this attempt reused an existing PR instead of opening one. */
  attached?: boolean;
}

export class PublicationError extends Error {
  constructor(
    readonly kind: PublicationFailureKind,
    readonly retryable: boolean,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PublicationError';
  }
}

export async function publishBranch(options: PublishBranchOptions): Promise<PublishBranchResult> {
  validateBranch(options.branch);

  const prefix = options.artifactPrefix ?? '';
  const artifacts: PublicationArtifacts = { branch: options.branch, stages: [] };
  const persist = () =>
    options.writeArtifact(`${prefix}publish.json`, JSON.stringify(artifacts, null, 2));

  const run = async (stage: PublicationStage, command: string): Promise<ExecResult> => {
    const result = await options.exec(command);
    artifacts.stages.push(toStageResult(stage, result, options.secrets ?? []));
    await persist();
    return result;
  };

  const add = await run('git_add', `cd ${shellQuote(options.repoPath)} && git add -A`);
  assertSuccess(add, 'git_add_failed', false, 'git add failed', options.secrets);

  const stagedFiles = await run(
    'staged_files',
    `cd ${shellQuote(options.repoPath)} && git diff --cached --name-only`,
  );
  assertSuccess(stagedFiles, 'git_diff_failed', false, 'staged-file inspection failed', options.secrets);
  if (!stagedFiles.stdout.trim()) {
    throw new PublicationError('no_changes', false, 1, 'no staged changes to publish');
  }

  const diff = await run(
    'staged_diff',
    `cd ${shellQuote(options.repoPath)} && git diff --cached --binary`,
  );
  assertSuccess(diff, 'git_diff_failed', false, 'staged diff capture failed', options.secrets);
  await options.writeArtifact(
    `${prefix}diff.patch`,
    redactAndBound(diff.stdout, options.secrets ?? [], MAX_DIFF_CHARS),
  );

  // Publication identity is the change, not the attempt. Keying the branch on
  // the task id meant every re-run of the same work pushed a new branch and
  // opened a new PR; because the earlier PRs stayed unmerged, `main` never
  // advanced and each re-run looked like a fresh change. Deriving the branch
  // from the diff makes repeated attempts converge on one branch, and one PR.
  const changeKey = await computeChangeKey(diff.stdout);
  artifacts.changeKey = changeKey;
  let branch = options.branch;
  if (options.branchForChange) {
    const derived = options.branchForChange(changeKey);
    if (derived !== branch) {
      validateBranch(derived);
      // -M renames the *current* branch. The sandbox is single-use and the
      // task-id branch is the only local branch, so there is nothing for the
      // force flag to clobber; it is here to rename onto an identical name
      // idempotently if this stage is ever retried within one sandbox.
      const rename = await run(
        'rename_branch',
        `cd ${shellQuote(options.repoPath)} && git branch -M ${shellQuote(derived)}`,
      );
      assertSuccess(rename, 'git_push_failed', false, 'branch rename failed', options.secrets);
      branch = derived;
      artifacts.branch = branch;
    }
  }
  await persist();

  const status = await run(
    'git_status',
    `cd ${shellQuote(options.repoPath)} && git status --short`,
  );
  assertSuccess(status, 'git_diff_failed', false, 'git status capture failed', options.secrets);
  await options.writeArtifact(
    `${prefix}git-status.txt`,
    redactAndBound(status.stdout, options.secrets ?? [], MAX_DIAGNOSTIC_CHARS),
  );

  const commit = await run(
    'git_commit',
    `cd ${shellQuote(options.repoPath)} && git commit -m ${shellQuote(options.commitMessage)}`,
  );
  assertSuccess(commit, 'git_commit_failed', false, 'git commit failed', options.secrets);

  const sha = await run(
    'commit_sha',
    `cd ${shellQuote(options.repoPath)} && git rev-parse HEAD`,
  );
  assertSuccess(sha, 'git_commit_failed', false, 'commit SHA lookup failed', options.secrets);
  const commitSha = sha.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new PublicationError('git_commit_failed', false, 1, 'git returned an invalid commit SHA');
  }
  artifacts.commitSha = commitSha;
  await persist();

  // This change is already under review. Attach to its PR rather than pushing a
  // second copy: the derived branch carries the same tree by construction, so a
  // push would only add another review artifact for work already in flight.
  //
  // Gated on the PR lookup alone, deliberately. A "does the remote branch
  // exist?" pre-check would also catch a branch pushed without a PR, but that
  // has never occurred (`pr_create_failed`: 0 of 906 rows) and reading refs on a
  // private repo returns 404 for an under-scoped token — indistinguishable from
  // absent, which would silently restore the duplicate behavior this fixes.
  // Listing PRs needs only the scope PR creation already requires.
  if (options.findOpenPullRequest) {
    const existing = await options.findOpenPullRequest(branch);
    if (existing) {
      artifacts.prUrl = existing;
      artifacts.attached = true;
      await persist();
      return { branch, commitSha, prUrl: existing, changeKey, attached: true };
    }
  }

  const push = await run(
    'git_push',
    `cd ${shellQuote(options.repoPath)} && git${options.pushAuthHeader
      ? ` -c http.extraHeader=${shellQuote(options.pushAuthHeader)}`
      : ''} push --set-upstream ${options.pushRemote ? shellQuote(options.pushRemote) : 'origin'} ${shellQuote(branch)}`,
  );
  // The branch already exists remotely with different history and has no open
  // PR. For a derived branch that means this exact change was published before
  // and its PR closed unmerged — a reviewer's rejection, not a transient fault.
  // Retrying cannot succeed and republishing would override that decision.
  assertSuccess(push, 'git_push_failed', !isPushRejected(push), 'git push failed', options.secrets);

  try {
    const prUrl = await options.createPullRequest(branch);
    artifacts.prUrl = prUrl;
    artifacts.stages.push({
      stage: 'create_pr',
      success: true,
      exitCode: null,
      stdout: prUrl,
      stderr: '',
      durationMs: 0,
    });
    await persist();
    return { branch, commitSha, prUrl, changeKey, attached: false };
  } catch (error) {
    const message = redactAndBound(
      error instanceof Error ? error.message : String(error),
      options.secrets ?? [],
      MAX_DIAGNOSTIC_CHARS,
    );
    artifacts.stages.push({
      stage: 'create_pr',
      success: false,
      exitCode: null,
      stdout: '',
      stderr: message,
      durationMs: 0,
    });
    await persist();
    throw new PublicationError('pr_create_failed', true, 1, `PR creation failed: ${message}`);
  }
}

/**
 * Content identity for a staged change, used to name its publication branch.
 *
 * `index <old>..<new>` lines carry git blob metadata rather than content, so
 * they are dropped: two attempts producing the same edit hash identically even
 * though the presented blob ids differ. Movement in the base still changes the
 * key, which is correct — a patch against different context is a different
 * patch, not a duplicate of an earlier one.
 */
export async function computeChangeKey(stagedDiff: string): Promise<string> {
  const normalized = stagedDiff
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, '')
    .trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, CHANGE_KEY_CHARS);
}

/** Remote refused the update because the branch has diverged (not a transient error). */
export function isPushRejected(result: ExecResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /\[rejected\]|non-fast-forward|\(fetch first\)|Updates were rejected/.test(output);
}

function assertSuccess(
  result: ExecResult,
  kind: PublicationFailureKind,
  retryable: boolean,
  label: string,
  secrets: string[] = [],
): void {
  if (result.success) return;
  const stdout = redactAndBound(result.stdout, secrets, MAX_DIAGNOSTIC_CHARS);
  const stderr = redactAndBound(result.stderr, secrets, MAX_DIAGNOSTIC_CHARS);
  const details = [
    `${label} (exit ${result.exitCode})`,
    stderr ? `stderr: ${stderr}` : '',
    stdout ? `stdout: ${stdout}` : '',
  ].filter(Boolean).join('\n');
  throw new PublicationError(kind, retryable, result.exitCode || 1, details);
}

function toStageResult(
  stage: PublicationStage,
  result: ExecResult,
  secrets: string[],
): PublicationStageResult {
  return {
    stage,
    success: result.success,
    exitCode: result.exitCode,
    stdout: redactAndBound(result.stdout, secrets, MAX_DIAGNOSTIC_CHARS),
    stderr: redactAndBound(result.stderr, secrets, MAX_DIAGNOSTIC_CHARS),
    durationMs: result.duration,
  };
}

function validateBranch(branch: string): void {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    && !branch.includes('..')
    && !branch.includes('//')
    && !branch.endsWith('/')
    && !branch.endsWith('.');
  if (!safe) throw new PublicationError('git_push_failed', false, 1, 'invalid branch name');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function redactAndBound(value: string, secrets: string[], maxChars: number): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\n...[truncated ${redacted.length - maxChars} chars]`;
}
