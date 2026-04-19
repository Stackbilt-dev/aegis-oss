// Issue watcher tests — label classification, prompt generation, dedup logic,
// manual grab detection (assignee + in-progress skip)
// Covers: LABEL_TO_CATEGORY routing, classifyIssue, buildIssueTaskPrompt,
//         runIssueWatcher skip conditions

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Issue } from '../src/github.js';

// ─── Label Classification (mirrors issue-watcher.ts logic) ───

// Replicate the label → category mapping since classifyIssue is not exported
const LABEL_TO_CATEGORY: Record<string, { category: string; authority: 'auto_safe' | 'proposed' }> = {
  bug:           { category: 'bugfix',   authority: 'auto_safe' },
  enhancement:   { category: 'feature',  authority: 'auto_safe' },
  documentation: { category: 'docs',     authority: 'auto_safe' },
  test:          { category: 'tests',    authority: 'auto_safe' },
  research:      { category: 'research', authority: 'auto_safe' },
  refactor:      { category: 'refactor', authority: 'auto_safe' },
};

function classifyIssue(labels: string[]): { category: string; authority: 'auto_safe' | 'proposed' } | null {
  for (const label of labels) {
    const mapping = LABEL_TO_CATEGORY[label.toLowerCase()];
    if (mapping) return mapping;
  }
  return null;
}

describe('issue watcher label classification', () => {
  it('maps bug label to bugfix/auto_safe', () => {
    const result = classifyIssue(['aegis', 'bug']);
    expect(result).toEqual({ category: 'bugfix', authority: 'auto_safe' });
  });

  it('maps enhancement label to feature/auto_safe', () => {
    const result = classifyIssue(['aegis', 'enhancement']);
    expect(result).toEqual({ category: 'feature', authority: 'auto_safe' });
  });

  it('maps documentation label to docs/auto_safe', () => {
    const result = classifyIssue(['documentation']);
    expect(result).toEqual({ category: 'docs', authority: 'auto_safe' });
  });

  it('maps test label to tests/auto_safe', () => {
    const result = classifyIssue(['test']);
    expect(result).toEqual({ category: 'tests', authority: 'auto_safe' });
  });

  it('maps research label to research/auto_safe', () => {
    const result = classifyIssue(['research']);
    expect(result).toEqual({ category: 'research', authority: 'auto_safe' });
  });

  it('maps refactor label to refactor/auto_safe', () => {
    const result = classifyIssue(['refactor']);
    expect(result).toEqual({ category: 'refactor', authority: 'auto_safe' });
  });

  it('returns null for unrecognized labels', () => {
    const result = classifyIssue(['aegis', 'wontfix', 'question']);
    expect(result).toBeNull();
  });

  it('returns null for empty labels', () => {
    const result = classifyIssue([]);
    expect(result).toBeNull();
  });

  it('is case-insensitive for label matching', () => {
    const result = classifyIssue(['BUG']);
    expect(result).toEqual({ category: 'bugfix', authority: 'auto_safe' });
  });

  it('uses first matching label when multiple match', () => {
    // bug comes first in the iteration, should take priority
    const result = classifyIssue(['bug', 'enhancement']);
    expect(result).toEqual({ category: 'bugfix', authority: 'auto_safe' });
  });

  it('all categories map to auto_safe authority', () => {
    for (const [, mapping] of Object.entries(LABEL_TO_CATEGORY)) {
      expect(mapping.authority).toBe('auto_safe');
    }
  });
});

// ─── Task Prompt Generation ──────────────────────────────────

