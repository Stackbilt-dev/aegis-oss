// Sandboxed task executor — Agents SDK Durable Object + Cloudflare Sandbox.
//
// Claims a pending `do_sandbox` cc_task, clones its repository into a
// container, runs a bounded tool-calling agent on Workers AI, checks the
// result against the task's acceptance contract, and publishes a pull
// request only if every check passes. The model never publishes.
//
// Durable Objects are declared by class name in wrangler, so configuration
// is baked into the class: `export const TaskExecutorDO = createTaskExecutorDO({...})`.
//
// HTTP surface:
//   POST /run       — claim the next pending do_sandbox task and start a fiber
//   GET  /status    — current persisted state
//   GET  /artifact  — a task artifact (?taskId=&name=)

import { Agent } from 'agents';
import type { FiberRecoveryContext } from 'agents';
import { Workspace } from '@cloudflare/shell';
import { getSandbox } from '@cloudflare/sandbox';
import {
  SandboxBootstrapError,
  bootstrapSandbox,
  type BootstrapRecipe,
} from './bootstrap.js';
import {
  SandboxHarnessError,
  redactCredentials,
  runSandboxHarness,
} from './harness.js';
import {
  acceptanceAdmissionError,
  acceptanceResultNote,
  evaluateAcceptance,
  formatAcceptanceReport,
  parseAcceptanceSpec,
  STAGED_NUMSTAT_COMMAND,
  decodeStagedNumstat,
  vitestJsonCommand,
} from './acceptance.js';
import {
  RepositoryCloneError,
  cloneRepository,
  githubBasicAuthorizationValue,
} from './git.js';
import { PublicationError, publishBranch } from './publish.js';
import {
  RepoTargetError,
  defaultBranch,
  ensureFork,
  externalRepoAdmissionError,
  gitHubClient,
  issueReference,
  parseTaskRepo,
  pullRequestHead,
  recipeKey,
  type ExternalRepoPolicy,
  type TaskRepoTarget,
} from './repo.js';

/** Bindings and secrets the executor reads. Declare them in your Worker's wrangler config. */
export interface TaskExecutorEnv {
  DB: D1Database;
  AI: Ai;
  /** Durable Object namespace bound to the `Sandbox` container class. */
  TASK_SANDBOX: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
  /** Token that can clone, push to the home org, fork, and open PRs. */
  GITHUB_TOKEN?: string;
  /** Preferred over GITHUB_TOKEN when set, e.g. a narrower token for the executor. */
  GITHUB_TOKEN_SCOPED?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
}

export interface TaskExecutorConfig {
  /** GitHub organization (or user) the executor pushes to directly and forks into. */
  homeOrg: string;
  /** Commit author for published changes. */
  gitIdentity: { name: string; email: string };
  /** User-Agent for GitHub API calls. */
  userAgent?: string;
  /** Workers AI model for the tool loop. Defaults to SANDBOX_HARNESS_MODEL. */
  model?: string;
  /** Per-repository dependency setup; return null to use the default lockfile install. */
  bootstrap?: BootstrapRecipe;
  /** Repository-relative directory package commands and acceptance tests run from. Defaults to the root. */
  verificationCwd?: (repo: string) => string;
  /** Admission policy for repositories outside `homeOrg`. Defaults to defaultExternalRepoPolicy. */
  externalRepoPolicy?: ExternalRepoPolicy;
}

const REPO_PATH = '/workspace/repo';
const EXECUTOR_FIBER = 'task-executor';
export const TASK_SANDBOX_SLEEP_AFTER = '30m';
export const TASK_SANDBOX_TRANSPORT = 'rpc';
const READABLE_ARTIFACTS = new Set([
  'plan.json',
  'publish.json',
  'diff.patch',
  'git-status.txt',
  'planning-error.json',
  'navigator-error.json',
  'bootstrap.json',
  'harness.json',
  'acceptance.json',
]);

