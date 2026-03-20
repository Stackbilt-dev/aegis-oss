// Heartbeat tests — classifyCheckDeltas, syncChecksToAgenda, resolveAgendaForChecks
// Covers: delta classification logic, agenda sync, agenda auto-resolution

import { describe, it, expect } from 'vitest';
import {
  classifyCheckDeltas,
  syncChecksToAgenda,
  resolveAgendaForChecks,
  type CheckStatus,
  type HeartbeatCheck,
} from '../src/kernel/scheduled/heartbeat.js';

// ─── D1 Mock ──────────────────────────────────────────────────

interface MockQuery { sql: string; bindings: unknown[] }

function createMockDb(opts: {
  firstResults?: (Record<string, unknown> | null)[];
  runResults?: Record<string, unknown>[];
} = {}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let runIdx = 0;

  const db = {
    prepare(sql: string) {
      const entry: MockQuery = { sql, bindings: [] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          const idx = firstIdx++;
          return (opts.firstResults?.[idx] ?? null) as T;
        },
        async run() {
          const idx = runIdx++;
          return opts.runResults?.[idx] ?? { success: true };
        },
      };
    },
    _queries: queries,
  };

  return db;
}

// ─── classifyCheckDeltas Tests ───────────────────────────────

describe('classifyCheckDeltas', () => {
  it('classifies a new warn/alert check as emailable + agenda', () => {
    const current: HeartbeatCheck[] = [
      { name: 'compliance_gap', status: 'warn', detail: 'Missing document' },
    ];
    const priorMap = new Map<string, CheckStatus[]>();

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.emailableChecks).toHaveLength(1);
    expect(result.agendaChecks).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.emailableChecks[0].name).toBe('compliance_gap');
  });

  it('classifies ok→warn transition as new issue', () => {
    const current: HeartbeatCheck[] = [
      { name: 'cost_trend', status: 'warn', detail: 'Costs rising' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['cost_trend', ['ok']],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.emailableChecks).toHaveLength(1);
    expect(result.agendaChecks).toHaveLength(1);
  });

  it('classifies warn→alert escalation as emailable', () => {
    const current: HeartbeatCheck[] = [
      { name: 'revenue_drop', status: 'alert', detail: 'Revenue down 30%' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['revenue_drop', ['warn']],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.emailableChecks).toHaveLength(1);
    expect(result.agendaChecks).toHaveLength(1);
    expect(result.emailableChecks[0].status).toBe('alert');
  });

  it('suppresses persisting warn (no email, no agenda unless 12th run)', () => {
    const current: HeartbeatCheck[] = [
      { name: 'stale_check', status: 'warn', detail: 'Still stale' },
    ];
    // 5 prior warn statuses — not at the 12-run boundary
    const priorMap = new Map<string, CheckStatus[]>([
      ['stale_check', ['warn', 'warn', 'warn', 'warn', 'warn']],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.emailableChecks).toHaveLength(0);
    expect(result.agendaChecks).toHaveLength(0);
  });

  it('re-surfaces persisting alert check to agenda at 12-run boundary', () => {
    const current: HeartbeatCheck[] = [
      { name: 'old_check', status: 'alert', detail: 'Old alert' },
    ];
    // 12 prior non-ok statuses — hits the boundary (alert bypasses chronic decay)
    const priorHistory = Array(12).fill('alert') as CheckStatus[];
    const priorMap = new Map<string, CheckStatus[]>([
      ['old_check', priorHistory],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.emailableChecks).toHaveLength(0);
    expect(result.agendaChecks).toHaveLength(1);
    expect(result.agendaChecks[0].detail).toContain('persisting');
  });

  it('suppresses chronic medium (warn) checks — resurfaces only at weekly boundary', () => {
    const current: HeartbeatCheck[] = [
      { name: 'chronic_check', status: 'warn', detail: 'Known risk' },
    ];
    // 12 consecutive warn runs — exceeds CHRONIC_MEDIUM_THRESHOLD (10)
    const priorHistory = Array(12).fill('warn') as CheckStatus[];
    const priorMap = new Map<string, CheckStatus[]>([
      ['chronic_check', priorHistory],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    // Chronic medium items are fully suppressed until the weekly boundary (28 runs)
    expect(result.emailableChecks).toHaveLength(0);
    expect(result.agendaChecks).toHaveLength(0);
  });

  it('detects resolved checks (warn/alert → ok)', () => {
    const current: HeartbeatCheck[] = [
      { name: 'fixed_check', status: 'ok', detail: 'All clear' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['fixed_check', ['warn']],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.resolved).toEqual(['fixed_check']);
    expect(result.emailableChecks).toHaveLength(0);
    expect(result.agendaChecks).toHaveLength(0);
  });

  it('does not mark ok→ok as resolved', () => {
    const current: HeartbeatCheck[] = [
      { name: 'healthy', status: 'ok', detail: 'Fine' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['healthy', ['ok']],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.resolved).toHaveLength(0);
  });

  it('handles multiple checks in a single call', () => {
    const current: HeartbeatCheck[] = [
      { name: 'new_issue', status: 'alert', detail: 'Brand new' },
      { name: 'escalated', status: 'alert', detail: 'Got worse' },
      { name: 'persisting', status: 'warn', detail: 'Same old' },
      { name: 'resolved', status: 'ok', detail: 'Fixed' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['escalated', ['warn']],
      ['persisting', ['warn', 'warn']],
      ['resolved', ['alert']],
    ]);

    const result = classifyCheckDeltas(current, priorMap);

    expect(result.emailableChecks).toHaveLength(2); // new_issue + escalated
    expect(result.agendaChecks).toHaveLength(2);     // new_issue + escalated
    expect(result.resolved).toEqual(['resolved']);
  });

  it('returns empty arrays when no checks provided', () => {
    const result = classifyCheckDeltas([], new Map());
    expect(result.emailableChecks).toHaveLength(0);
    expect(result.agendaChecks).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });
});

// ─── syncChecksToAgenda Tests ────────────────────────────────

describe('syncChecksToAgenda', () => {
  it('creates agenda items for new checks', async () => {
    const db = createMockDb({
      // first() for existing check, first() for dismissed check
      firstResults: [null, null],
    });

    const checks: HeartbeatCheck[] = [
      { name: 'new_alert', status: 'alert', detail: 'Something urgent' },
    ];

    await syncChecksToAgenda(db as unknown as D1Database, checks);

    // Should have 3 queries: SELECT active, SELECT dismissed, INSERT
    expect(db._queries).toHaveLength(3);
    const insertQuery = db._queries[2];
    expect(insertQuery.sql).toContain('INSERT INTO agent_agenda');
    // Alert-level checks become proposed actions with high priority
    expect(insertQuery.bindings[2]).toBe('high');
  });

  it('skips existing active agenda items', async () => {
    const db = createMockDb({
      firstResults: [{ id: 1 }], // existing active item found
    });

    const checks: HeartbeatCheck[] = [
      { name: 'existing_check', status: 'warn', detail: 'Already tracked' },
    ];

    await syncChecksToAgenda(db as unknown as D1Database, checks);

    // Only 1 query: the SELECT for existing check
    expect(db._queries).toHaveLength(1);
  });

  it('skips recently dismissed items', async () => {
    const db = createMockDb({
      firstResults: [null, { id: 2 }], // no active, but recently dismissed
    });

    const checks: HeartbeatCheck[] = [
      { name: 'dismissed_check', status: 'warn', detail: 'Was dismissed' },
    ];

    await syncChecksToAgenda(db as unknown as D1Database, checks);

    // 2 queries: SELECT active + SELECT dismissed (no INSERT)
    expect(db._queries).toHaveLength(2);
  });

  it('sets warn-level checks as medium priority without proposed prefix', async () => {
    const db = createMockDb({
      firstResults: [null, null],
    });

    const checks: HeartbeatCheck[] = [
      { name: 'minor_issue', status: 'warn', detail: 'Minor warning' },
    ];

    await syncChecksToAgenda(db as unknown as D1Database, checks);

    const insertQuery = db._queries[2];
    expect(insertQuery.bindings[2]).toBe('medium');
    // Should NOT have proposed action prefix for warn-level
    expect(insertQuery.bindings[0]).not.toContain('[PROPOSED ACTION]');
  });
});

// ─── resolveAgendaForChecks Tests ────────────────────────────

describe('resolveAgendaForChecks', () => {
  it('resolves agenda items matching cleared check names', async () => {
    const db = createMockDb();
    const checkNames = ['fixed_compliance', 'fixed_cost'];

    await resolveAgendaForChecks(db as unknown as D1Database, checkNames);

    expect(db._queries).toHaveLength(2);
    for (const q of db._queries) {
      expect(q.sql).toContain("status = 'done'");
      expect(q.sql).toContain("status = 'active'");
    }
    expect(db._queries[0].bindings).toContain('%fixed_compliance%');
    expect(db._queries[1].bindings).toContain('%fixed_cost%');
  });

  it('does nothing when no check names provided', async () => {
    const db = createMockDb();
    await resolveAgendaForChecks(db as unknown as D1Database, []);
    expect(db._queries).toHaveLength(0);
  });
});
