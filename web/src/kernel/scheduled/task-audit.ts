// Task Audit Chain -- tamper-evident execution trail using hash chains.
// D1-only mode (no R2). Hash chain provides tamper evidence; D1 stores full records.

import { computeHash } from '../../lib/audit-chain/chain.js';
import { GENESIS_HASH } from '../../lib/audit-chain/types.js';

const NAMESPACE = 'task-runner';

/** Read the latest chain head from D1, or GENESIS_HASH if empty. */
export async function getChainHead(db: D1Database): Promise<string> {
  const row = await db.prepare(
    'SELECT hash FROM task_audit_chain WHERE namespace = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(NAMESPACE).first<{ hash: string }>();
  return row?.hash ?? GENESIS_HASH;
}

/** Write a hash-linked audit record for a task execution. Returns new chain head. */
export async function writeTaskAuditRecord(
  db: D1Database,
  opts: {
    taskName: string;
    status: 'ok' | 'error' | 'skipped';
    durationMs: number;
    errorMessage?: string;
    chainHead: string;
  },
): Promise<string> {
  const recordId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // Build record data (without hash -- computed from this + prev_hash)
  const recordData = {
    record_id: recordId,
    namespace: NAMESPACE,
    event_type: `task.${opts.status}`,
    prev_hash: opts.chainHead,
    actor: 'aegis-scheduler',
    timestamp,
    payload: {
      task_name: opts.taskName,
      status: opts.status,
      duration_ms: opts.durationMs,
      ...(opts.errorMessage ? { error: opts.errorMessage } : {}),
    },
  };

  const encoder = new TextEncoder();
  const recordBytes = encoder.encode(JSON.stringify(recordData));
  const hash = await computeHash(opts.chainHead, recordBytes);

  await db.prepare(`
    INSERT INTO task_audit_chain (record_id, namespace, event_type, hash, prev_hash, actor, timestamp, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    recordId, NAMESPACE, `task.${opts.status}`, hash, opts.chainHead,
    'aegis-scheduler', timestamp, JSON.stringify(recordData.payload),
  ).run();

  return hash;
}