interface CCTaskRow {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  category: string;
  authority: string;
  github_issue_repo: string | null;
  github_issue_number: number | null;
}

interface TaskPlan {
  branch: string;
  executor: 'workers_ai_tool_loop';
  commit_message: string;
  pr_title: string;
  pr_body: string;
}

class TaskExecutorError extends Error {
  constructor(
    readonly kind: string,
    readonly retryable: boolean,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'TaskExecutorError';
  }
}

// Persisted in DO SQLite — survives eviction so onFiberRecovered can re-attach.
interface TaskExecutorState {
  taskId: string | null;
  phase: 'idle' | 'bootstrapping' | 'planning' | 'executing' | 'committing' | 'done' | 'failed';
  startedAt: number | null;
  llmCostUsd: number;
}

const IDLE_STATE: TaskExecutorState = {
  taskId: null,
  phase: 'idle',
  startedAt: null,
  llmCostUsd: 0,
};

export function createTaskExecutorDO(config: TaskExecutorConfig) {
  const homeOrg = config.homeOrg;
  const userAgent = config.userAgent ?? 'AEGIS-TaskExecutor/1.0';

  return class TaskExecutorDO extends Agent<TaskExecutorEnv, TaskExecutorState> {
    // Agent SDK reads this to seed first-run state.
    initialState: TaskExecutorState = IDLE_STATE;

    // SQLite-backed scratch space for intermediate results (plan JSON, logs).
    // Persists across sleeps alongside the fiber row. Uses DO's own storage.
    workspace: Workspace = new Workspace({
      sql: this.ctx.storage.sql,
      namespace: 'task_executor',
      name: () => 'task-executor',
    });

    // Aborts the in-flight fiber. Lives only in memory — recreated in
    // onFiberRecovered after eviction.
    private ctrl: AbortController | undefined;

    async isLive(): Promise<boolean> {
      return this.ctrl !== undefined && !this.ctrl.signal.aborted;
    }

    override async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/run') {
        return this.startFiber();
      }
      if (url.pathname === '/status') {
        return Response.json({ state: this.state, live: await this.isLive() });
      }
      if (request.method === 'GET' && url.pathname === '/artifact') {
        return this.readArtifact(url);
      }
      // Agent SDK handles its own protocol routes (WebSocket, RPC, etc.)
      return super.fetch(request);
    }

    private async readArtifact(url: URL): Promise<Response> {
      const taskId = url.searchParams.get('taskId') ?? '';
      const name = url.searchParams.get('name') ?? '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)
        || !READABLE_ARTIFACTS.has(name)) {
        return Response.json({ error: 'invalid task artifact request' }, { status: 400 });
      }

      try {
        const content = await this.workspace.readFile(`tasks/${taskId}/${name}`);
        return new Response(content, {
          headers: {
            'Content-Type': name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      } catch {
        return Response.json({ error: 'artifact not found' }, { status: 404 });
      }
    }

    // Called by POST /run. Returns immediately; execution runs in the fiber.
    private async startFiber(): Promise<Response> {
      if (await this.isLive()) {
        return Response.json(
          { ok: false, message: 'already running', taskId: this.state.taskId },
          { status: 409 },
        );
      }

      const resuming = this.state.taskId
        && !['idle', 'done', 'failed'].includes(this.state.phase);
      if (!resuming) {
        const task = await this.claimNextTask();
        if (!task) {
          this.setState(IDLE_STATE);
          return Response.json({ ok: true, dispatched: false, taskId: null });
        }
        this.setState({
          ...IDLE_STATE,
          taskId: task.id,
          phase: 'planning',
          startedAt: Date.now(),
        });
      }

      this.ctrl = new AbortController();
      void this.runFiber(EXECUTOR_FIBER, () => this.runTask(this.ctrl!.signal));
      return Response.json(
        { ok: true, dispatched: true, taskId: this.state.taskId },
        { status: 202 },
      );
    }

    // Fires after DO wakes from eviction mid-fiber.
    override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
      if (ctx.name !== EXECUTOR_FIBER) return;
      const { taskId, phase } = this.state;
      if (!taskId || phase === 'done' || phase === 'failed' || phase === 'idle') return;
      console.log(`[task-executor-do] fiber recovered — taskId=${taskId} phase=${phase}`);
      this.ctrl = new AbortController();
      await this.runTask(this.ctrl.signal);
    }

    private async runTask(signal: AbortSignal): Promise<void> {
      const taskId = this.state.taskId;
      if (!taskId) return;

      const task = await this.env.DB.prepare(
        'SELECT id, title, prompt, repo, category, authority, github_issue_repo, github_issue_number FROM cc_tasks WHERE id = ?',
      )
        .bind(taskId)
        .first<CCTaskRow>();
      if (!task) {
        this.setState(IDLE_STATE);
        return;
      }

      console.log(`[task-executor-do] starting ${task.id.slice(0, 8)} — ${task.title}`);

      try {
        // Reject a malformed acceptance block before spending a container on it.
        const acceptance = parseAcceptanceSpec(task.prompt);
        const admission = acceptanceAdmissionError(acceptance, task.authority);
        if (admission) {
          const kind = acceptance.kind === 'invalid' ? 'acceptance_invalid' : 'acceptance_missing';
          throw new TaskExecutorError(kind, false, 1, admission);
        }
        const external = externalRepoAdmissionError(
          { repo: task.repo, executor: 'do_sandbox', authority: task.authority, hasAcceptanceSpec: acceptance.kind === 'spec' },
          homeOrg,
          config.externalRepoPolicy,
        );
        if (external) throw new TaskExecutorError('external_repo_refused', false, 1, external);
        const target = parseTaskRepo(task.repo, homeOrg);
        // Recipes and the verification cwd key on the bare name for home-org
        // repos, so `<homeOrg>/app` is configured the same as `app`.
        const harnessTask = { ...task, repo: recipeKey(target) };

        const sandbox = getSandbox(this.env.TASK_SANDBOX, task.id, {
          sleepAfter: TASK_SANDBOX_SLEEP_AFTER,
          transport: TASK_SANDBOX_TRANSPORT,
        });
        const token = this.env.GITHUB_TOKEN_SCOPED ?? this.env.GITHUB_TOKEN ?? '';

        if (signal.aborted) return;

        // Outside repositories publish through a home-org fork; the PR targets
        // the upstream's default branch either way.
        const github = gitHubClient(token, userAgent);
        const baseBranch = await defaultBranch(github, target);
        const fork = target.external ? await ensureFork(github, target, homeOrg) : null;

        // Clone the upstream so the branch starts from its tip, not the fork's.
        await cloneRepository({ sandbox, repo: target.name, token, repoPath: REPO_PATH, org: target.owner });
        await sandbox.exec(
          `cd ${REPO_PATH} && git config user.email ${shellQuote(config.gitIdentity.email)} && git config user.name ${shellQuote(config.gitIdentity.name)}`,
        );
        if (fork) {
          const remote = await sandbox.exec(
            `cd ${REPO_PATH} && git remote add fork https://github.com/${homeOrg}/${fork}.git`,
          );
          if (!remote.success) {
            throw new RepoTargetError('fork_failed', false, `adding the fork remote failed: ${remote.stderr || remote.stdout}`);
          }
        }

        if (signal.aborted) return;

        // Bootstrap the container explicitly before asking the model to inspect or
        // verify anything. Checkpoints preserve a bounded, redacted failure trail.
        this.setState({ ...this.state, phase: 'bootstrapping' });
        await bootstrapSandbox({
          sandbox,
          repo: recipeKey(target),
          recipe: config.bootstrap,
          token,
          onCheckpoint: (result) => this.workspace.writeFile(
            `tasks/${task.id}/bootstrap.json`,
            JSON.stringify(result, null, 2),
          ),
        });

        if (signal.aborted) return;

        // The executor owns branch and publication metadata. Repository discovery,
        // edits, and verification belong to the bounded tool loop below.
        this.setState({ ...this.state, phase: 'planning' });
        const plan = this.createPlan(task, target);
        await this.workspace.writeFile(`tasks/${task.id}/plan.json`, JSON.stringify(plan, null, 2));

        if (signal.aborted) return;

        // Execute
        this.setState({ ...this.state, phase: 'executing' });
        const checkout = await sandbox.exec(`cd ${REPO_PATH} && git checkout -b ${plan.branch}`);
        if (!checkout.success) {
          throw new Error(
            `branch creation failed (exit ${checkout.exitCode}): ${checkout.stderr || checkout.stdout}`,
          );
        }
        await this.workspace.writeFile(
          `tasks/${task.id}/harness.json`,
          JSON.stringify({ status: 'started', model: 'workers_ai', iterations: 0, events: [] }, null, 2),
        );
        let harness;
        try {
          harness = await runSandboxHarness({
            sandbox,
            repoPath: REPO_PATH,
            task: harnessTask,
            model: config.model,
            verificationCwd: config.verificationCwd?.(harnessTask.repo) ?? '',
            env: this.env,
            signal,
            onCheckpoint: (result) => this.workspace.writeFile(
              `tasks/${task.id}/harness.json`,
              JSON.stringify(result, null, 2),
            ),
          });
        } catch (error) {
          if (signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          throw new TaskExecutorError('harness_failed', true, 1, `sandbox harness failed: ${message}`);
        }
        await this.workspace.writeFile(
          `tasks/${task.id}/harness.json`,
          JSON.stringify(harness, null, 2),
        );
        const summary = harness.textToolCall
          ? '_The model ended with an unparsed tool call (#766); its raw output is kept in harness.json._'
          : harness.summary.slice(0, 2_000);
        plan.pr_body = `${plan.pr_body}\n\nHarness summary:\n\n${summary}`;

        if (signal.aborted) return;

        // Decide acceptance from facts the executor gathers itself, before
        // anything is published, so a false completion never becomes a PR (G15).
        const packageCwd = config.verificationCwd?.(harnessTask.repo) ?? '';
        const verdict = await evaluateAcceptance(acceptance.kind === 'spec' ? acceptance.spec : null, {
          listChangedFiles: async () => {
            const staged = await sandbox.exec(`cd ${REPO_PATH} && ${STAGED_NUMSTAT_COMMAND}`);
            if (!staged.success) {
              throw new TaskExecutorError('acceptance_check_failed', true, 1, `changed-file inspection failed: ${staged.stderr || staged.stdout}`);
            }
            try {
              return decodeStagedNumstat(staged.stdout);
            } catch (error) {
              throw new TaskExecutorError('acceptance_check_failed', true, 1, `changed-file inspection failed: ${(error as Error).message}`);
            }
          },
          readFile: async (path) => {
            try {
              return (await sandbox.readFile(`${REPO_PATH}/${path}`)).content;
            } catch {
              return null;
            }
          },
          runTests: async (command) => {
            // Chosen now, after the model finished: edited test code cannot predict it.
            const reportPath = `/tmp/acceptance-${crypto.randomUUID()}.json`;
            const cwd = packageCwd ? `${REPO_PATH}/${packageCwd}` : REPO_PATH;
            const run = await sandbox.exec(vitestJsonCommand(command, reportPath), { cwd, timeout: 300_000 });
            try {
              return { exitCode: run.exitCode, report: (await sandbox.readFile(reportPath)).content };
            } catch {
              return { exitCode: run.exitCode, report: null };
            }
          },
        });
        await this.workspace.writeFile(`tasks/${task.id}/acceptance.json`, JSON.stringify(verdict, null, 2));
        if (verdict.status === 'failed') {
          const diff = await sandbox.exec(`cd ${REPO_PATH} && git diff --cached`);
          await this.workspace.writeFile(`tasks/${task.id}/diff.patch`, redactCredentials(diff.stdout).slice(0, 200_000));
          const failed = verdict.checks.filter((check) => !check.ok).map((check) => `${check.check}: ${check.detail}`);
          throw new TaskExecutorError('acceptance_failed', true, 1, `acceptance checks failed — ${failed.join('; ')}`);
        }
        plan.pr_body = `${plan.pr_body}\n\n${formatAcceptanceReport(verdict)}`;

        if (signal.aborted) return;

        // Publish in independently recorded stages so a failure preserves the
        // diff and enough diagnostics to resume or repair the task.
        this.setState({ ...this.state, phase: 'committing' });
        const published = await publishBranch({
          repoPath: REPO_PATH,
          branch: plan.branch,
          commitMessage: plan.commit_message,
          exec: (command) => sandbox.exec(command),
          writeArtifact: (path, content) => this.workspace.writeFile(path, content),
          pushRemote: fork ? 'fork' : undefined,
          createPullRequest: (branch) => this.createPR(target, baseBranch, plan, token, branch),
          branchForChange: (changeKey) => `auto/do-sandbox/${changeKey}`,
          findOpenPullRequest: (branch) => this.findOpenPullRequest(target, branch, token),
          artifactPrefix: `tasks/${task.id}/`,
          secrets: [token],
          pushAuthHeader: `Authorization: ${githubBasicAuthorizationValue(token)}`,
        });

        // Complete. The branch is only known after publication now that it is
        // derived from the change, so record the final name rather than the plan's.
        await this.env.DB.prepare(
          `UPDATE cc_tasks SET status = 'completed', result = ?, pr_url = ?, branch = ?, exit_code = 0,
           failure_kind = NULL, retryable = 0, completed_at = datetime('now') WHERE id = ?`,
        )
          .bind(
            `${published.attached
              ? `Change ${published.changeKey} was already published; attached to ${published.prUrl}`
              : `Published ${published.commitSha.slice(0, 12)}: ${published.prUrl}`} (${acceptanceResultNote(verdict)})`,
            published.prUrl,
            published.branch,
            task.id,
          )
          .run();

        this.setState({ ...this.state, taskId: null, phase: 'done' });
        console.log(`[task-executor-do] ${task.id.slice(0, 8)} → completed — ${published.prUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // `no_changes` resolves the task successfully, so the DO must not land in
        // the failed phase for it.
        let terminalPhase: TaskExecutorState['phase'] = 'failed';
        if (err instanceof SandboxBootstrapError) {
          await this.workspace.writeFile(
            `tasks/${task.id}/bootstrap.json`,
            JSON.stringify(err.result, null, 2),
          );
          await this.failTask(task.id, msg, 'bootstrap_failed', true, 1);
        } else if (err instanceof SandboxHarnessError) {
          await this.failTask(task.id, msg, 'harness_failed', true, 1);
        } else if (err instanceof PublicationError && err.kind === 'no_changes') {
          // Nothing to publish means the change is already on the base branch —
          // the work is delivered, so this is a terminal success. Recording it as
          // a failure made re-running delivered work indistinguishable from a
          // real regression, which matters most for the health-check canary: once
          // its change merges, every subsequent run would report failed.
          await this.env.DB.prepare(
            `UPDATE cc_tasks SET status = 'completed', result = ?, exit_code = 0,
             failure_kind = NULL, retryable = 0, completed_at = datetime('now') WHERE id = ?`,
          )
            .bind('No changes to publish — the change is already present on the base branch', task.id)
            .run();
          terminalPhase = 'done';
          console.log(`[task-executor-do] ${task.id.slice(0, 8)} → completed (no changes to publish)`);
        } else if (
          err instanceof PublicationError
          || err instanceof TaskExecutorError
          || err instanceof RepositoryCloneError
          || err instanceof RepoTargetError
        ) {
          await this.failTask(task.id, msg, err.kind, err.retryable, 'exitCode' in err ? err.exitCode : 1);
        } else {
          await this.failTask(task.id, msg);
        }
        this.setState({ ...this.state, taskId: null, phase: terminalPhase });
      } finally {
        this.ctrl = undefined;
      }
    }

    private async claimNextTask(): Promise<CCTaskRow | null> {
      return this.env.DB.prepare(
        `UPDATE cc_tasks
         SET status = 'running', started_at = datetime('now'), session_id = 'do-sandbox'
         WHERE id = (
           SELECT id FROM cc_tasks
           WHERE status = 'pending'
             AND executor = 'do_sandbox'
             AND authority IN ('auto_safe', 'operator')
           ORDER BY priority ASC, created_at ASC
           LIMIT 1
         )
         RETURNING id, title, prompt, repo, category, authority, github_issue_repo, github_issue_number`,
      ).first<CCTaskRow>();
    }

    private createPlan(task: CCTaskRow, target: TaskRepoTarget): TaskPlan {
      const slug = task.id.slice(0, 8);
      // First line, so GitHub and PR-side checks (the agent-acceptance Action)
      // tie the PR to the issue — and the contract — the task came from.
      const link = issueReference(target, task.github_issue_repo, task.github_issue_number);
      const intro = `Automated, sandboxed change from task ${task.id}. The executor retained branch and publication authority.`;
      return {
        branch: `auto/do-sandbox/${slug}`,
        executor: 'workers_ai_tool_loop',
        commit_message: `chore: autonomous task ${slug}`,
        pr_title: task.title.slice(0, 70),
        pr_body: link ? `${link}\n\n${intro}` : intro,
      };
    }

    private async createPR(
      target: TaskRepoTarget,
      base: string,
      plan: TaskPlan,
      token: string,
      branch: string = plan.branch,
    ): Promise<string> {
      const resp = await fetch(`https://api.github.com/repos/${target.owner}/${target.name}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
        },
        body: JSON.stringify({
          title: plan.pr_title,
          body: plan.pr_body,
          head: pullRequestHead(target, branch, homeOrg),
          base,
        }),
      });

      // A 422 here is most often "a pull request already exists for this head" —
      // a concurrent attempt won the race. Reuse its PR instead of failing the
      // task, so publication stays idempotent under retries.
      if (resp.status === 422) {
        const existing = await this.findOpenPullRequest(target, branch, token);
        if (existing) return existing;
      }

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`GitHub PR creation failed (${resp.status}): ${err.slice(0, 300)}`);
      }

      const data = (await resp.json()) as { html_url: string };
      return data.html_url;
    }

    private async findOpenPullRequest(
      target: TaskRepoTarget,
      branch: string,
      token: string,
    ): Promise<string | null> {
      const resp = await fetch(
        `https://api.github.com/repos/${target.owner}/${target.name}/pulls`
          + `?state=open&head=${encodeURIComponent(`${homeOrg}:${branch}`)}&per_page=1`,
        { headers: this.githubHeaders(token) },
      );
      if (!resp.ok) {
        console.warn(`[task-executor-do] PR lookup for ${branch} failed (${resp.status})`);
        return null;
      }
      const prs = (await resp.json()) as Array<{ html_url: string }>;
      return prs[0]?.html_url ?? null;
    }

    private githubHeaders(token: string): Record<string, string> {
      return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': userAgent,
      };
    }

    private async failTask(
      taskId: string,
      error: string,
      failureKind = 'do_sandbox_error',
      retryable = false,
      exitCode = 1,
    ): Promise<void> {
      console.error(`[task-executor-do] ${taskId.slice(0, 8)} failed:`, error.slice(0, 200));
      await this.env.DB.prepare(
        `UPDATE cc_tasks SET status = 'failed', error = ?, failure_kind = ?, retryable = ?,
         exit_code = ?, completed_at = datetime('now') WHERE id = ?`,
      )
        .bind(error.slice(0, 1000), failureKind, retryable ? 1 : 0, exitCode, taskId)
        .run();
    }
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