describe('issue task prompt structure', () => {
  // Replicate buildIssueTaskPrompt logic
  function buildIssueTaskPrompt(
    issue: { number: number; title: string; url: string; labels: string[]; body: string },
    resolvedRepo: string,
  ): string {
    return `# MISSION BRIEF — GitHub Issue #${issue.number}

## Issue
**Title**: ${issue.title}
**Repo**: ${resolvedRepo}
**URL**: ${issue.url}
**Labels**: ${issue.labels.join(', ')}

## Description
${issue.body}

## Instructions
Fix the issue described above. Follow existing patterns in the codebase.
- Read relevant files before making changes
- Run typecheck after changes
- Commit with a message referencing #${issue.number}
- If the issue is unclear or too large, output TASK_BLOCKED with an explanation

## Scope
- Only modify files in this repository
- Do not make unrelated improvements
- Do not modify CI/CD, deploy scripts, or secrets`;
  }

  it('includes issue number in header and commit instructions', () => {
    const prompt = buildIssueTaskPrompt(
      { number: 42, title: 'Fix tests', url: 'https://github.com/org/repo/issues/42', labels: ['bug'], body: 'Tests are failing' },
      'ExampleOrg/aegis',
    );
    expect(prompt).toContain('# MISSION BRIEF — GitHub Issue #42');
    expect(prompt).toContain('referencing #42');
  });

  it('includes repo name and URL', () => {
    const prompt = buildIssueTaskPrompt(
      { number: 1, title: 'Test', url: 'https://github.com/org/repo/issues/1', labels: [], body: 'Body' },
      'ExampleOrg/aegis',
    );
    expect(prompt).toContain('**Repo**: ExampleOrg/aegis');
    expect(prompt).toContain('**URL**: https://github.com/org/repo/issues/1');
  });

  it('includes issue body in description', () => {
    const body = 'Detailed description of the bug with steps to reproduce';
    const prompt = buildIssueTaskPrompt(
      { number: 1, title: 'Test', url: 'url', labels: [], body },
      'ExampleOrg/aegis',
    );
    expect(prompt).toContain(body);
  });

  it('includes scope restrictions', () => {
    const prompt = buildIssueTaskPrompt(
      { number: 1, title: 'Test', url: 'url', labels: [], body: 'body' },
      'ExampleOrg/aegis',
    );
    expect(prompt).toContain('Only modify files in this repository');
    expect(prompt).toContain('Do not make unrelated improvements');
    expect(prompt).toContain('Do not modify CI/CD');
  });
});

// ─── Body Quality Gate ───────────────────────────────────────

describe('issue body quality gate', () => {
  it('rejects bodies shorter than 20 chars', () => {
    const body = 'too short';
    expect(!body || body.trim().length < 20).toBe(true);
  });

  it('accepts bodies of 20+ chars', () => {
    const body = 'This is a sufficient description for the issue';
    expect(!body || body.trim().length < 20).toBe(false);
  });

  it('rejects null/undefined body', () => {
    const body: string | undefined = undefined;
    expect(!body || body.trim().length < 20).toBe(true);
  });

  it('rejects whitespace-only body that trims below 20', () => {
    const body = '   short   ';
    expect(!body || body.trim().length < 20).toBe(true);
  });
});

// ─── Manual Grab Detection (assignee + in-progress label) ───
// Tests runIssueWatcher integration with mocked D1 + GitHub

// Mock operator modules (config.ts is gitignored)
vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'TestOperator', possessive: "TestOperator's" },
    persona: { tagline: 'test', traits: ['be direct'], channelNote: '' },
    entities: { names: [], memoryTopics: [] },
    products: [],
    selfModel: {
      identity: 'test-agent', role: 'test', stakes: '',
      principles: [], interests: [], strengths: [],
      preferences: { communication: '', work: '', learning: '' },
    },
    integrations: {
      bizops: { enabled: false, fallbackUrl: 'http://localhost', toolPrefix: 'test' },
      github: { enabled: false }, brave: { enabled: false },
      email: { profiles: {}, defaultProfile: 'test' },
      goals: { enabled: false }, cfObservability: { enabled: false },
      imgForge: { enabled: false, baseUrl: 'http://localhost' },
    },
    baseUrl: 'http://localhost', userAgent: 'test/1.0',
  },
  renderTemplate: (t: string) => t,
}));

vi.mock('../src/operator/prompt-builder.js', () => ({
  buildPersonaPreamble: () => 'test', buildSystemPrompt: () => 'test',
  buildGroqSystemPrompt: () => 'test', buildClassifySystem: () => 'test',
  getTaskPatterns: () => [],
}));

// Mock GitHub calls
const mockListIssues = vi.fn<() => Promise<Issue[]>>().mockResolvedValue([]);
const mockCommentOnIssue = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/github.js')>();
  return {
    ...actual,
    listIssues: (...args: unknown[]) => mockListIssues(),
    commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(),
  };
});

