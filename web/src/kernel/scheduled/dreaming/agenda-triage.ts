// Phase 2: Agenda Triage — classify agenda items as WORK (→ GitHub issue)
// or KEEP (stays on operator scratchpad).

import type { EdgeEnv } from '../../dispatch.js';
import { getActiveAgendaItems, resolveAgendaItem } from '../../memory/agenda.js';
import { createIssue, resolveRepoName } from '../../../github.js';
import { ensureOnBoard } from '../../board.js';
import { askWorkersAiOrGroq, parseJsonResponse } from './llm.js';

const AGENDA_TRIAGE_SYSTEM = `You classify agenda items as either WORK (should be a GitHub issue) or KEEP (belongs on the operator scratchpad).

WORK items are: features to build, bugs to fix, research to do, refactors, documentation to write, code changes, design tasks, prototypes, integrations.

KEEP items are: time-sensitive deadlines, waiting-on-external blockers, proposed actions needing human approval, compliance alerts, quick operator reminders, items that need the operator's hands (not code).

For each item, return:
- "verdict": "work" or "keep"
- "repo": target GitHub repo (only if work) — use "aegis" as default, or infer from context
- "labels": array of GitHub labels (only if work) — pick from: bug, enhancement, documentation, test, research, refactor
- "title": cleaned issue title (only if work) — strip prefixes like [PROPOSED ACTION], make concise
- "body": issue body with context (only if work)

Return ONLY valid JSON (no markdown):
{
  "triage": [
    { "id": 123, "verdict": "keep" },
    { "id": 456, "verdict": "work", "repo": "aegis", "labels": ["enhancement"], "title": "Add foo feature", "body": "Description..." }
  ]
}`;

interface TriageResult {
  triage?: Array<{
    id: number;
    verdict: 'work' | 'keep';
    repo?: string;
    labels?: string[];
    title?: string;
    body?: string;
  }>;
}

export async function triageAgendaToIssues(env: EdgeEnv): Promise<number> {
  if (!env.githubToken || !env.groqApiKey) return 0;

  const items = await getActiveAgendaItems(env.db);
  if (items.length <= 5) return 0;

  const now = Date.now();
  const SETTLING_MS = 48 * 60 * 60 * 1000;
  const candidates = items.filter(i => {
    if (i.item.startsWith('[PROPOSED ACTION]') || i.item.startsWith('[PROPOSED TASK]')) return false;
    if (i.context?.includes('Auto-detected by heartbeat')) return false;
    const createdMs = new Date(i.created_at.endsWith('Z') ? i.created_at : i.created_at + 'Z').getTime();
    if (now - createdMs < SETTLING_MS) return false;
    return true;
  });

  if (candidates.length === 0) return 0;

  const itemList = candidates.map(i =>
    `ID ${i.id} [${i.priority}]: ${i.item}${i.context ? ` — Context: ${i.context}` : ''}`,
  ).join('\n');

  let rawResponse: string;
  try {
    rawResponse = await askWorkersAiOrGroq(env, AGENDA_TRIAGE_SYSTEM, itemList, true);
  } catch (err) {
    console.warn('[dreaming:triage] LLM call failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }

  if (!rawResponse) return 0;

  const result = parseJsonResponse<TriageResult>(rawResponse);
  if (!result) {
    console.warn('[dreaming:triage] Failed to parse response');
    return 0;
  }

  let promoted = 0;
  for (const item of result.triage ?? []) {
    if (item.verdict !== 'work' || !item.title || !item.repo) continue;
    if (promoted >= 3) break;

    const resolvedRepo = resolveRepoName(item.repo);
    const labels = [...(item.labels ?? ['enhancement']), 'aegis'];

    try {
      const { number, url } = await createIssue(
        env.githubToken, resolvedRepo,
        item.title,
        `${item.body ?? ''}\n\n---\n_Promoted from AEGIS agenda item #${item.id} by dreaming triage._`,
        labels,
      );
      await resolveAgendaItem(env.db, item.id, 'done');

      const projectIdRow = await env.db.prepare(
        "SELECT received_at FROM web_events WHERE event_id = 'board_project_id'"
      ).first<{ received_at: string }>();
      if (projectIdRow?.received_at) {
        await ensureOnBoard(env.db, env.githubToken, projectIdRow.received_at, resolvedRepo, number, item.title, 'backlog').catch(() => {});
      }

      promoted++;
      console.log(`[dreaming:triage] Promoted agenda #${item.id} → ${resolvedRepo}#${number}: ${url}`);
    } catch (err) {
      console.warn(`[dreaming:triage] Failed to create issue for agenda #${item.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  if (promoted > 0) {
    console.log(`[dreaming:triage] Promoted ${promoted} agenda item(s) to GitHub issues`);
  }
  return promoted;
}
