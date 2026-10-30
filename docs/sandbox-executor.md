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

   The contract format is the same as [`@stackbilt/agent-acceptance`](https://github.com/Stackbilt-dev/agent-acceptance). Test commands may be `pnpm exec vitest run …`, `npx vitest run …` or `yarn vitest run …`, the same runners the Action accepts. They run from the `verificationCwd` for the repository.
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
import { taskExecutorDispatchPlugin, taskExecutorRoutes } from '@stackbilt/aegis-core/factory';
import { createTaskExecutorDO } from '@stackbilt/aegis-core/factory/executor';

export { Sandbox } from '@stackbilt/aegis-core/factory/executor';

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

`@stackbilt/aegis-core/factory/executor` holds the two classes and needs the Workers runtime. Everything else, including the acceptance and policy helpers, comes from `@stackbilt/aegis-core/factory`, which also loads under plain Node (tests, scripts, MCP handlers).

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

## Linking a task to its issue

Pass `github_issue_repo` (`"owner/name"`) and `github_issue_number` to `aegis_create_cc_task` when a task comes from a GitHub issue:

- If the issue is in the repository the PR targets, the PR's first line is `Fixes #N`. GitHub links the PR and closes the issue on merge.
- For an issue elsewhere, the first line is a non-closing `Refs owner/name#N`.

This also lets the maintainer verify the PR independently. With the [agent-acceptance](https://github.com/Stackbilt-dev/agent-acceptance) Action on the upstream repo, put the same acceptance block in the issue (written by someone the repo trusts) and in the task prompt. The executor checks it before publishing, and the Action re-checks it on the PR from the issue, without trusting the executor.

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

**Know the exposure.** Fork mode runs the upstream's install scripts and tests inside the container. Without the egress broker below, your GitHub token appears on the `git clone` and `git push` command lines, and anything those scripts leave behind, such as a git hook or a running process, can read it. Turn the broker on, use a token scoped to what the executor needs, and run fork mode only on repositories you have reviewed.

## Egress broker

Without the broker, code in the container has open internet access and can reach the token as described above. With it, the container holds a placeholder token and its network is closed. A handler in the Worker attaches the real token on the way out.

```ts
export { BrokeredSandbox as Sandbox, ContainerProxy } from '@stackbilt/aegis-core/factory/executor';

export const TaskExecutorDO = createTaskExecutorDO({
  homeOrg: 'your-org',
  gitIdentity: { name: 'Your Agent', email: 'agent@example.com' },
  egressBroker: true,
});
```

Your Worker needs `ctx.exports`: a compatibility date of 2025-11-17 or later, or the `enable_ctx_exports` flag. Set both halves: exporting `BrokeredSandbox` without `egressBroker: true` closes the network but still puts the real token on the command line, and the task's push is refused. With `egressBroker: true` and a plain `Sandbox`, the task fails with `egress_setup_failed` before anything runs in the container.

Before any repository code runs, the task also checks from inside the container that a push and a registry write are refused by this policy and that `example.com` is unreachable. Each time the allowed access changes while the task runs, it checks that new requests get the new access. If any of that fails, the task fails with `egress_setup_failed`.

What a brokered task can do depends on the stage:

| Traffic | Clone and bootstrap | Model and tests | Executor's push |
|---|---|---|---|
| Read the task's repository and its siblings cloned with `cloneSiblingCommand` | Real token | No credentials | No credentials |
| Read anything else on `github.com` | No credentials | No credentials | No credentials |
| Push the commit the executor made to the task's branch, in the repository it publishes to (its fork in fork mode) | 403 | 403 | Real token |
| Any other push, including another branch, another commit, a delete, or another repository | 403 | 403 | 403 |
| Other writes to `github.com`, including all Git LFS traffic | 403 | 403 | 403 |
| `GET`/`HEAD` to the other hosts in `SANDBOX_EGRESS_HOSTS` | No credentials | No credentials | No credentials |
| Writes to those hosts | 403 | 403 | 403 |
| Plain `http://` to any of these hosts | 403 | 403 | 403 |
| Every other host | Blocked | Blocked | Blocked |

If your repository's install or tests read from another host, use `createBrokeredSandbox`. Don't subclass `BrokeredSandbox`: handlers are registered per class name, so a subclass would have none.

```ts
import { createBrokeredSandbox } from '@stackbilt/aegis-core/factory/executor';

export const Sandbox = createBrokeredSandbox({ extraReadOnlyHosts: ['files.example.com'] });
```

What the broker doesn't cover:
- **Whatever the task stages gets published.** `git add -A` publishes the repository's tree, so code in the container can put anything it can read into the pull request. That includes a private sibling already cloned to disk. Don't give a public repository private siblings.
- **A process left running isn't stopped.** It can't push anything but the executor's commit to the task's branch, but it can change the files between the acceptance check and the commit. A push can also carry extra objects that no branch points to, and GitHub may serve those by hash, so the same warning about public repositories applies.
- **Workflows in the pushed commit.** With the `workflow` scope, a commit that adds a workflow can run on `push` with the repository's Actions secrets, before anyone reviews it. Leave that scope off the token, and protect your default branch.
- **Git LFS.** Its batch API is a `POST`, so a repository that needs LFS objects at checkout fails.
- **Private registries.** Credentials for them aren't brokered, and those hosts aren't on the list.
- **Data in URLs.** `GET` requests to allowed hosts can carry data in their URLs. That only helps an attacker who can read those hosts' logs.

## Limits

- One task at a time per executor. It's a single Durable Object.
- Files over 40,000 characters can't be edited by the agent's tools.
- If the Durable Object is evicted mid-task, the task restarts from the clone step; it doesn't resume where it stopped. Publication is idempotent for an identical diff, but a re-run can produce a different diff.
- The `tests` check supports vitest only.
