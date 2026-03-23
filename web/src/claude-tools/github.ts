// GitHub in-process tool definitions + handlers
// Extracted from claude-tools.ts for LOC governance

import {
  getRepoTree,
  getFileContent,
  getRecentCommits,
  listIssues,
  listPullRequests,
  listOrgRepos,
  createIssue,
  createBranch,
  getFileSha,
  updateFile,
  createPullRequest,
  createBlob,
  getBaseTreeSha,
  createTree,
  createGitCommit,
  updateRef,
  listWorkflowRuns,
  getCombinedStatus,
  mergePullRequest,
  resolveRepoName,
} from '../github.js';
import { addAgendaItem } from '../kernel/memory/index.js';
import { ensureOnBoard } from '../kernel/board.js';

// ─── Tool definitions ────────────────────────────────────────

const REPO_PARAM = { repo: { type: 'string', description: 'GitHub repo in "org/name" format. Defaults to the AEGIS repo.' } };

const LIST_REPO_FILES_TOOL = {
  name: 'list_repo_files',
  description: 'List all files in a GitHub repository as a flat path list. Defaults to the AEGIS repo. Use this to understand repo structure before reading specific files.',
  input_schema: { type: 'object' as const, properties: { ...REPO_PARAM }, required: [] },
};

const READ_REPO_FILE_TOOL = {
  name: 'read_repo_file',
  description: 'Read the content of a file from a GitHub repository. Defaults to the AEGIS repo. Content is truncated at 8000 chars.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'File path relative to repo root (e.g., "web/src/claude.ts")' },
      ...REPO_PARAM,
    },
    required: ['path'],
  },
};

const GET_REPO_COMMITS_TOOL = {
  name: 'get_repo_commits',
  description: 'Get recent commits from a GitHub repository. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Number of commits to fetch (default: 10, max: 20)' },
      ...REPO_PARAM,
    },
    required: [],
  },
};

const GET_REPO_ISSUES_TOOL = {
  name: 'get_repo_issues',
  description: 'List GitHub issues for a repository. Defaults to the AEGIS repo. Check before creating new issues to avoid duplicates.',
  input_schema: {
    type: 'object' as const,
    properties: {
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter (default: open)' },
      ...REPO_PARAM,
    },
    required: [],
  },
};

const GET_REPO_PRS_TOOL = {
  name: 'get_repo_prs',
  description: 'List pull requests for a GitHub repository. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter (default: open)' },
      ...REPO_PARAM,
    },
    required: [],
  },
};

const CREATE_IMPROVEMENT_ISSUE_TOOL = {
  name: 'create_improvement_issue',
  description: 'Create a GitHub issue and mirror it to the agent agenda. Use for improvements, bugs, or tasks requiring human review. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Issue title — concise and specific' },
      body: { type: 'string', description: 'Full issue body in Markdown — problem, proposed solution, affected files' },
      labels: { type: 'array', items: { type: 'string' }, description: 'GitHub labels (e.g., ["self-improvement", "enhancement"])' },
      priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Agenda priority' },
      ...REPO_PARAM,
    },
    required: ['title', 'body', 'priority'],
  },
};

const CREATE_IMPROVEMENT_PR_TOOL = {
  name: 'create_improvement_pr',
  description: 'Create a GitHub branch, apply a single-file change, and open a pull request. Single-file changes only. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR description in Markdown — what changed and why' },
      file_path: { type: 'string', description: 'Repo-relative path to file to modify (e.g., "web/src/groq.ts")' },
      new_content: { type: 'string', description: 'Complete new file content (full file, not a diff)' },
      branch_name: { type: 'string', description: 'Branch name to create (e.g., "aegis/improve-error-handling")' },
      commit_message: { type: 'string', description: 'Git commit message for the file change' },
      ...REPO_PARAM,
    },
    required: ['title', 'body', 'file_path', 'new_content', 'branch_name', 'commit_message'],
  },
};

const CREATE_MULTI_FILE_PR_TOOL = {
  name: 'create_multi_file_pr',
  description: 'Create a GitHub branch with multiple file changes in a single atomic commit, then open a pull request. Use when a change touches 2+ files. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR description in Markdown' },
      branch_name: { type: 'string', description: 'Branch name (e.g., "aegis/multi-file-fix")' },
      commit_message: { type: 'string', description: 'Git commit message' },
      files: {
        type: 'array',
        description: 'Array of file changes (max 20)',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to repo root' },
            content: { type: 'string', description: 'Complete new file content' },
          },
          required: ['path', 'content'],
        },
      },
      ...REPO_PARAM,
    },
    required: ['title', 'body', 'branch_name', 'commit_message', 'files'],
  },
};

