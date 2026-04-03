// ─── Agent Agenda ────────────────────────────────────────────
//
// Proposed Actions convention:
// An agenda item is a [PROPOSED ACTION] when AEGIS has identified a specific,
// executable action it can perform and is requesting approval before proceeding.
//
// Format:  item  = "[PROPOSED ACTION] <description>"
//          context = full reasoning — what it would do, why, expected outcome
//
// AEGIS should use this prefix when:
//   - It has identified a specific step it can execute in-session (not just a flag)
//   - The action has real consequences (filing, creating records, sending emails)
//   - It has enough context to act without further clarification
//
// Proposed actions surface before regular agenda items at session start,
// with an explicit numbered approval prompt. The operator responds "approve N",
// "reject N", or "defer N". Approved = AEGIS executes + resolves. Rejected =
// dismissed. Deferred = stays active for next session.

import type { AgendaPriority, AgendaStatus } from '../../schema-enums.js';

export interface AgendaItem {
  id: number;
  item: string;
  context: string | null;
  priority: AgendaPriority;
  status: AgendaStatus;
  created_at: string;
  resolved_at: string | null;
}

// ─── Heartbeat History (#6) ──────────────────────────────────

export interface HeartbeatResult {
  id: number;
  actionable: boolean;
  severity: string;
  summary: string;
  checks_json: string;
  created_at: string;
}

export async function getRecentHeartbeats(db: D1Database, limit = 5): Promise<HeartbeatResult[]> {
  const result = await db.prepare(
    'SELECT * FROM heartbeat_results ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all();
  return result.results as unknown as HeartbeatResult[];
}

export async function getActiveAgendaItems(db: D1Database): Promise<AgendaItem[]> {
  const result = await db.prepare(
    "SELECT * FROM agent_agenda WHERE status = 'active' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at ASC"
  ).all();
  return result.results as unknown as AgendaItem[];
}

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function extractAgendaKeyPhrase(text: string): string {
  return text
    .replace(/^\[PROPOSED ACTION\]\s*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function addAgendaItem(
  db: D1Database,
  item: string,
  context: string | undefined,
  priority: AgendaPriority,
): Promise<number> {
  // Dedup: check for existing active OR recently resolved items with similar text (#72)
  // Include items resolved within 7 days to prevent zombie re-creation loops
  // where a compliance item is re-flagged before the upstream source is updated.
  const keyPhrase = extractAgendaKeyPhrase(item);
  const words = keyPhrase.split(' ').filter(w => w.length > 3);
  if (words.length > 0) {
    const candidates = await db.prepare(
      "SELECT id, item, priority, status FROM agent_agenda WHERE status = 'active' OR (status IN ('done', 'dismissed') AND resolved_at >= datetime('now', '-7 days'))"
    ).all<{ id: number; item: string; priority: string; status: string }>();

    for (const existing of candidates.results) {
      const existingKey = extractAgendaKeyPhrase(existing.item);
      // Match if >50% of significant words overlap
      const matches = words.filter(w => existingKey.includes(w)).length;
      if (matches / words.length > 0.5) {
        if (existing.status !== 'active') {
          // Recently resolved — suppress re-creation entirely
          return existing.id;
        }
        // Upgrade priority if new is higher
        if ((PRIORITY_RANK[priority] ?? 0) > (PRIORITY_RANK[existing.priority] ?? 0)) {
          await db.prepare(
            'UPDATE agent_agenda SET priority = ? WHERE id = ?'
          ).bind(priority, existing.id).run();
        }
        return existing.id;
      }
    }
  }

  const result = await db.prepare(
    'INSERT INTO agent_agenda (item, context, priority) VALUES (?, ?, ?)'
  ).bind(item, context ?? null, priority).run();
  return result.meta.last_row_id as number;
}

export async function resolveAgendaItem(
  db: D1Database,
  id: number,
  status: 'done' | 'dismissed',
): Promise<void> {
  await db.prepare(
    "UPDATE agent_agenda SET status = ?, resolved_at = datetime('now') WHERE id = ?"
  ).bind(status, id).run();
}

export const PROPOSED_ACTION_PREFIX = '[PROPOSED ACTION]';
export const PROPOSED_TASK_PREFIX = '[PROPOSED TASK]';

export async function createProposedTaskAgendaItem(
  db: D1Database,
  taskId: string,
  title: string,
  repo: string,
  category: string,
  rationale: string,
): Promise<number> {
  const summary = `${PROPOSED_TASK_PREFIX} ${title} (${repo}) — ${category}`;
  const context = JSON.stringify({ task_id: taskId, repo, category, rationale });
  return addAgendaItem(db, summary, context, 'medium');
}

export async function getAgendaContext(db: D1Database): Promise<string> {
  const items = await getActiveAgendaItems(db);
  if (items.length === 0) return '';

  const proposed = items.filter(i => i.item.startsWith(PROPOSED_ACTION_PREFIX));
  const regular  = items.filter(i => !i.item.startsWith(PROPOSED_ACTION_PREFIX));

  let ctx = '';

  if (proposed.length > 0) {
    ctx += `\n## Pending Proposed Actions\n`;
    ctx += `I have ${proposed.length} proposed action${proposed.length !== 1 ? 's' : ''} awaiting approval:\n\n`;
    proposed.forEach((item, idx) => {
      const description = item.item.slice(PROPOSED_ACTION_PREFIX.length).trim();
      ctx += `${idx + 1}. **[PROPOSED ACTION #${item.id}]** ${description}\n`;
      if (item.context) ctx += `   Reasoning: ${item.context}\n`;
    });
    ctx += `\nRespond "approve N", "reject N", or "defer N" for each — or "approve all".\n`;
  }

  if (regular.length > 0) {
    const lines = regular.map(i =>
      `- [${i.priority.toUpperCase()} #${i.id}] ${i.item}${i.context ? ` — ${i.context}` : ''}`
    );
    ctx += `\n## Active Agenda\n${lines.join('\n')}\n`;
  }

  return ctx;
}

// ─── Heartbeat Context ───────────────────────────────────────

function formatAge(createdAt: string): string {
  const ts = createdAt.endsWith('Z') ? createdAt : createdAt + 'Z';
  const diffMs = Date.now() - new Date(ts).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function getRecentHeartbeatContext(db: D1Database): Promise<string> {
  const result = await db.prepare(
    'SELECT severity, summary, actionable, created_at FROM heartbeat_results ORDER BY created_at DESC LIMIT 2'
  ).all();
  const rows = result.results as unknown as { severity: string; summary: string; actionable: number; created_at: string }[];
  if (rows.length === 0) return '';
  const lines = rows.map(r =>
    `- [${r.severity.toUpperCase()}${r.actionable ? ' ⚡' : ''}] ${r.summary} (${formatAge(r.created_at)})`
  );
  return `\n## Recent Heartbeat Status\n${lines.join('\n')}\n`;
}
