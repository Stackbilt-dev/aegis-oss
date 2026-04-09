export interface TaskPreflight {
  repo?: string;
  repo_exists?: boolean;
  repo_path?: string | null;
  git_repo?: boolean;
  authority?: string;
  category?: string;
  base_branch?: string | null;
  test_command?: string | null;
  warnings?: string[];
}

export interface TaskFailureAutopsy {
  kind: string;
  retryable: boolean;
  summary: string;
  recommended_action: string;
  signals: string[];
  system_contract?: string | null;
}

interface FailureInput {
  title?: string | null;
  repo?: string | null;
  category?: string | null;
  error?: string | null;
  result?: string | null;
  exitCode?: number | null;
  preflight?: TaskPreflight | null;
}

interface FailureRowLike {
  id?: string;
  repo?: string;
  completed_at?: string | null;
  autopsy_json?: string | null;
}

function parseJsonObject<T>(raw: string | Record<string, unknown> | null | undefined): T | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as T;
  return null;
}

function createAutopsy(
  kind: string,
  retryable: boolean,
  summary: string,
  recommendedAction: string,
  signals: string[],
  systemContract?: string | null,
): TaskFailureAutopsy {
  return {
    kind,
    retryable,
    summary,
    recommended_action: recommendedAction,
    signals,
    system_contract: systemContract ?? null,
  };
}

export function parseTaskPreflight(raw: string | Record<string, unknown> | null | undefined): TaskPreflight | null {
  return parseJsonObject<TaskPreflight>(raw);
}

export function parseTaskAutopsy(raw: string | Record<string, unknown> | null | undefined): TaskFailureAutopsy | null {
  return parseJsonObject<TaskFailureAutopsy>(raw);
}

// Environment failure patterns — tool/dependency/infra issues that exit code 3 can mask
const ENVIRONMENT_FAILURE_PATTERNS = [
  /npm\s+(err|error|warn).*install/i,
  /enoent.*npm/i,
  /cannot find module/i,
  /module not found/i,
  /permission denied/i,
  /eacces/i,
  /network\s+(error|timeout|unreachable)/i,
  /connection\s+(refused|reset|timed?\s*out)/i,
  /no\s+such\s+file\s+or\s+directory/i,
  /spawn\s+\S+\s+enoent/i,
  /command\s+failed.*install/i,
  /failed\s+to\s+(fetch|download|install)/i,
  /dependency\s+(resolution|install)\s+fail/i,
  /exit\s+code\s+1.*npm\s+install/i,
  /errno\s+\d+/i,
  /segmentation\s+fault/i,
  /out\s+of\s+memory/i,
  /disk\s+(full|space)/i,
];

function isEnvironmentFailure(haystack: string): boolean {
  return ENVIRONMENT_FAILURE_PATTERNS.some(p => p.test(haystack));
}

