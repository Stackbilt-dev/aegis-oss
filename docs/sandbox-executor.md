# Sandbox task executor

The sandbox task executor runs a coding task in a disposable [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container and opens a pull request **only if the task's acceptance contract passes**. An agent's summary of its own work is never used as evidence.

It is optional. A default AEGIS deploy doesn't include it, stays on the Workers free tier, and needs no Docker.

## What a task does

1. **Claim.** The executor claims one pending `cc_tasks` row with `executor = 'do_sandbox'`.
2. **Clone.** It clones the repository into a fresh container. A bare `repo` name means a repository in your home organization. `owner/name` means a repository outside it, which runs in fork mode (step 7).
3. **Bootstrap.** It installs dependencies from the committed root lockfile (`pnpm install --frozen-lockfile` or `npm ci`), or from a recipe you configure.
4. **Run the agent.** A tool-calling agent on Workers AI inspects, edits and runs tests. By default it uses `@cf/moonshotai/kimi-k2.7-code`. It can't push, commit or open a PR; the executor keeps that authority.
5. **Acceptance.** The executor checks the ` ```acceptance ` block from the task prompt against facts it gathers itself:
   - the staged diff;
   - file contents;
   - vitest re-runs, with the pass count read from a JSON report at a path chosen after the agent has finished.

   The contract format is the same as [`@stackbilt/agent-acceptance`](https://github.com/Stackbilt-dev/agent-acceptance), except that test commands here must be `pnpm exec vitest run …`, run from the `verificationCwd` for the repository.
6. **Branch naming.** The branch is named after a hash of the diff. A re-run that produces the same change attaches to the existing PR instead of opening another.
7. **Publish.** Only a passing change is published:
   - Home-org repos: the branch is pushed to the repo and the PR opens there.
   - Outside repos: the executor forks the repo into your home org as `<owner>--<name>`, pushes there, and opens the PR on the upstream.

   A failing change opens nothing. Its artifacts (`acceptance.json`, `diff.patch`, `harness.json` and others) are kept for diagnosis.

## Requirements

- Workers Paid plan (Containers).
- A Docker-capable build to push the container image: CI, or a machine with Docker.
- A GitHub token (`GITHUB_TOKEN`, or `GITHUB_TOKEN_SCOPED` to prefer a narrower one) that can clone, push to your home org, and, for fork mode, create forks there and open PRs on public repositories.
- Repositories whose tests run under vitest, if you want the `tests` acceptance check.

## Setup

### 1. Export the classes from your Worker

```ts
import { createAegisApp } from '@stackbilt/aegis-core';
import {
  createTaskExecutorDO,
  taskExecutorDispatchPlugin,
  taskExecutorRoutes,
} from '@stackbilt/aegis-core/factory';

export { Sandbox } from '@stackbilt/aegis-core/factory';

export const TaskExecutorDO = createTaskExecutorDO({
  homeOrg: 'your-org',
  gitIdentity: { name: 'Your Agent', email: 'agent@example.com' },
  // Optional:
  // model: '@cf/moonshotai/kimi-k2.7-code',
  // verificationCwd: (repo) => (repo === 'monorepo' ? 'packages/app' : ''),
  // bootstrap: (repo, token) => null,     // null → default lockfile install
  // externalRepoPolicy: defaultExternalRepoPolicy,
});

const aegis = createAegisApp({
  operator,
  scheduledTasks: [taskExecutorDispatchPlugin],   // dispatches pending tasks on the hourly heartbeat
  routes: [taskExecutorRoutes],                   // /api/task-executor/{run,status,artifacts}
});
```

### 2. Enable the bindings

In `wrangler.toml`, uncomment the **Sandbox task executor** block at the end of `wrangler.toml.example`. It adds the container, two Durable Object bindings (`TASK_SANDBOX` and `TASK_EXECUTOR`) and a migration. Copy `Dockerfile.sandbox` next to your `wrangler.toml`.

Keep the image tag in `Dockerfile.sandbox` equal to the `@cloudflare/sandbox` version in `package.json`. A mismatched SDK and image break the RPC transport between them.

### 3. Migrate an existing database

Databases created before 0.9.0 need the `executor` column:

```bash
npx wrangler d1 execute <db> --remote --file=migrations/0001_cc_tasks_executor.sql
```

Existing tasks keep `executor = 'claude_code'` and are untouched.

### 4. Set the token and deploy

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy        # builds and pushes the container image; needs Docker
```

Wait a couple of minutes after a deploy before dispatching. Container rollout lags the Worker.

## Queue a task

Use the MCP tool `aegis_create_cc_task` with `executor: "do_sandbox"`:

````text
title:     Collapse repeated separators in slugify
repo:      your-org/your-repo        (or someone/public-repo for fork mode)
executor:  do_sandbox
authority: operator
prompt:
  slugify('a  b') returns 'a--b'; it should return 'a-b'. Fix the replacement and add a
  regression test named "collapses runs of separators into one dash".

  ```acceptance
  {
    "changed_files_only": ["src/slugify.ts", "tests/slugify.test.ts"],
    "max_added_lines": 15,
    "tests": [{ "command": "pnpm exec vitest run tests/slugify.test.ts", "passed": 4 }]
  }
  ```
````

The heartbeat dispatches it within the hour. To dispatch now, call `POST /api/task-executor/run` with your AEGIS bearer token. Read artifacts from `GET /api/task-executor/artifacts/<taskId>/acceptance.json`.

## Acceptance rules

- `auto_safe` tasks must carry an acceptance block. `aegis_create_cc_task` rejects a task without one, and the executor rejects it again when claiming it.
- `operator` tasks may omit the block. Their PRs say **Acceptance: not machine-checked**, so review those diffs yourself.
- A malformed block is always rejected.

## Fork mode and its policy

By default, `defaultExternalRepoPolicy` admits a task on a repository outside `homeOrg` only if all three hold:
- the task runs on `do_sandbox`;
- it has `operator` authority;
- it carries an acceptance block.

Pass your own `externalRepoPolicy` to be stricter (for example, an allowlist of owners) or looser. The executor applies it when it claims a task.

**Know the exposure.** Fork mode runs the upstream's install scripts and tests inside the container. Your GitHub token never enters the container's environment. It does appear on the `git clone` and `git push` command lines, so a process left running by a hostile repository could read it. Use a token scoped to what the executor needs, and run fork mode only on repositories you have reviewed.

## Limits

- One task at a time per executor. It's a single Durable Object.
- Files over 40,000 characters can't be edited by the agent's tools.
- If the Durable Object is evicted mid-task, the task restarts from the clone step; it doesn't resume where it stopped. Publication is idempotent for an identical diff, but a re-run can produce a different diff.
- The `tests` check supports vitest only.