const LIST_ORG_REPOS_TOOL = {
  name: 'list_org_repos',
  description: 'List repositories in a GitHub organization. Useful for discovering repos, checking what projects exist, and cross-repo awareness. Defaults to the org derived from GITHUB_REPO.',
  input_schema: {
    type: 'object' as const,
    properties: {
      org: { type: 'string', description: 'GitHub org (default: derived from GITHUB_REPO)' },
      type: { type: 'string', enum: ['all', 'public', 'private'], description: 'Repo type filter (default: all)' },
    },
    required: [],
  },
};

const GET_CI_STATUS_TOOL = {
  name: 'get_ci_status',
  description: 'Get CI/CD status for a branch or commit. Shows both GitHub Actions workflow runs and commit status checks. Defaults to the AEGIS repo main branch.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ref: { type: 'string', description: 'Branch name or commit SHA (default: "main")' },
      ...REPO_PARAM,
    },
    required: [],
  },
};

const TRIGGER_WORKER_DEPLOY_TOOL = {
  name: 'trigger_worker_deploy',
  description: 'Propose a Worker deployment for operator approval. NEVER auto-deploys — always creates a [PROPOSED ACTION] agenda item. Use when CI is green and a deploy is warranted. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reason: { type: 'string', description: 'Why a deploy is needed (e.g., "CI passed on PR #42, ready to ship")' },
      pr_numbers: { type: 'array', items: { type: 'number' }, description: 'PR numbers included in this deploy (optional)' },
      ...REPO_PARAM,
    },
    required: ['reason'],
  },
};

const MERGE_PR_TOOL = {
  name: 'merge_pull_request',
  description: 'Merge an approved pull request. Uses squash by default for clean history. Auto-resolves the matching agenda item. Defaults to the AEGIS repo.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pull_number: { type: 'number', description: 'PR number to merge' },
      method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge strategy (default: squash)' },
      commit_message: { type: 'string', description: 'Custom squash/merge commit message (optional)' },
      ...REPO_PARAM,
    },
    required: ['pull_number'],
  },
};

export const GITHUB_TOOLS = [
  LIST_ORG_REPOS_TOOL,
  LIST_REPO_FILES_TOOL,
  READ_REPO_FILE_TOOL,
  GET_REPO_COMMITS_TOOL,
  GET_REPO_ISSUES_TOOL,
  GET_REPO_PRS_TOOL,
  GET_CI_STATUS_TOOL,
  TRIGGER_WORKER_DEPLOY_TOOL,
  CREATE_IMPROVEMENT_ISSUE_TOOL,
  CREATE_IMPROVEMENT_PR_TOOL,
  CREATE_MULTI_FILE_PR_TOOL,
  MERGE_PR_TOOL,
];

// ─── Handler ─────────────────────────────────────────────────

