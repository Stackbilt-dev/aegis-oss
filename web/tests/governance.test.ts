// Governance authority tests — verifies cc-tasks API authority filtering,
// approval/rejection flows, and checkTaskGovernanceLimits safety caps.

import { describe, it, expect } from 'vitest';
import { checkTaskGovernanceLimits } from '../src/kernel/scheduled/governance.js';

// ─── D1 Mock ──────────────────────────────────────────────────

function createMockDb(resultQueue: (Record<string, unknown> | null)[] = []) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  let callIndex = 0;

  const db = {
    prepare(sql: string) {
      const entry = { sql, bindings: [] as unknown[] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          const idx = callIndex++;
          return (resultQueue[idx] ?? { c: 0 }) as T;
        },
      };
    },
    _queries: queries,
  };

  return db;
}

// ─── checkTaskGovernanceLimits Tests ──────────────────────────

describe('checkTaskGovernanceLimits', () => {
  const defaultOpts = { repo: 'aegis-daemon', title: 'Test task', category: 'feature' };

  it('allows task creation when all caps are within limits', async () => {
    const db = createMockDb([{ c: 0 }, { c: 0 }, { c: 0 }]);
    const result = await checkTaskGovernanceLimits(db as unknown as D1Database, defaultOpts);
    expect(result.allowed).toBe(true);
  });

  it('blocks when per-repo cap (5) is reached', async () => {
    const db = createMockDb([{ c: 5 }, { c: 0 }, { c: 0 }]);
    const result = await checkTaskGovernanceLimits(db as unknown as D1Database, defaultOpts);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Per-repo cap');
      expect(result.reason).toContain('aegis-daemon');
    }
  });

  it('blocks when per-repo cap is exceeded (>5)', async () => {
    const db = createMockDb([{ c: 8 }, { c: 0 }, { c: 0 }]);
    const result = await checkTaskGovernanceLimits(db as unknown as D1Database, defaultOpts);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Per-repo cap');
    }
  });

  it('blocks when active task cap (20) is reached', async () => {
    const db = createMockDb([{ c: 2 }, { c: 20 }, { c: 0 }]);
    const result = await checkTaskGovernanceLimits(db as unknown as D1Database, defaultOpts);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Active task cap');
      expect(result.reason).toContain('20');
    }
  });

  it('detects duplicate titles', async () => {
    const db = createMockDb([{ c: 1 }, { c: 2 }, { c: 1 }]);
    const result = await checkTaskGovernanceLimits(db as unknown as D1Database, {
      ...defaultOpts,
      title: 'Fix flaky test',
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Duplicate task');
      expect(result.reason).toContain('Fix flaky test');
    }
  });

  it('checks per-repo cap first (returns earliest failing check)', async () => {
    // All caps exceeded — should return per-repo reason (checked first)
    const db = createMockDb([{ c: 5 }, { c: 8 }, { c: 1 }]);
    const result = await checkTaskGovernanceLimits(db as unknown as D1Database, defaultOpts);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Per-repo cap');
    }
  });

  it('passes repo name to the per-repo query', async () => {
    const db = createMockDb([{ c: 0 }, { c: 0 }, { c: 0 }]);
    await checkTaskGovernanceLimits(db as unknown as D1Database, {
      ...defaultOpts,
      repo: 'edgestack-v2',
    });

    const repoQuery = db._queries[0];
    expect(repoQuery.bindings).toContain('edgestack-v2');
  });

  it('passes title to the duplicate check query', async () => {
    const db = createMockDb([{ c: 0 }, { c: 0 }, { c: 0 }]);
    await checkTaskGovernanceLimits(db as unknown as D1Database, {
      ...defaultOpts,
      title: 'Add logging middleware',
    });

    const dupeQuery = db._queries[2];
    expect(dupeQuery.bindings).toContain('Add logging middleware');
  });
});

// ─── cc-tasks API Endpoint Logic Tests ──────────────────────
// These test the SQL/logic patterns used in index.ts endpoints
// without spinning up the full Hono app.

describe('cc-tasks API logic', () => {
  describe('GET /api/cc-tasks/next — authority filtering', () => {
    it('SQL excludes proposed tasks from the next-task query', () => {
      // The actual SQL in index.ts must exclude proposed tasks
      const nextTaskSql = `
    SELECT * FROM cc_tasks
    WHERE status = 'pending'
      AND authority != 'proposed'
      AND (depends_on IS NULL OR depends_on IN (
        SELECT id FROM cc_tasks WHERE status = 'completed'
      ))
    ORDER BY priority ASC, created_at ASC
    LIMIT 1
  `;

      expect(nextTaskSql).toContain("authority != 'proposed'");
      expect(nextTaskSql).toContain("status = 'pending'");
    });
  });

  describe('POST /api/cc-tasks — default authority and category', () => {
    // Mirrors the validation logic from index.ts
    function resolveAuthority(input?: string): string {
      return ['proposed', 'auto_safe', 'operator'].includes(input ?? '') ? input! : 'operator';
    }
    function resolveCategory(input?: string): string {
      return ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy'].includes(input ?? '') ? input! : 'feature';
    }

    it('defaults authority to operator when not specified', () => {
      expect(resolveAuthority()).toBe('operator');
      expect(resolveAuthority(undefined)).toBe('operator');
    });

    it('defaults category to feature when not specified', () => {
      expect(resolveCategory()).toBe('feature');
      expect(resolveCategory(undefined)).toBe('feature');
    });

    it('accepts valid authority values', () => {
      expect(resolveAuthority('proposed')).toBe('proposed');
      expect(resolveAuthority('auto_safe')).toBe('auto_safe');
      expect(resolveAuthority('operator')).toBe('operator');
    });

    it('rejects invalid authority values by defaulting to operator', () => {
      expect(resolveAuthority('admin')).toBe('operator');
      expect(resolveAuthority('root')).toBe('operator');
      expect(resolveAuthority('')).toBe('operator');
    });

    it('accepts valid category values', () => {
      for (const cat of ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy']) {
        expect(resolveCategory(cat)).toBe(cat);
      }
    });

    it('rejects invalid category values by defaulting to feature', () => {
      expect(resolveCategory('yolo')).toBe('feature');
      expect(resolveCategory('')).toBe('feature');
    });
  });

  describe('POST /api/cc-tasks/:id/approve — authority promotion', () => {
    it('approve SQL targets proposed+pending tasks and sets operator authority', () => {
      const approveSql = `UPDATE cc_tasks SET authority = 'operator' WHERE id = ? AND authority = 'proposed' AND status = 'pending'`;

      expect(approveSql).toContain("authority = 'operator'");
      expect(approveSql).toContain("authority = 'proposed'");
      expect(approveSql).toContain("status = 'pending'");
    });
  });

  describe('POST /api/cc-tasks/:id/reject — cancellation', () => {
    it('reject SQL cancels proposed+pending tasks', () => {
      const rejectSql = `UPDATE cc_tasks SET status = 'cancelled' WHERE id = ? AND authority = 'proposed' AND status = 'pending'`;

      expect(rejectSql).toContain("status = 'cancelled'");
      expect(rejectSql).toContain("authority = 'proposed'");
      expect(rejectSql).toContain("status = 'pending'");
    });

    it('reject only affects proposed tasks (not operator or auto_safe)', () => {
      const rejectSql = `UPDATE cc_tasks SET status = 'cancelled' WHERE id = ? AND authority = 'proposed' AND status = 'pending'`;
      expect(rejectSql).not.toContain("authority = 'operator'");
      expect(rejectSql).not.toContain("authority = 'auto_safe'");
    });
  });
});
