import type { AgendaPriority, AgendaStatus, TaskStatus } from '../../schema-enums.js';
import { readPage } from '../../wiki/client.js';
import type { WikiClientEnv } from '../../wiki/client.js';

// ─── Result Types ───────────────────────────────────────────

export interface AgendaClaimResult {
  exists: boolean;
  item?: {
    id: number;
    item: string;
    context: string | null;
    priority: AgendaPriority;
    status: AgendaStatus;
    created_at: string;
    resolved_at: string | null;
    business_unit: string;
  };
}

export interface TaskClaimResult {
  exists: boolean;
  task?: {
    id: string;
    title: string;
    prompt: string;
    status: TaskStatus;
    created_at: string;
    completed_at: string | null;
  };
}

// ─── Helpers ────────────────────────────────────────────────

export async function verifyAgendaClaim(
  db: D1Database,
  id: number,
): Promise<AgendaClaimResult> {
  if (!Number.isInteger(id) || id < 1) return { exists: false };

  const row = await db
    .prepare(
      'SELECT id, item, context, priority, status, created_at, resolved_at, business_unit FROM agent_agenda WHERE id = ?',
    )
    .bind(id)
    .first<AgendaClaimResult['item']>();

  if (!row) return { exists: false };
  return { exists: true, item: row };
}

export async function verifyTaskClaim(
  db: D1Database,
  id: string,
): Promise<TaskClaimResult> {
  if (typeof id !== 'string' || id.length === 0) return { exists: false };

  const row = await db
    .prepare(
      'SELECT id, title, prompt, status, created_at, completed_at FROM cc_tasks WHERE id = ?',
    )
    .bind(id)
    .first<TaskClaimResult['task']>();

  if (!row) return { exists: false };
  return { exists: true, task: row };
}

// ─── Wiki existence check (aegis#500) ──────────────────────────
// Verifies that slug-shaped strings asserted as "canonical wiki pages" actually
// resolve. Returns { exists: false } on 404. Other errors propagate so the
// caller can decide (the detector wraps in try/catch + treats verification
// failure as non-fatal, matching v1 posture).

export interface WikiPageClaimResult {
  exists: boolean;
}

export async function verifyWikiPageClaim(
  env: WikiClientEnv,
  slug: string,
): Promise<WikiPageClaimResult> {
  if (typeof slug !== 'string' || slug.length === 0) return { exists: false };
  const result = await readPage(env, slug);
  return { exists: result.page !== null };
}