export function classifyTaskFailure(input: FailureInput): TaskFailureAutopsy {
  const warnings = input.preflight?.warnings ?? [];
  const signals = [
    input.error ? `error:${input.error}` : '',
    input.result ? `result:${input.result.slice(0, 240)}` : '',
    ...warnings.map(w => `preflight:${w}`),
  ].filter(Boolean);

  const haystack = [
    input.title,
    input.repo,
    input.category,
    input.error,
    input.result,
    warnings.join(' '),
    input.preflight?.test_command ?? '',
  ].filter(Boolean).join(' ').toLowerCase();

  if (haystack.includes('repo not found') || input.preflight?.repo_exists === false) {
    return createAutopsy(
      'repo_missing',
      false,
      `Task targeted a repo that is unavailable on this runner${input.repo ? ` (${input.repo})` : ''}.`,
      'Fix the repo alias/path or create/sync the target repo before retrying.',
      signals,
      'repo_target_missing',
    );
  }

  if (haystack.includes('locked by another runner')) {
    return createAutopsy(
      'repo_locked',
      true,
      `Task could not acquire the repo lock${input.repo ? ` for ${input.repo}` : ''}.`,
      'Retry later or reduce concurrent automation against the same repo.',
      signals,
    );
  }

  if (haystack.includes('could not determine base branch')) {
    return createAutopsy(
      'base_branch_unknown',
      false,
      'Task could not determine the repository base branch for worktree isolation.',
      'Set or repair the default branch or remote HEAD before retrying autonomous work.',
      signals,
      'repo_branch_contract_unknown',
    );
  }

  if (
    (haystack.includes('exists on remote') && haystack.includes('open pr')) ||
    (haystack.includes('branch') && haystack.includes('already exists') && !haystack.includes('repo not found'))
  ) {
    return createAutopsy(
      'branch_conflict',
      true,
      'Task branch already exists on the remote from a prior run. The taskrunner now auto-closes stale PRs and cleans up branches on retry.',
      'Retry the task — the taskrunner will clean up the stale branch automatically.',
      signals,
    );
  }

  if (haystack.includes('missing script: "test"') || haystack.includes("missing script: 'test'")) {
    return createAutopsy(
      'test_command_missing',
      false,
      'Task attempted to run a test command that the repo does not expose.',
      'Point the task at the correct test surface or add an explicit verification command to the task prompt.',
      signals,
      'repo_test_surface_missing',
    );
  }

  if (input.category === 'tests' && warnings.some(w => w.toLowerCase().includes('no obvious test command detected'))) {
    return createAutopsy(
      'test_command_missing',
      false,
      'Test task was queued without an obvious verification command in the repo surface.',
      'Add or specify the correct test runner before retrying the task.',
      signals,
      'repo_test_surface_missing',
    );
  }

  // Credit/billing exhaustion — runner hit API spend limits
  if (
    haystack.includes('credit balance') ||
    haystack.includes('credit limit') ||
    haystack.includes('insufficient credits') ||
    haystack.includes('billing') ||
    haystack.includes('payment required') ||
    haystack.includes('rate limit') && haystack.includes('credit')
  ) {
    return createAutopsy(
      'credit_exhausted',
      false,
      'Task failed because the LLM provider credit balance was exhausted or billing limit was reached.',
      'Top up credits or adjust the runner configuration (e.g. switch from --bare API to Claude Code OAuth).',
      signals,
      'runner_credit_exhausted',
    );
  }

  // Authentication failures — invalid or expired API keys/tokens
  if (
    (haystack.includes('unauthorized') || haystack.includes('401') || haystack.includes('authentication failed') || haystack.includes('api key') && haystack.includes('invalid')) &&
    !haystack.includes('repo')  // avoid false matches on repo auth
  ) {
    return createAutopsy(
      'auth_failure',
      false,
      'Task failed due to an authentication or authorization error with an external service.',
      'Check and rotate the relevant API key or token, then retry.',
      signals,
      'runner_auth_degraded',
    );
  }

  if (input.exitCode === 127 || haystack.includes('command not found')) {
    return createAutopsy(
      'command_missing',
      false,
      'Task failed because a required command was unavailable in the runner environment.',
      'Install the missing tool or change the task to use commands already available on the runner.',
      signals,
    );
  }

  if (
    (haystack.includes('404') || haystack.includes('no route')) &&
    (haystack.includes('draft') || haystack.includes('unpublished') || haystack.includes('post'))
  ) {
    return createAutopsy(
      'route_contract_gap',
      false,
      'Task surfaced a content contract mismatch: draft or unpublished content was treated as publicly reachable.',
      'Repair the route or API contract so drafts use a non-public preview or edit flow instead of a live URL.',
      signals,
      'content_public_route_drift',
    );
  }

  // Exit code 3 with environment failure signals → environment_failure (not retryable)
  // These are tool/dependency/infra issues, not missing completion signals.
  // Real examples: npm install failures, missing CLI tools, network timeouts.
  if (input.exitCode === 3 && isEnvironmentFailure(haystack)) {
    return createAutopsy(
      'environment_failure',
      false,
      'Task failed due to an environment or tool-availability issue on the runner.',
      'Investigate the runner environment: check tool versions, network access, and dependency availability before retrying.',
      signals,
      'runner_environment_degraded',
    );
  }

  // max_turns_exceeded — Claude hit the turn limit before completing.
  // This is retryable (with higher max_turns or a simpler task scope).
  // Must come before completion_signal_missing since both can have exit code 3,
  // but max_turns is a distinct, actionable failure with a clear fix.
  if (haystack.includes('max_turns') || haystack.includes('error_max_turns') || haystack.includes('ran out of turns')) {
    const hasPr = haystack.includes('[taskrunner] pr:') || haystack.includes('pr created') || haystack.includes('pull request');
    return createAutopsy(
      'max_turns_exceeded',
      true,
      hasPr
        ? 'Task hit the turn limit but created a PR — work was likely completed, signal was not emitted before timeout.'
        : 'Task hit the turn limit before completing. Claude ran out of turns without emitting a completion signal.',
      hasPr
        ? 'Review the PR — task may be complete. If so, mark as success. Otherwise, retry with higher max_turns or split the task.'
        : 'Retry with higher max_turns (current limit may be too low for the task scope) or split into smaller subtasks.',
      signals,
    );
  }

  // Hallucinated task — agent determined the target doesn't exist
  if (
    haystack.includes("doesn't exist") && haystack.includes('hallucinated') ||
    haystack.includes('does not exist') && (haystack.includes('dreaming') || haystack.includes('self-improvement')) ||
    haystack.includes('code that doesn\'t exist')
  ) {
    return createAutopsy(
      'hallucinated_task',
      false,
      'Task referenced code or components that do not exist — likely generated by dreaming/self-improvement without verification.',
      'Improve task source (dreaming/self-improvement) to verify targets exist before queuing.',
      signals,
    );
  }

  // "Nothing to do" — agent determined work was already done but didn't signal completion
  if (
    haystack.includes('already resolved') ||
    haystack.includes('already complete') ||
    haystack.includes('already confirmed') ||
    haystack.includes('already processed') ||
    haystack.includes('nothing to do') ||
    haystack.includes('no action needed')
  ) {
    return createAutopsy(
      'work_already_done',
      false,
      'Agent determined the work was already completed or unnecessary, but did not emit a completion signal.',
      'Task should be marked as success — the agent correctly identified no work was needed. Consider improving the taskrunner to recognize "already done" as a valid completion.',
      signals,
    );
  }

  if (haystack.includes('completion signal not found') || input.exitCode === 3) {
    return createAutopsy(
      'completion_signal_missing',
      false,
      'Task exited without proving completion via the expected completion signal.',
      'Tighten the task prompt or completion signal so autonomous runs can verify success deterministically.',
      signals,
    );
  }

  return createAutopsy(
    'generic_task_failure',
    false,
    'Task failed without a more specific classifier match.',
    'Review the captured result or error output and decide whether to retry, rescope, or escalate.',
    signals,
  );
}

