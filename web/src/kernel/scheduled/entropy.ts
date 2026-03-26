// Entropy Detection — ghost tasks, stale agenda, dormant goals
// Inspired by command_desk. Runs in heartbeat phase (hourly).
// Writes findings to digest_sections for the morning co-founder brief.

import { type EdgeEnv } from '../dispatch.js';

const AGENDA_STALE_DAYS = 7;    // Active agenda items untouched >7d
const TASK_STALE_DAYS = 7;      // Pending cc_tasks untouched >7d
const GOAL_DORMANT_DAYS = 14;   // Active goals with no runs in >14d

export interface EntropyReport {
  score: number;                 // 0-100 — percentage of active items that are stale
  ghostAgendaItems: Array<{ id: number; item: string; daysSinceCreated: number }>;
  ghostTasks: Array<{ id: string; title: string; repo: string; daysSinceCreated: number }>;
  dormantGoals: Array<{ id: string; title: string; daysSinceLastRun: number }>;
  summary: string;
}

export async function runEntropyDetection(env: EdgeEnv): Promise<void> {
  // Time gate: run every 6 hours (00, 06, 12, 18 UTC)
  const hour = new Date().getUTCHours();
  if (hour % 6 !== 0) return;

  const report = await detectEntropy(env);

  // Only write to digest if there's something worth reporting
  if (report.ghostAgendaItems.length === 0 && report.ghostTasks.length === 0 && report.dormantGoals.length === 0) {
    console.log(`[entropy] Clean — score ${report.score}, no stale items`);
    return;
  }

  // Queue as service alert so the digest picks it up without template changes.
  // severity scales with score: >50% = high, >25% = medium, else low
  const severity = report.score > 50 ? 'high' : report.score > 25 ? 'medium' : 'low';

  const details: string[] = [];
  for (const a of report.ghostAgendaItems.slice(0, 5)) {
    details.push(`agenda #${a.id}: "${a.item}" (${a.daysSinceCreated}d)`);
  }
  for (const t of report.ghostTasks.slice(0, 5)) {
    details.push(`task ${t.id.slice(0, 8)}: "${t.title}" in ${t.repo} (${t.daysSinceCreated}d)`);
  }
  for (const g of report.dormantGoals.slice(0, 5)) {
    details.push(`goal "${g.title}" (${g.daysSinceLastRun}d since last run)`);
  }

  await env.db.prepare(`
    INSERT INTO digest_sections (id, section, payload, consumed, created_at)
    VALUES (?, 'entropy', ?, 0, datetime('now'))
  `).bind(
    `entropy-${Date.now()}`,
    JSON.stringify({
      source: 'entropy',
      severity,
      summary: report.summary,
      detail: details.join(' · '),
      findings: details,
      score: report.score,
    }),
  ).run();

  console.log(`[entropy] Score ${report.score} — ${report.ghostAgendaItems.length} ghost agenda, ${report.ghostTasks.length} ghost tasks, ${report.dormantGoals.length} dormant goals`);
}

export async function detectEntropy(env: EdgeEnv): Promise<EntropyReport> {
  const now = Date.now();

  // 1. Ghost agenda items — active but created >7d ago with no resolution
  const agendaRows = await env.db.prepare(`
    SELECT id, item, created_at
    FROM agent_agenda
    WHERE status = 'active'
      AND created_at < datetime('now', '-${AGENDA_STALE_DAYS} days')
    ORDER BY created_at ASC
  `).all<{ id: number; item: string; created_at: string }>();

  const ghostAgendaItems = agendaRows.results.map(r => ({
    id: r.id,
    item: r.item.slice(0, 100),
    daysSinceCreated: Math.floor((now - new Date(r.created_at + 'Z').getTime()) / (1000 * 60 * 60 * 24)),
  }));

  // 2. Ghost cc_tasks — pending but created >7d ago, never started
  const taskRows = await env.db.prepare(`
    SELECT id, title, repo, created_at
    FROM cc_tasks
    WHERE status = 'pending'
      AND created_at < datetime('now', '-${TASK_STALE_DAYS} days')
    ORDER BY created_at ASC
  `).all<{ id: string; title: string; repo: string; created_at: string }>();

  const ghostTasks = taskRows.results.map(r => ({
    id: r.id,
    title: r.title.slice(0, 100),
    repo: r.repo,
    daysSinceCreated: Math.floor((now - new Date(r.created_at + 'Z').getTime()) / (1000 * 60 * 60 * 24)),
  }));

  // 3. Dormant goals — active but no run in >14d
  const goalRows = await env.db.prepare(`
    SELECT id, title, last_run_at
    FROM agent_goals
    WHERE status = 'active'
      AND (last_run_at IS NULL OR last_run_at < datetime('now', '-${GOAL_DORMANT_DAYS} days'))
  `).all<{ id: string; title: string; last_run_at: string | null }>();

  const dormantGoals = goalRows.results.map(r => ({
    id: r.id,
    title: r.title.slice(0, 100),
    daysSinceLastRun: r.last_run_at
      ? Math.floor((now - new Date(r.last_run_at + 'Z').getTime()) / (1000 * 60 * 60 * 24))
      : 999,
  }));

  // 4. Entropy score — percentage of active items that are stale
  const totalActiveAgenda = await env.db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_agenda WHERE status = 'active'"
  ).first<{ cnt: number }>();

  const totalPendingTasks = await env.db.prepare(
    "SELECT COUNT(*) as cnt FROM cc_tasks WHERE status = 'pending'"
  ).first<{ cnt: number }>();

  const totalActiveGoals = await env.db.prepare(
    "SELECT COUNT(*) as cnt FROM agent_goals WHERE status = 'active'"
  ).first<{ cnt: number }>();

  const totalActive = (totalActiveAgenda?.cnt ?? 0) + (totalPendingTasks?.cnt ?? 0) + (totalActiveGoals?.cnt ?? 0);
  const totalStale = ghostAgendaItems.length + ghostTasks.length + dormantGoals.length;
  const score = totalActive > 0 ? Math.round((totalStale / totalActive) * 100) : 0;

  // 5. Build human summary
  const parts: string[] = [];
  if (ghostAgendaItems.length > 0) {
    parts.push(`${ghostAgendaItems.length} agenda item${ghostAgendaItems.length > 1 ? 's' : ''} stale >${AGENDA_STALE_DAYS}d`);
  }
  if (ghostTasks.length > 0) {
    parts.push(`${ghostTasks.length} queued task${ghostTasks.length > 1 ? 's' : ''} untouched >${TASK_STALE_DAYS}d`);
  }
  if (dormantGoals.length > 0) {
    parts.push(`${dormantGoals.length} goal${dormantGoals.length > 1 ? 's' : ''} dormant >${GOAL_DORMANT_DAYS}d`);
  }

  const summary = parts.length > 0
    ? `Entropy ${score}% — ${parts.join(', ')}.`
    : `Entropy ${score}% — all clear.`;

  return { score, ghostAgendaItems, ghostTasks, dormantGoals, summary };
}
