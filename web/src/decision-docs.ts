// Decision Documentation Renderer (#62)
//
// Traces the full decision chain for a topic across 7 data sources:
// semantic memory, episodic memory, procedural memory, goals/actions,
// narratives, cc_tasks, and GitHub issues/PRs.
//
// Pure data assembly — no LLM synthesis, no hallucinated decisions.

import type { EdgeEnv } from './kernel/dispatch.js';
import type { MemoryFragmentResult } from './types.js';
import { listIssues, listPullRequests, resolveRepoName } from './github.js';

interface TimelineEvent {
  date: string;
  source: string;
  summary: string;
}

interface DecisionDocOptions {
  days?: number;       // lookback window (default: 90)
  includeRaw?: boolean; // include raw evidence section (default: false)
  repo?: string;       // GitHub repo to search (default: aegis)
}

export async function generateDecisionDoc(
  topic: string,
  env: EdgeEnv,
  options: DecisionDocOptions = {},
): Promise<string> {
  const days = options.days ?? 90;
  const includeRaw = options.includeRaw ?? false;
  const repo = resolveRepoName(options.repo ?? 'aegis');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const keywords = topic.toLowerCase().split(/[\s_-]+/).filter(w => w.length > 2);
  const likePattern = `%${topic.replace(/[\s_-]+/g, '%')}%`;

  // ─── Parallel queries across all sources ─────────────────────
  const [
    memoryFacts,
    episodes,
    procedures,
    narratives,
    goals,
    actions,
    tasks,
    issues,
    prs,
  ] = await Promise.all([
    // 1. Semantic memory (Memory Worker hybrid recall)
    env.memoryBinding
      ? env.memoryBinding.recall('aegis', { keywords: topic, limit: 20, min_confidence: 0.5 })
          .catch(() => [] as MemoryFragmentResult[])
      : Promise.resolve([] as MemoryFragmentResult[]),

    // 2. Episodic memory — keyword match in summary
    env.db.prepare(
      `SELECT intent_class, summary, outcome, cost, executor, created_at
       FROM episodic_memory
       WHERE summary LIKE ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 30`
    ).bind(likePattern, since).all<{
      intent_class: string; summary: string; outcome: string;
      cost: number; executor: string; created_at: string;
    }>().then(r => r.results).catch(() => []),

    // 3. Procedural memory — pattern match
    env.db.prepare(
      `SELECT task_pattern, executor, success_count, fail_count, avg_latency_ms, avg_cost, status, refinements, last_used
       FROM procedural_memory
       WHERE task_pattern LIKE ?
       ORDER BY last_used DESC LIMIT 10`
    ).bind(likePattern).all<{
      task_pattern: string; executor: string; success_count: number;
      fail_count: number; avg_latency_ms: number; avg_cost: number;
      status: string; refinements: string; last_used: string;
    }>().then(r => r.results).catch(() => []),

    // 4. Narratives — topic in title, summary, or related_topics
    env.db.prepare(
      `SELECT title, summary, status, tension, last_beat, beat_count, related_topics, created_at, resolved_at
       FROM narratives
       WHERE title LIKE ? OR summary LIKE ? OR related_topics LIKE ?
       ORDER BY created_at DESC LIMIT 10`
    ).bind(likePattern, likePattern, likePattern).all<{
      title: string; summary: string; status: string; tension: string | null;
      last_beat: string | null; beat_count: number; related_topics: string;
      created_at: string; resolved_at: string | null;
    }>().then(r => r.results).catch(() => []),

    // 5. Goals
    env.db.prepare(
      `SELECT id, title, description, status, run_count, created_at, completed_at
       FROM agent_goals
       WHERE title LIKE ? OR description LIKE ?
       ORDER BY created_at DESC LIMIT 10`
    ).bind(likePattern, likePattern).all<{
      id: string; title: string; description: string | null;
      status: string; run_count: number; created_at: string; completed_at: string | null;
    }>().then(r => r.results).catch(() => []),

    // 6. Goal actions (from matched goals — we'll filter post-query)
    env.db.prepare(
      `SELECT a.description, a.action_type, a.outcome, a.tool_called, a.created_at, g.title as goal_title
       FROM agent_actions a
       LEFT JOIN agent_goals g ON a.goal_id = g.id
       WHERE a.description LIKE ? OR g.title LIKE ?
       ORDER BY a.created_at DESC LIMIT 20`
    ).bind(likePattern, likePattern).all<{
      description: string; action_type: string; outcome: string | null;
      tool_called: string | null; created_at: string; goal_title: string | null;
    }>().then(r => r.results).catch(() => []),

    // 7. CC Tasks
    env.db.prepare(
      `SELECT title, repo, status, category, branch, pr_url, result, created_at, completed_at
       FROM cc_tasks
       WHERE title LIKE ? OR prompt LIKE ?
       ORDER BY created_at DESC LIMIT 15`
    ).bind(likePattern, likePattern).all<{
      title: string; repo: string; status: string; category: string | null;
      branch: string | null; pr_url: string | null; result: string | null;
      created_at: string; completed_at: string | null;
    }>().then(r => r.results).catch(() => []),

    // 8. GitHub issues
    env.githubToken
      ? listIssues(env.githubToken, repo, 'all').then(
          issues => issues.filter(i =>
            keywords.some(k => i.title.toLowerCase().includes(k) || i.body?.toLowerCase().includes(k))
          ).slice(0, 15)
        ).catch(() => [])
      : Promise.resolve([]),

    // 9. GitHub PRs
    env.githubToken
      ? listPullRequests(env.githubToken, repo, 'all').then(
          prs => prs.filter(p =>
            keywords.some(k => p.title.toLowerCase().includes(k))
          ).slice(0, 15)
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  // ─── Build timeline ──────────────────────────────────────────
  const timeline: TimelineEvent[] = [];

  for (const m of memoryFacts) {
    timeline.push({ date: m.created_at, source: 'memory', summary: `[${m.topic}] ${m.content.slice(0, 120)}` });
  }
  for (const e of episodes) {
    timeline.push({ date: e.created_at, source: 'episode', summary: `${e.intent_class} via ${e.executor} → ${e.outcome}` });
  }
  for (const n of narratives) {
    timeline.push({ date: n.created_at, source: 'narrative', summary: `Arc: "${n.title}" (${n.status})` });
  }
  for (const g of goals) {
    timeline.push({ date: g.created_at, source: 'goal', summary: `Goal: "${g.title}" (${g.status}, ${g.run_count} runs)` });
  }
  for (const t of tasks) {
    timeline.push({ date: t.created_at, source: 'task', summary: `Task: "${t.title}" → ${t.status}${t.pr_url ? ` (${t.pr_url})` : ''}` });
  }
  for (const i of issues) {
    timeline.push({ date: i.created_at, source: 'issue', summary: `#${i.number}: ${i.title} (${i.state})` });
  }
  for (const p of prs) {
    timeline.push({ date: p.created_at, source: 'pr', summary: `PR #${p.number}: ${p.title} (${p.merged ? 'merged' : p.state})` });
  }

  timeline.sort((a, b) => a.date.localeCompare(b.date));

  // ─── Compute stats ──────────────────────────────────────────
  const episodeSuccesses = episodes.filter(e => e.outcome === 'success').length;
  const episodeTotal = episodes.length;
  const totalCost = episodes.reduce((sum, e) => sum + (e.cost || 0), 0);
  const tasksCompleted = tasks.filter(t => t.status === 'completed').length;
  const tasksFailed = tasks.filter(t => t.status === 'failed').length;
  const issuesClosed = issues.filter(i => i.state === 'closed').length;
  const prsMerged = prs.filter(p => p.merged).length;

  // ─── Render document ─────────────────────────────────────────
  const lines: string[] = [];

  lines.push(`# Decision Document: ${topic}`);
  lines.push(`Generated: ${new Date().toISOString().slice(0, 19)}Z | Lookback: ${days} days`);
  lines.push('');

  // Summary stats
  lines.push('## Summary');
  lines.push(`- **Memory facts**: ${memoryFacts.length}`);
  lines.push(`- **Episodes**: ${episodeTotal} (${episodeSuccesses} success, ${episodeTotal - episodeSuccesses} failure)`);
  if (totalCost > 0) lines.push(`- **Total cost**: $${totalCost.toFixed(4)}`);
  lines.push(`- **Tasks**: ${tasks.length} (${tasksCompleted} completed, ${tasksFailed} failed)`);
  lines.push(`- **GitHub**: ${issues.length} issues (${issuesClosed} closed), ${prs.length} PRs (${prsMerged} merged)`);
  lines.push(`- **Goals**: ${goals.length} | **Narratives**: ${narratives.length}`);
  lines.push('');

  // Timeline
  if (timeline.length > 0) {
    lines.push('## Timeline');
    for (const event of timeline) {
      const date = event.date.slice(0, 10);
      lines.push(`- **${date}** [${event.source}] ${event.summary}`);
    }
    lines.push('');
  }

  // Key decisions (from semantic memory — highest confidence facts)
  const keyFacts = [...memoryFacts].sort((a, b) => b.confidence - a.confidence).slice(0, 10);
  if (keyFacts.length > 0) {
    lines.push('## Key Facts');
    for (const f of keyFacts) {
      const lifecycle = (f as unknown as Record<string, unknown>).lifecycle ?? '';
      lines.push(`- [${f.topic}] ${f.content.slice(0, 200)} *(confidence: ${f.confidence}, ${lifecycle})*`);
    }
    lines.push('');
  }

  // Procedural evolution
  if (procedures.length > 0) {
    lines.push('## Procedural Memory');
    for (const p of procedures) {
      const total = p.success_count + p.fail_count;
      const rate = total > 0 ? Math.round((p.success_count / total) * 100) : 0;
      lines.push(`- **${p.task_pattern}**: ${p.executor} (${p.status}) — ${p.success_count}/${total} success (${rate}%), avg ${Math.round(p.avg_latency_ms)}ms, $${p.avg_cost.toFixed(4)}/call`);
      // Show refinements if any
      try {
        const refs = JSON.parse(p.refinements || '[]') as Array<{ what: string; why: string }>;
        for (const r of refs.slice(-3)) {
          lines.push(`  - Refinement: ${r.what} — ${r.why}`);
        }
      } catch { /* skip malformed refinements */ }
    }
    lines.push('');
  }

  // Narrative arcs
  if (narratives.length > 0) {
    lines.push('## Narrative Arcs');
    for (const n of narratives) {
      lines.push(`### ${n.title}`);
      lines.push(`Status: ${n.status} | Beats: ${n.beat_count}${n.tension ? ` | Tension: ${n.tension}` : ''}`);
      lines.push(n.summary);
      if (n.resolved_at) lines.push(`Resolved: ${n.resolved_at.slice(0, 10)}`);
      lines.push('');
    }
  }

  // Actions taken
  if (actions.length > 0) {
    lines.push('## Actions Taken');
    for (const a of actions) {
      const goalRef = a.goal_title ? ` (goal: ${a.goal_title})` : '';
      lines.push(`- [${a.created_at.slice(0, 10)}] ${a.action_type}: ${a.description.slice(0, 150)}${goalRef} → ${a.outcome ?? 'pending'}`);
    }
    lines.push('');
  }

  // GitHub activity
  if (issues.length > 0 || prs.length > 0) {
    lines.push('## GitHub Activity');
    for (const i of issues) {
      const labels = i.labels.length > 0 ? ` [${i.labels.join(', ')}]` : '';
      lines.push(`- Issue #${i.number}: ${i.title} (${i.state})${labels}`);
    }
    for (const p of prs) {
      lines.push(`- PR #${p.number}: ${p.title} (${p.merged ? 'merged' : p.state})`);
    }
    lines.push('');
  }

  // Raw evidence (optional)
  if (includeRaw && episodes.length > 0) {
    lines.push('## Raw Episodes');
    for (const e of episodes.slice(0, 20)) {
      lines.push(`- [${e.created_at}] ${e.intent_class}/${e.executor}: ${e.summary.slice(0, 200)} → ${e.outcome} ($${e.cost.toFixed(4)})`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by AEGIS Decision Documentation Renderer*');

  return lines.join('\n');
}