// ─── PR Utility Scoring (#289) ──────────────────────────────
// Two scores for completed autonomous tasks:
// - Impact: functional value relative to size (0-1)
// - Novelty: does this address a new constraint or re-churn? (0-1)

export interface TaskUtilityScore {
  impact: number;     // 0-1: functional value of the change
  novelty: number;    // 0-1: responds to new constraint vs re-churn
  signals: string[];  // human-readable scoring rationale
}

// Categories with inherently high/low impact
const HIGH_IMPACT_CATEGORIES = new Set(['bugfix', 'feature']);
const LOW_IMPACT_CATEGORIES = new Set(['docs', 'refactor']);

// Patterns in result text that signal real work
const IMPACT_POSITIVE_PATTERNS = [
  /fix(?:ed|es)?\s+(?:bug|crash|error|issue|race|leak)/i,
  /add(?:ed|s)?\s+(?:endpoint|route|handler|table|column|feature)/i,
  /implement(?:ed|s)?\s/i,
  /resolv(?:ed|es)?\s+#?\d+/i,
  /pr.*created|pull request/i,
  /test.*pass/i,
];

// Patterns that signal low-value churn
const CHURN_PATTERNS = [
  /updat(?:ed|es?)?\s+(?:comment|docstring|readme|changelog)/i,
  /renam(?:ed|es?)?\s/i,
  /reformat|lint|style|whitespace/i,
  /no\s+(?:functional|behavioral)\s+change/i,
  /minor\s+cleanup/i,
];

