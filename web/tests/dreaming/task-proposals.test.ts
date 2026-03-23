import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processTaskProposals } from '../../src/kernel/scheduled/dreaming/task-proposals.js';

// Mock governance — allow all by default
vi.mock('../../src/kernel/scheduled/governance.js', () => ({
  checkTaskGovernanceLimits: vi.fn().mockResolvedValue({ allowed: true }),
}));

function makeDb(overrides?: Partial<D1Database>): D1Database {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    raw: vi.fn().mockResolvedValue([]),
  };
  return { prepare: vi.fn().mockReturnValue(stmt), batch: vi.fn(), dump: vi.fn(), exec: vi.fn(), ...overrides } as unknown as D1Database;
}

describe('processTaskProposals', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 0 for empty proposals', async () => {
    const db = makeDb();
    expect(await processTaskProposals(db, [])).toBe(0);
    expect(await processTaskProposals(db, undefined)).toBe(0);
  });

  it('inserts valid task proposal', async () => {
    const db = makeDb();
    const result = await processTaskProposals(db, [{
      title: 'Add unit tests for dispatch',
      repo: 'aegis',
      prompt: 'Write vitest unit tests for the dispatch function in web/src/kernel/dispatch.ts. Cover the main routing paths.',
      category: 'tests',
      rationale: 'Dispatch has no dedicated unit tests',
    }]);
    expect(result).toBe(1);
    expect(db.prepare).toHaveBeenCalled();
  });

  it('skips task with missing fields', async () => {
    const db = makeDb();
    const result = await processTaskProposals(db, [{
      title: '',
      repo: 'aegis',
      prompt: 'Do something with enough characters to pass the minimum prompt length check here',
      category: 'tests',
      rationale: 'test',
    }]);
    expect(result).toBe(0);
  });

  it('skips task with unknown repo', async () => {
    const db = makeDb();
    const result = await processTaskProposals(db, [{
      title: 'Fix something',
      repo: 'unknown-repo-not-in-allowlist',
      prompt: 'Fix the bug in the unknown repo that causes the issue with the thing in production environment',
      category: 'bugfix',
      rationale: 'Bug found',
    }]);
    expect(result).toBe(0);
  });

  it('skips deploy category tasks', async () => {
    const db = makeDb();
    const result = await processTaskProposals(db, [{
      title: 'Deploy to production',
      repo: 'aegis',
      prompt: 'Run wrangler deploy to push the latest changes to the production cloudflare workers environment',
      category: 'deploy',
      rationale: 'New version ready',
    }]);
    expect(result).toBe(0);
  });

  it('skips tasks with prompt too short', async () => {
    const db = makeDb();
    const result = await processTaskProposals(db, [{
      title: 'Fix bug',
      repo: 'aegis',
      prompt: 'Fix it',
      category: 'bugfix',
      rationale: 'broken',
    }]);
    expect(result).toBe(0);
  });

  it('caps at 3 tasks per cycle', async () => {
    const db = makeDb();
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      title: `Task ${i + 1}`,
      repo: 'aegis',
      prompt: `Detailed instructions for task ${i + 1} with enough content to pass the minimum prompt length validation check`,
      category: 'tests',
      rationale: `Reason ${i + 1}`,
    }));
    const result = await processTaskProposals(db, tasks);
    expect(result).toBeLessThanOrEqual(3);
  });

  it('skips invalid category', async () => {
    const db = makeDb();
    const result = await processTaskProposals(db, [{
      title: 'Do something',
      repo: 'aegis',
      prompt: 'Execute this arbitrary category task that does not match any valid category in the system',
      category: 'yolo',
      rationale: 'because',
    }]);
    expect(result).toBe(0);
  });
});
