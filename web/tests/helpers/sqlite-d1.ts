// Minimal D1Database stand-in backed by node:sqlite, for tests that need real
// SQL semantics (UNIQUE, ON CONFLICT, UPDATE ... RETURNING) rather than a
// scripted mock. Covers prepare/bind/first/all/run/exec only.

import { DatabaseSync } from 'node:sqlite';

type Param = string | number | bigint | null | Uint8Array;

// Matches D1: undefined is a type error (D1_TYPE_ERROR), not NULL, so a
// missing bind fails here as it would in production.
function toParam(value: unknown, index: number): Param {
  if (value === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${index}`);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as Param;
}

export function createSqliteD1(schemaSql: string): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(schemaSql);

  const prepare = (sql: string) => {
    let params: Param[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        params = args.map((v, i) => toParam(v, i));
        return stmt;
      },
      async first<T>(column?: string): Promise<T | null> {
        const rows = raw.prepare(sql).all(...params) as Record<string, unknown>[];
        const row = rows[0];
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        const before = Number((raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
        const results = raw.prepare(sql).all(...params) as T[];
        const after = Number((raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
        return { results, success: true, meta: { changes: after - before } };
      },
      async run() {
        const info = raw.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  };

  return {
    raw,
    prepare,
    async exec(sql: string) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
    async batch() {
      throw new Error('sqlite-d1: batch not implemented');
    },
    async dump() {
      throw new Error('sqlite-d1: dump not implemented');
    },
  } as unknown as D1Database & { raw: DatabaseSync };
}