export function scoreTaskUtility(input: {
  title: string;
  category: string;
  result: string | null;
  created_by: string;
  pr_url: string | null;
  github_issue_number: number | null;
  recentAutoTitles: string[]; // titles of recent autonomous tasks for novelty check
}): TaskUtilityScore {
  const signals: string[] = [];
  let impact = 0.5; // baseline
  let novelty = 0.5;

  const resultText = (input.result ?? '').toLowerCase();
  const titleText = input.title.toLowerCase();
  const combined = `${titleText} ${resultText}`;

  // ── Impact scoring ─────────────────────────────────────────
  if (HIGH_IMPACT_CATEGORIES.has(input.category)) {
    impact += 0.15;
    signals.push(`category:${input.category} (+impact)`);
  } else if (LOW_IMPACT_CATEGORIES.has(input.category)) {
    impact -= 0.1;
    signals.push(`category:${input.category} (-impact)`);
  }

  // Issue-linked = responding to a real problem
  if (input.github_issue_number) {
    impact += 0.15;
    novelty += 0.2;
    signals.push(`linked:issue#${input.github_issue_number} (+impact,+novelty)`);
  }

  // PR created = shipped work
  if (input.pr_url) {
    impact += 0.1;
    signals.push('pr_created (+impact)');
  }

  // Positive patterns in result
  for (const pattern of IMPACT_POSITIVE_PATTERNS) {
    if (pattern.test(combined)) {
      impact += 0.05;
      signals.push(`pattern:${pattern.source.slice(0, 30)} (+impact)`);
      break; // only count one positive pattern
    }
  }

  // Churn patterns in result
  for (const pattern of CHURN_PATTERNS) {
    if (pattern.test(combined)) {
      impact -= 0.15;
      novelty -= 0.2;
      signals.push(`churn:${pattern.source.slice(0, 30)} (-impact,-novelty)`);
      break;
    }
  }

  // Result is just "TASK_COMPLETE" with no detail = likely low substance
  if (resultText.trim() === 'task_complete') {
    impact -= 0.1;
    signals.push('bare_completion_signal (-impact)');
  }

  // ── Novelty scoring ────────────────────────────────────────
  // Check if this task's title overlaps with recent autonomous work
  if (input.recentAutoTitles.length > 0) {
    const titleWords = new Set(
      titleText.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3),
    );
    for (const recentTitle of input.recentAutoTitles) {
      const recentWords = recentTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
      const overlap = recentWords.filter(w => titleWords.has(w)).length;
      const overlapRatio = titleWords.size > 0 ? overlap / titleWords.size : 0;
      if (overlapRatio > 0.4) {
        novelty -= 0.3;
        signals.push(`title_overlap:${overlapRatio.toFixed(2)} with "${recentTitle.slice(0, 40)}" (-novelty)`);
        break;
      }
    }
  }

  // Operator-created tasks are inherently novel (responding to real need)
  if (input.created_by === 'operator') {
    novelty += 0.2;
    signals.push('operator_created (+novelty)');
  }

  // Clamp to [0, 1]
  impact = Math.max(0, Math.min(1, impact));
  novelty = Math.max(0, Math.min(1, novelty));

  return {
    impact: Math.round(impact * 100) / 100,
    novelty: Math.round(novelty * 100) / 100,
    signals,
  };
}

export function collectContractAlerts(rows: FailureRowLike[]): Array<{
  contract: string;
  repo: string;
  task_id: string;
  summary: string;
  completed_at: string | null;
}> {
  const alerts: Array<{
    contract: string;
    repo: string;
    task_id: string;
    summary: string;
    completed_at: string | null;
  }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const autopsy = parseTaskAutopsy(row.autopsy_json);
    if (!autopsy?.system_contract) continue;
    const key = `${autopsy.system_contract}:${row.repo ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alerts.push({
      contract: autopsy.system_contract,
      repo: row.repo ?? '',
      task_id: row.id ?? '',
      summary: autopsy.summary,
      completed_at: row.completed_at ?? null,
    });
  }

  return alerts;
}