// Mock governance — always allow
vi.mock('../src/kernel/scheduled/governance.js', () => ({
  checkTaskGovernanceLimits: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

// Import after mocks
import { runIssueWatcher } from '../src/kernel/scheduled/issue-watcher.js';

/** Minimal mock D1Database */
function createMockDb(rows: Record<string, unknown>[] = []) {
  const first = vi.fn().mockResolvedValue(rows[0] ?? null);
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, bind, first, run } as unknown as D1Database & {
    prepare: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    first: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    title: 'Test issue',
    state: 'open',
    url: 'https://github.com/ExampleOrg/aegis/issues/10',
    labels: ['aegis', 'bug'],
    body: 'This is a sufficiently long description for body quality gate',
    created_at: '2026-03-10T00:00:00Z',
    assignee: null,
    ...overrides,
  };
}

function makeEnv(db: D1Database) {
  return {
    db,
    githubToken: 'test-token',
    githubRepo: 'ExampleOrg/aegis',
    anthropicApiKey: '',
    groqApiKey: '',
    aegisToken: '',
  } as any;
}

describe('runIssueWatcher manual grab detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips issue when assignee is set', async () => {
    const db = createMockDb(); // dedup query returns null (no existing task)
    const issue = makeIssue({ assignee: 'kurt-dev' });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    // Dedup query fires, then no INSERT (skipped before task creation)
    // The cc_tasks dedup SELECT should fire but no INSERT should follow
    expect(db.prepare).toHaveBeenCalled();
    // Only 1 prepare call: the dedup SELECT. No INSERT for cc_tasks.
    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips issue with in-progress label', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['aegis', 'bug', 'in-progress'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips issue with In-Progress label (case-insensitive)', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['aegis', 'bug', 'In-Progress'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips issue with IN-PROGRESS label (uppercase)', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['aegis', 'bug', 'IN-PROGRESS'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('proceeds when no assignee and no in-progress label', async () => {
    const db = createMockDb(); // dedup returns null, governance allows
    const issue = makeIssue({ assignee: null, labels: ['aegis', 'bug'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    // Should reach INSERT INTO cc_tasks
    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(1);
  });

  it('dedup fires before assignee check (existing task short-circuits first)', async () => {
    // Return a row from dedup query → should skip before checking assignee
    const db = createMockDb([{ '1': 1 }]); // dedup returns existing task
    const issue = makeIssue({ assignee: 'someone' });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    // Dedup SELECT fires, no INSERT
    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);

    // Only the dedup SELECT was called (1 prepare call), not governance or task insert
    // The dedup check should be the first (and possibly only) prepare call
    const firstQuery = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(firstQuery).toContain('SELECT 1 FROM cc_tasks');
  });
});

// ─── Multi-session scope label filter ──────────────────────

describe('runIssueWatcher scope label filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips issue with wishlist label', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['aegis', 'enhancement', 'wishlist'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips issue with roadmap label', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['enhancement', 'roadmap'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips issue with epic label', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['feature', 'epic'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skips issue with blocked label', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['refactor', 'blocked'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('skip label filter is case-insensitive', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['bug', 'WISHLIST'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(0);
  });

  it('proceeds when no scope label is present', async () => {
    const db = createMockDb();
    const issue = makeIssue({ labels: ['enhancement'] });
    mockListIssues.mockResolvedValueOnce([issue]);

    await runIssueWatcher(makeEnv(db));

    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .filter((c: string[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO cc_tasks'));
    expect(insertCalls).toHaveLength(1);
  });
});

// ─── Issue interface: assignee field ────────────────────────

describe('Issue interface assignee field', () => {
  it('Issue type includes assignee as string | null', () => {
    // Type-level test: this compiles only if assignee is on the Issue type
    const issue: Issue = {
      number: 1, title: 't', state: 'open', url: 'u',
      labels: [], body: 'b', created_at: '2026-01-01T00:00:00Z',
      assignee: null,
    };
    expect(issue.assignee).toBeNull();

    const withAssignee: Issue = { ...issue, assignee: 'kurt' };
    expect(withAssignee.assignee).toBe('kurt');
  });
});
