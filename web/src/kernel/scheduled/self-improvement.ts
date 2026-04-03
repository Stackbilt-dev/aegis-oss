// Stub — full implementation not yet extracted to OSS
// proposeToolsFromPatterns is live (v1.56.0)

import { type EdgeEnv } from '../dispatch.js';
import { createDynamicTool, listDynamicTools, invalidateToolCache } from '../dynamic-tools.js';

export const DEFAULT_WATCH_REPOS = [
  'aegis',
  'demo_app_v2',
  'charter',
  'img-forge',
  'example-auth',
  'bizops-copilot',
];

export function getWatchRepos(githubRepo: string): string[] {
  const org = githubRepo.split('/')[0];
  return DEFAULT_WATCH_REPOS.map(repo => `${org}/${repo}`);
}

export async function runSelfImprovementAnalysis(_env: EdgeEnv): Promise<void> {
  // Stub — full implementation provided by consuming app via ScheduledTaskPlugin
}

export async function runSelfImprovementHousekeeping(env: EdgeEnv): Promise<void> {
  // Recurring prompt patterns → dynamic tool proposals
  try {
    await proposeToolsFromPatterns(env);
  } catch {
    // Non-fatal — table may not exist yet
  }
}

export async function runInfraComplianceCheck(_env: EdgeEnv): Promise<void> {
  // Stub — full implementation provided by consuming app via ScheduledTaskPlugin
}

// ─── Dynamic Tool Auto-Proposal ─────────────────────────────
// Scans completed tasks for recurring prompt structures.
// If 3+ tasks share a common prompt prefix (first 100 chars),
// proposes a dynamic tool that parameterizes the varying parts.

const TOOL_PROPOSAL_MIN_CLUSTER = 3;
const TOOL_PROPOSAL_PREFIX_LEN = 100;

async function proposeToolsFromPatterns(env: EdgeEnv): Promise<void> {
  // Get recent successful tasks
  const tasks = await env.db.prepare(`
    SELECT title, prompt, category, repo FROM cc_tasks
    WHERE status = 'completed' AND completed_at > datetime('now', '-14 days')
    ORDER BY completed_at DESC LIMIT 50
  `).all<{ title: string; prompt: string; category: string; repo: string }>();

  if (tasks.results.length < TOOL_PROPOSAL_MIN_CLUSTER) return;

  // Cluster by prompt prefix (first N chars, normalized)
  const clusters = new Map<string, Array<{ title: string; prompt: string; category: string; repo: string }>>();
  for (const task of tasks.results) {
    const prefix = task.prompt.slice(0, TOOL_PROPOSAL_PREFIX_LEN).toLowerCase().replace(/\s+/g, ' ').trim();
    const existing = clusters.get(prefix) ?? [];
    existing.push(task);
    clusters.set(prefix, existing);
  }

  // Check existing dynamic tools to avoid duplicates
  const existingTools = await listDynamicTools(env.db, { limit: 100 });
  const existingNames = new Set(existingTools.map(t => t.name));

  let created = 0;
  for (const [prefix, group] of clusters) {
    if (group.length < TOOL_PROPOSAL_MIN_CLUSTER) continue;

    // Derive a tool name from the category and common words
    const category = group[0].category;
    const words = prefix.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    const toolName = `auto_${category}_${words.join('_')}`.replace(/[^a-z0-9_]/g, '').slice(0, 49);

    if (existingNames.has(toolName) || toolName.length < 8) continue;

    // Build a template from the common prefix + a {{details}} variable for the varying part
    const commonPrefix = group[0].prompt.slice(0, TOOL_PROPOSAL_PREFIX_LEN);
    const template = `${commonPrefix}\n\nSpecific details: {{details}}\n\nTarget repo: {{repo}}`;

    try {
      await createDynamicTool(env.db, {
        name: toolName,
        description: `Auto-proposed: ${group.length} similar ${category} tasks detected (e.g. "${group[0].title.slice(0, 60)}")`,
        input_schema: JSON.stringify({
          type: 'object',
          properties: {
            details: { type: 'string', description: 'Specific details for this task' },
            repo: { type: 'string', description: 'Target repository' },
          },
          required: ['details'],
        }),
        prompt_template: template,
        executor: 'workers_ai',
        created_by: 'self_improvement',
        status: 'draft',
        ttl_days: 14,
      });
      created++;
      existingNames.add(toolName);
      console.log(`[self-improvement] Proposed dynamic tool: ${toolName} (${group.length} similar tasks)`);
    } catch {
      // Duplicate name or other constraint — skip
    }
  }

  if (created > 0) {
    invalidateToolCache();
    console.log(`[self-improvement] Proposed ${created} dynamic tool(s) from recurring task patterns`);
  }
}
