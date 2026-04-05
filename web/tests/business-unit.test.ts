// Tests for business_unit partitioning across agenda + goals modules.
// Covers: default value, custom BU pass-through, filtered queries, dedup scoping.

import { describe, it, expect, beforeEach } from 'vitest';
import { addAgendaItem, getActiveAgendaItems, DEFAULT_BUSINESS_UNIT } from '../src/kernel/memory/agenda.js';
import { addGoal, getActiveGoals } from '../src/kernel/memory/goals.js';

interface MockQuery {
  sql: string;
  bindings: unknown[];
}

function createMockDb(options: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
  runMeta?: { changes?: number; last_row_id?: number }[];
} = {}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let allIdx = 0;
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
        async first() {
          return options.firstResults?.[firstIdx++] ?? null;
        },
        async all() {
          const results = options.allResults?.[allIdx++] ?? [];
          return { results };
        },
        async run() {
          const meta = options.runMeta?.[runIdx++] ?? { changes: 1, last_row_id: 42 };
          return { meta };
        },
      };
    },
    _queries: queries,
  };

  return db as unknown as D1Database & { _queries: MockQuery[] };
}

describe('addAgendaItem business_unit', () => {
  it('defaults to "stackbilt" when not specified', async () => {
    const db = createMockDb({
      allResults: [[]],  // dedup candidates — none
      runMeta: [{ last_row_id: 10 }],
    });

    const id = await addAgendaItem(db, 'Test item', undefined, 'medium');
    expect(id).toBe(10);

    // Find INSERT query — last binding is business_unit
    const insertQuery = db._queries.find(q => q.sql.startsWith('INSERT INTO agent_agenda'));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.bindings[3]).toBe('stackbilt');
  });

  it('passes custom business_unit to INSERT', async () => {
    const db = createMockDb({
      allResults: [[]],
      runMeta: [{ last_row_id: 11 }],
    });

    await addAgendaItem(db, 'Food tier alert', undefined, 'high', 'foodfiles');

    const insertQuery = db._queries.find(q => q.sql.startsWith('INSERT INTO agent_agenda'));
    expect(insertQuery!.bindings[3]).toBe('foodfiles');
  });

  it('scopes dedup candidates query by business_unit', async () => {
    const db = createMockDb({
      allResults: [[]],
      runMeta: [{ last_row_id: 12 }],
    });

    await addAgendaItem(db, 'Some item with multiple words', undefined, 'medium', 'foodfiles');

    const dedupQuery = db._queries.find(q => q.sql.startsWith('SELECT id, item'));
    expect(dedupQuery).toBeDefined();
    expect(dedupQuery!.sql).toContain('business_unit = ?');
    expect(dedupQuery!.bindings[0]).toBe('foodfiles');
  });

  it('DEFAULT_BUSINESS_UNIT export is "stackbilt"', () => {
    expect(DEFAULT_BUSINESS_UNIT).toBe('stackbilt');
  });
});

describe('getActiveAgendaItems business_unit filter', () => {
  it('returns all items when no business_unit specified', async () => {
    const db = createMockDb({
      allResults: [[{ id: 1 }, { id: 2 }]],
    });

    const items = await getActiveAgendaItems(db);
    expect(items).toHaveLength(2);

    const query = db._queries[0];
    expect(query.sql).not.toContain('business_unit');
    expect(query.bindings).toHaveLength(0);
  });

  it('filters by business_unit when specified', async () => {
    const db = createMockDb({
      allResults: [[{ id: 3 }]],
    });

    const items = await getActiveAgendaItems(db, 'foodfiles');
    expect(items).toHaveLength(1);

    const query = db._queries[0];
    expect(query.sql).toContain("business_unit = ?");
    expect(query.bindings[0]).toBe('foodfiles');
  });
});

describe('addGoal business_unit', () => {
  it('defaults to "stackbilt" when not specified', async () => {
    const db = createMockDb();

    await addGoal(db, 'Test goal', 'description', 6);

    const insertQuery = db._queries.find(q => q.sql.startsWith('INSERT INTO agent_goals'));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.bindings[4]).toBe('stackbilt');
  });

  it('passes custom business_unit to INSERT', async () => {
    const db = createMockDb();

    await addGoal(db, 'FoodFiles monitor', 'Watch for churn', 24, 'foodfiles');

    const insertQuery = db._queries.find(q => q.sql.startsWith('INSERT INTO agent_goals'));
    expect(insertQuery!.bindings[4]).toBe('foodfiles');
  });
});

describe('getActiveGoals business_unit filter', () => {
  it('returns all goals when no business_unit specified', async () => {
    const db = createMockDb({
      allResults: [[{ id: 'g1' }, { id: 'g2' }]],
    });

    const goals = await getActiveGoals(db);
    expect(goals).toHaveLength(2);

    const query = db._queries[0];
    expect(query.sql).not.toContain('business_unit');
  });

  it('filters by business_unit when specified', async () => {
    const db = createMockDb({
      allResults: [[{ id: 'g3' }]],
    });

    const goals = await getActiveGoals(db, 'foodfiles');
    expect(goals).toHaveLength(1);

    const query = db._queries[0];
    expect(query.sql).toContain("business_unit = ?");
    expect(query.bindings[0]).toBe('foodfiles');
  });
});
