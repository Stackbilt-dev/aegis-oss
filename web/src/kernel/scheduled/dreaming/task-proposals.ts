// Phase 1b: Task Proposal Processing — routes dreaming-extracted task
// proposals into cc_tasks with governance checks.

import { checkTaskGovernanceLimits } from '../governance.js';
import { AUTO_SAFE_CATEGORIES, PROPOSED_CATEGORIES } from '../../../schema-enums.js';

const VALID_CATEGORIES = new Set([...AUTO_SAFE_CATEGORIES, ...PROPOSED_CATEGORIES]);

// Valid repos the taskrunner can resolve — must match aliases in taskrunner.sh
// Customize this set for your org's repos
const VALID_TASK_REPOS = new Set([
  'aegis',
  // Add your repo directory names here
]);

const MIN_PROMPT_LENGTH = 80;

export async function processTaskProposals(
  db: D1Database,
  proposedTasks?: Array<{ title: string; repo: string; prompt: string; category: string; rationale: string }>,
): Promise<number> {
  if (!proposedTasks || proposedTasks.length === 0) return 0;

  let tasksCreated = 0;
  for (const task of proposedTasks.slice(0, 3)) {
    if (!task.title || !task.repo || !task.prompt || !task.category) {
      console.warn(`[dreaming:tasks] Skipping task with missing fields: ${task.title ?? '(no title)'}`);
      continue;
    }

    const repoNormalized = task.repo.trim().toLowerCase();
    if (!VALID_TASK_REPOS.has(repoNormalized)) {
      console.warn(`[dreaming:tasks] Skipping task with unknown repo '${task.repo}': ${task.title}`);
      continue;
    }

    if (task.prompt.trim().length < MIN_PROMPT_LENGTH) {
      console.warn(`[dreaming:tasks] Skipping task with prompt too short (${task.prompt.length} chars): ${task.title}`);
      continue;
    }

    const category = task.category.toLowerCase().trim();

    if (category === 'deploy') {
      console.log(`[dreaming:tasks] Skipping deploy task: ${task.title}`);
      continue;
    }

    if (!VALID_CATEGORIES.has(category as any)) {
      console.warn(`[dreaming:tasks] Skipping task with invalid category '${category}': ${task.title}`);
      continue;
    }

    const authority = 'auto_safe';

    const governance = await checkTaskGovernanceLimits(db, { repo: task.repo.trim(), title: task.title.trim(), category: category as string });
    if (!governance.allowed) {
      console.log(`[dreaming:tasks] Governance blocked '${task.title}': ${governance.reason}`);
      continue;
    }

    const id = crypto.randomUUID();
    try {
      await db.prepare(`
        INSERT INTO cc_tasks (id, title, repo, prompt, completion_signal, status, priority, max_turns, created_by, authority, category)
        VALUES (?, ?, ?, ?, 'TASK_COMPLETE', 'pending', 50, 25, 'aegis', ?, ?)
      `).bind(id, task.title.trim(), task.repo.trim(), task.prompt.trim(), authority, category).run();

      tasksCreated++;
      console.log(`[dreaming:tasks] Created ${authority} task: ${task.title} (${category}, ${task.repo}) → ${id}`);
    } catch (err) {
      console.warn(`[dreaming:tasks] Failed to insert task '${task.title}':`, err instanceof Error ? err.message : String(err));
    }
  }

  if (tasksCreated > 0) {
    console.log(`[dreaming:tasks] Proposed ${tasksCreated} task(s) from dreaming cycle`);
  }
  return tasksCreated;
}
