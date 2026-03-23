// Stub — full implementation not yet extracted to OSS

import { type EdgeEnv } from '../dispatch.js';
import { listIssues, commentOnIssue, type Issue } from '../../github.js';
import { operatorConfig, renderTemplate } from '../../operator/index.js';
import { checkTaskGovernanceLimits } from './governance.js';

const LABEL_TO_CATEGORY: Record<string, { category: string; authority: 'auto_safe' | 'proposed' }> = {
  bug:           { category: 'bugfix',   authority: 'auto_safe' },
  enhancement:   { category: 'feature',  authority: 'auto_safe' },
  documentation: { category: 'docs',     authority: 'auto_safe' },
  test:          { category: 'tests',    authority: 'auto_safe' },
  research:      { category: 'research', authority: 'auto_safe' },
  refactor:      { category: 'refactor', authority: 'auto_safe' },
};

function classifyIssue(labels: string[]): { category: string; authority: 'auto_safe' | 'proposed' } | null {
  for (const label of labels) {
    const mapping = LABEL_TO_CATEGORY[label.toLowerCase()];
    if (mapping) return mapping;
  }
  return null;
}

function buildIssueTaskPrompt(
  issue: { number: number; title: string; url: string; labels: string[]; body: string },
  resolvedRepo: string,
): string {
  return `# MISSION BRIEF — GitHub Issue #${issue.number}

## Issue
**Title**: ${issue.title}
**Repo**: ${resolvedRepo}
**URL**: ${issue.url}
**Labels**: ${issue.labels.join(', ')}

## Description
${issue.body}

## Instructions
Fix the issue described above. Follow existing patterns in the codebase.
- Read relevant files before making changes
- Run typecheck after changes
- Commit with a message referencing #${issue.number}
- If the issue is unclear or too large, output TASK_BLOCKED with an explanation

## Scope
- Only modify files in this repository
- Do not make unrelated improvements
- Do not modify CI/CD, deploy scripts, or secrets`;
}

export async function runIssueWatcher(env: {
  db: D1Database;
  githubToken: string;
  githubRepo: string;
  [key: string]: unknown;
}): Promise<void> {
  const { db, githubToken, githubRepo } = env;

  const issues = await listIssues(githubToken, githubRepo, 'open');

  for (const issue of issues) {
    // Dedup: skip if task already exists for this issue
    const existing = await db.prepare(
      'SELECT 1 FROM cc_tasks WHERE github_issue_number = ? AND github_issue_repo = ?'
    ).bind(issue.number, githubRepo).first();

    if (existing) continue;

    // Skip manually grabbed issues (assignee set)
    if (issue.assignee) continue;

    // Skip issues with in-progress label
    if (issue.labels.some(l => l.toLowerCase() === 'in-progress')) continue;

    // Body quality gate
    if (!issue.body || issue.body.trim().length < 20) continue;

    // Classify by labels
    const classification = classifyIssue(issue.labels);
    if (!classification) continue;

    // Governance check
    const governance = await checkTaskGovernanceLimits(db);
    if (!governance.allowed) continue;

    // Create task
    const id = crypto.randomUUID();
    const prompt = buildIssueTaskPrompt(issue, githubRepo);

    await db.prepare(
      `INSERT INTO cc_tasks (id, title, repo, prompt, category, authority, github_issue_repo, github_issue_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      id,
      issue.title,
      githubRepo,
      prompt,
      classification.category,
      classification.authority,
      githubRepo,
      issue.number,
    ).run();
  }
}
