import { Hono } from 'hono';
import type { Env } from './types.js';

export const codebeast = new Hono<{ Bindings: Env }>();

type FindingSeverity = 'HIGH' | 'MID' | 'LOW' | 'INFO';
type FindingCategory = 'SECURITY' | 'LOGIC' | 'STYLE' | 'DEPENDENCY' | 'BOUNDARY';

interface Finding {
  finding_id?: string;
  repo?: string;
  file_path?: string;
  line_start?: number;
  line_end?: number;
  severity?: FindingSeverity;
  category?: FindingCategory;
  title?: string;
  description?: string;
  commit_sha?: string;
  branch?: string;
  detected_at?: string;
}

interface FixStatus {
  fix_id?: string;
  finding_id?: string;
  repo?: string;
  status?: 'COMPLETED' | 'FAILED';
  outcome_summary?: string;
  completed_at?: string;
}

function derivePriority(severity: FindingSeverity): 'high' | 'medium' | 'low' {
  if (severity === 'HIGH') return 'high';
  if (severity === 'MID') return 'medium';
  return 'low';
}

async function queueDigestNotification(db: D1Database, findings: Finding[]): Promise<void> {
  const alertable = findings.filter((finding) => finding.severity === 'HIGH' || finding.severity === 'MID');
  if (alertable.length === 0) return;

  const summary = alertable
    .map((finding) => `[${finding.severity}] ${finding.repo}: ${finding.title}`)
    .join('\n');

  // Best-effort only. Some OSS deployments may not enable digest persistence.
  await db.prepare(
    "INSERT INTO digest_sections (section, payload) VALUES ('codebeast_findings', ?)"
  ).bind(JSON.stringify({
    count: alertable.length,
    summary,
    timestamp: new Date().toISOString(),
  })).run().catch(() => {});
}

// ─── POST /api/v1/codebeast/bridge/findings ──────────────────

codebeast.post('/api/v1/codebeast/bridge/findings', async (c) => {
  let body: { findings?: Finding[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(body.findings) || body.findings.length === 0) {
    return c.json({ error: 'findings array is required and must be non-empty' }, 400);
  }

  const results: Array<{ finding_id: string; stored: boolean; error?: string }> = [];

  for (const finding of body.findings) {
    if (!finding.finding_id || !finding.repo || !finding.title || !finding.severity) {
      results.push({
        finding_id: finding.finding_id ?? 'unknown',
        stored: false,
        error: 'missing required fields',
      });
      continue;
    }

    try {
      await c.env.DB.prepare(`
        INSERT OR IGNORE INTO codebeast_findings
          (finding_id, repo, file_path, line_start, line_end, severity, category, title, description, commit_sha, branch, priority, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        finding.finding_id,
        finding.repo,
        finding.file_path ?? '',
        finding.line_start ?? 0,
        finding.line_end ?? 0,
        finding.severity,
        finding.category ?? 'LOGIC',
        finding.title,
        finding.description ?? '',
        finding.commit_sha ?? '',
        finding.branch ?? 'main',
        derivePriority(finding.severity),
        finding.detected_at ?? new Date().toISOString(),
      ).run();

      results.push({ finding_id: finding.finding_id, stored: true });
    } catch (err) {
      console.error(`[codebeast] Failed to store finding ${finding.finding_id}:`, err);
      results.push({ finding_id: finding.finding_id, stored: false, error: 'db write failed' });
    }
  }

  await queueDigestNotification(c.env.DB, body.findings);

  const stored = results.filter((result) => result.stored).length;
  console.log(`[codebeast] Bridge: ${stored}/${body.findings.length} findings stored`);

  return c.json({ received: body.findings.length, stored, results }, 201);
});

// ─── POST /api/v1/codebeast/bridge/fix-status ────────────────

codebeast.post('/api/v1/codebeast/bridge/fix-status', async (c) => {
  let body: FixStatus;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.finding_id || !body.status) {
    return c.json({ error: 'finding_id and status are required' }, 400);
  }

  const finding = await c.env.DB.prepare(
    'SELECT finding_id, title, severity, status FROM codebeast_findings WHERE finding_id = ?'
  ).bind(body.finding_id).first<{ finding_id: string; title: string; severity: string; status: string }>();

  if (!finding) {
    return c.json({ error: `Finding ${body.finding_id} not found` }, 404);
  }

  if (body.status === 'COMPLETED') {
    await c.env.DB.prepare(`
      UPDATE codebeast_findings
      SET status = 'resolved', fix_id = ?, outcome_summary = ?, resolved_at = ?
      WHERE finding_id = ?
    `).bind(
      body.fix_id ?? null,
      body.outcome_summary ?? '',
      body.completed_at ?? new Date().toISOString(),
      body.finding_id,
    ).run();

    console.log(`[codebeast] Finding ${body.finding_id} resolved: ${body.outcome_summary?.slice(0, 80)}`);
  } else {
    await c.env.DB.prepare(`
      UPDATE codebeast_findings
      SET fix_attempts = fix_attempts + 1, last_fix_error = ?, updated_at = datetime('now')
      WHERE finding_id = ?
    `).bind(
      body.outcome_summary ?? 'Fix failed (no details)',
      body.finding_id,
    ).run();

    console.log(`[codebeast] Fix failed for ${body.finding_id}: ${body.outcome_summary?.slice(0, 80)}`);
  }

  return c.json({ finding_id: body.finding_id, status: body.status, updated: true });
});

// ─── GET /api/v1/codebeast/findings ──────────────────────────

codebeast.get('/api/v1/codebeast/findings', async (c) => {
  const status = c.req.query('status');
  const severity = c.req.query('severity');
  const repo = c.req.query('repo');

  let sql = 'SELECT * FROM codebeast_findings WHERE 1=1';
  const bindings: string[] = [];

  if (status) {
    sql += ' AND status = ?';
    bindings.push(status);
  }
  if (severity) {
    sql += ' AND severity = ?';
    bindings.push(severity);
  }
  if (repo) {
    sql += ' AND repo = ?';
    bindings.push(repo);
  }

  sql += ' ORDER BY detected_at DESC LIMIT 100';

  const result = await c.env.DB.prepare(sql).bind(...bindings).all();
  return c.json({ findings: result.results, count: result.results.length });
});