export async function handleGithubTool(
  db: D1Database,
  name: string,
  input: Record<string, unknown>,
  githubToken: string,
  githubRepo: string,
): Promise<string | null> {
  const targetRepo = resolveRepoName((input.repo as string | undefined) ?? githubRepo);

  if (name === 'list_org_repos') {
    const org = (input.org as string | undefined) ?? githubRepo.split('/')[0];
    const type = (input.type as 'all' | 'public' | 'private' | undefined) ?? 'all';
    const repos = await listOrgRepos(githubToken, org, type);
    if (repos.length === 0) return `No repositories found in ${org}.`;
    return repos.map(r =>
      `**${r.name}** (${r.visibility}) — ${r.description ?? 'no description'}\n  ${r.language ?? 'n/a'} · updated ${r.updated_at.slice(0, 10)} · ${r.url}`
    ).join('\n');
  }

  if (name === 'list_repo_files') {
    const paths = await getRepoTree(githubToken, targetRepo);
    return `Repository file tree (${paths.length} files):\n${paths.join('\n')}`;
  }

  if (name === 'read_repo_file') {
    const path = input.path as string;
    try {
      const content = await getFileContent(githubToken, targetRepo, path);
      const truncated = content.length > 8000
        ? content.slice(0, 8000) + `\n\n[... truncated at 8000 of ${content.length} chars ...]`
        : content;
      return `File: ${path}\n\`\`\`\n${truncated}\n\`\`\``;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) {
        return `File not found: "${path}" in ${targetRepo}. Call list_repo_files to get the correct path, then retry.`;
      }
      throw err;
    }
  }

  if (name === 'get_repo_commits') {
    const limit = Math.min((input.limit as number | undefined) ?? 10, 20);
    const commits = await getRecentCommits(githubToken, targetRepo, limit);
    return commits.map(c =>
      `${c.sha.slice(0, 8)} — ${c.message} (${c.author}, ${c.date.slice(0, 10)})`
    ).join('\n');
  }

  if (name === 'get_repo_issues') {
    const state = (input.state as 'open' | 'closed' | 'all' | undefined) ?? 'open';
    const issues = await listIssues(githubToken, targetRepo, state);
    if (issues.length === 0) return 'No issues found.';
    return issues.map(i =>
      `#${i.number}: ${i.title} [${i.state}]${i.labels.length ? ` (${i.labels.join(', ')})` : ''} — ${i.url}`
    ).join('\n');
  }

  if (name === 'get_repo_prs') {
    const state = (input.state as 'open' | 'closed' | 'all' | undefined) ?? 'open';
    const prs = await listPullRequests(githubToken, targetRepo, state);
    if (prs.length === 0) return 'No pull requests found.';
    return prs.map(p =>
      `#${p.number}: ${p.title} [${p.state}${p.merged ? ', merged' : ''}] ${p.head} → ${p.base} — ${p.url}`
    ).join('\n');
  }

  if (name === 'get_ci_status') {
    const ref = (input.ref as string | undefined) ?? 'main';
    const [status, runs] = await Promise.all([
      getCombinedStatus(githubToken, targetRepo, ref),
      listWorkflowRuns(githubToken, targetRepo, ref, 5),
    ]);
    const parts: string[] = [];
    if (status.total > 0) {
      parts.push(`**Commit status** (${ref}): ${status.state} (${status.total} checks)`);
      for (const s of status.statuses) {
        parts.push(`  ${s.state === 'success' ? '+' : s.state === 'pending' ? '~' : '-'} ${s.context}: ${s.state} — ${s.description}`);
      }
    } else {
      parts.push(`**Commit status** (${ref}): no status checks`);
    }
    if (runs.length > 0) {
      parts.push(`\n**Actions** (${ref}):`);
      for (const r of runs) {
        const icon = r.conclusion === 'success' ? '+' : r.conclusion === 'failure' ? '-' : '~';
        parts.push(`  ${icon} ${r.name}: ${r.conclusion ?? r.status} (${r.event}, ${r.created_at.slice(0, 10)}) — ${r.url}`);
      }
    } else {
      parts.push(`\n**Actions** (${ref}): no workflow runs`);
    }
    return parts.join('\n');
  }

  if (name === 'merge_pull_request') {
    const pullNumber = input.pull_number as number;
    const method = (input.method as 'merge' | 'squash' | 'rebase' | undefined) ?? 'squash';
    const commitMessage = input.commit_message as string | undefined;
    const result = await mergePullRequest(githubToken, targetRepo, pullNumber, method, commitMessage);
    if (!result.merged) return `Failed to merge PR #${pullNumber}: ${result.message}`;
    // Auto-resolve matching agenda item
    await db.prepare(
      "UPDATE agent_agenda SET status = 'done', resolved_at = datetime('now') WHERE status = 'active' AND item LIKE ?"
    ).bind(`%PR #${pullNumber}%`).run();
    return `Merged PR #${pullNumber} via ${method} (sha: ${result.sha.slice(0, 8)}). Agenda item auto-resolved.`;
  }

  if (name === 'create_improvement_issue') {
    const i = input as { title: string; body: string; labels?: string[]; priority: 'low' | 'medium' | 'high' };
    const { number, url } = await createIssue(
      githubToken, targetRepo, i.title, i.body,
      i.labels ?? ['self-improvement'],
    );

    // Add to project board
    const projectIdRow = await db.prepare(
      "SELECT received_at FROM web_events WHERE event_id = 'board_project_id'"
    ).first<{ received_at: string }>();
    if (projectIdRow?.received_at) {
      await ensureOnBoard(db, githubToken, projectIdRow.received_at, targetRepo, number, i.title, 'backlog').catch(() => {});
    }

    return `Created GitHub issue #${number}: ${url}`;
  }

  if (name === 'create_improvement_pr') {
    const i = input as {
      title: string;
      body: string;
      file_path: string;
      new_content: string;
      branch_name: string;
      commit_message: string;
    };
    // 1. Get HEAD SHA from most recent commit
    const commits = await getRecentCommits(githubToken, targetRepo, 1);
    if (commits.length === 0) throw new Error('Could not resolve HEAD SHA');
    const headSha = commits[0].sha;
    // 2. Create branch
    await createBranch(githubToken, targetRepo, i.branch_name, headSha);
    // 3. Get current file SHA for optimistic concurrency
    const fileSha = await getFileSha(githubToken, targetRepo, i.file_path, i.branch_name);
    // 4. Update file on new branch
    await updateFile(githubToken, targetRepo, i.file_path, i.new_content, i.commit_message, fileSha, i.branch_name);
    // 5. Open PR
    const { number, url } = await createPullRequest(githubToken, targetRepo, i.title, i.body, i.branch_name);
    return `Created PR #${number}: ${url}\nBranch: ${i.branch_name}\nFile changed: ${i.file_path}`;
  }

  if (name === 'create_multi_file_pr') {
    const i = input as {
      title: string;
      body: string;
      branch_name: string;
      commit_message: string;
      files: Array<{ path: string; content: string }>;
    };
    if (!i.files || i.files.length === 0) return 'Error: files array is empty.';
    if (i.files.length > 20) return 'Error: too many files (max 20 per PR).';

    // 1. Get HEAD SHA
    const commits = await getRecentCommits(githubToken, targetRepo, 1);
    if (commits.length === 0) throw new Error('Could not resolve HEAD SHA');
    const headSha = commits[0].sha;

    // 2. Create branch from HEAD
    await createBranch(githubToken, targetRepo, i.branch_name, headSha);

    // 3. Get base tree SHA
    const baseTreeSha = await getBaseTreeSha(githubToken, targetRepo, headSha);

    // 4. Create blobs for each file
    const blobEntries: Array<{ path: string; blobSha: string }> = [];
    for (const file of i.files) {
      const blobSha = await createBlob(githubToken, targetRepo, file.content);
      blobEntries.push({ path: file.path, blobSha });
    }

    // 5. Create new tree
    const treeSha = await createTree(githubToken, targetRepo, baseTreeSha, blobEntries);

    // 6. Create commit
    const commitSha = await createGitCommit(githubToken, targetRepo, i.commit_message, treeSha, headSha);

    // 7. Update branch ref to point to new commit
    await updateRef(githubToken, targetRepo, `heads/${i.branch_name}`, commitSha);

    // 8. Open PR
    const { number, url } = await createPullRequest(githubToken, targetRepo, i.title, i.body, i.branch_name);

    const fileList = i.files.map(f => f.path).join(', ');
    return `Created PR #${number}: ${url}\nBranch: ${i.branch_name}\nFiles changed (${i.files.length}): ${fileList}`;
  }

  if (name === 'trigger_worker_deploy') {
    const i = input as { reason: string; pr_numbers?: number[]; repo?: string };
    let commitContext = '';
    try {
      const commits = await getRecentCommits(githubToken, targetRepo, 1);
      if (commits.length > 0) {
        commitContext = ` Latest commit: ${commits[0].sha.slice(0, 8)} ("${commits[0].message}")`;
      }
    } catch {
      // Non-fatal
    }
    const prContext = i.pr_numbers && i.pr_numbers.length > 0
      ? ` PRs: ${i.pr_numbers.map(n => `#${n}`).join(', ')}.`
      : '';
    const agendaItem = `[PROPOSED ACTION] Deploy ${targetRepo} — ${i.reason}`;
    const agendaCtx = `Triggered by AEGIS based on CI/CD observation.${prContext}${commitContext} Operator must approve and run: npx wrangler deploy (from web/).`;
    const agendaId = await addAgendaItem(db, agendaItem, agendaCtx, 'high');
    return `Deployment proposed for ${targetRepo}. Added to agenda as item #${agendaId} for operator approval.`;
  }

  return null;
}
