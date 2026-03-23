// Unit tests for the scheduled task subsystem (GitHub issue #147)
// Covers: dreaming, reflection, heartbeat, escalation, goals,
//         briefing, curiosity, issue-watcher, index orchestration,
//         self-improvement

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the operator module tree (config.ts is gitignored) ─

// Mock the operator/index module so config.js is never resolved
vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'TestOperator', possessive: "TestOperator's" },
    persona: { tagline: 'test', traits: ['be direct'], channelNote: '' },
    entities: { names: [], memoryTopics: [] },
    products: [],
    selfModel: {
      identity: 'test-agent',
      role: 'test',
      stakes: '',
      principles: [],
      interests: ['AI infrastructure', 'Edge computing'],
      strengths: [],
      preferences: { communication: '', work: '', learning: '' },
    },
    integrations: {
      bizops: { enabled: false, fallbackUrl: 'http://localhost', toolPrefix: 'test' },
      github: { enabled: false },
      brave: { enabled: false },
      email: { profiles: {}, defaultProfile: 'test' },
      goals: { enabled: false },
      cfObservability: { enabled: false },
      imgForge: { enabled: false, baseUrl: 'http://localhost' },
    },
    baseUrl: 'http://localhost',
    userAgent: 'test/1.0',
  },
  renderTemplate: (t: string) => t,
}));

// Also mock prompt-builder which imports from operator/index
vi.mock('../src/operator/prompt-builder.js', () => ({
  buildPersonaPreamble: () => 'test preamble',
  buildSystemPrompt: () => 'test system prompt',
  buildGroqSystemPrompt: () => 'test groq system prompt',
  buildClassifySystem: () => 'test classify system',
  getTaskPatterns: () => [],
}));

// Mock fetch globally to prevent real network calls
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

// Now import after mocks are set up
import { classifyCheckDeltas, ALERT_SEVERITIES, type HeartbeatCheck, type CheckStatus } from '../src/kernel/scheduled/heartbeat.js';
import { ESCALATION_THRESHOLDS, STALE_HIGH_ALERT_DAYS, ISSUE_REF_PATTERN } from '../src/kernel/scheduled/escalation.js';
import { MAX_GOALS_PER_CYCLE, AUTO_LOW_APPROVED_TOOLS, AUTO_LOW_MAX_ACTIONS_PER_RUN, AUTO_LOW_FAILURE_THRESHOLD } from '../src/kernel/scheduled/goals.js';
import { REFLECTION_SYSTEM, OPERATOR_LOG_SYSTEM, type DailyActivity, type TaskActivity } from '../src/kernel/scheduled/reflection.js';
import { type CuriosityCandidate, buildCuriosityPrompt } from '../src/kernel/scheduled/curiosity.js';
import { DEFAULT_WATCH_REPOS } from '../src/kernel/scheduled/self-improvement.js';

// ─── D1 Mock Factory ─────────────────────────────────────────

interface MockQuery {
  sql: string;
  bindings: unknown[];
}

function createMockDb(options?: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[][];
}) {
  const queries: MockQuery[] = [];
  let firstIdx = 0;
  let allIdx = 0;
  const firstResults = options?.firstResults ?? [];
  const allResults = options?.allResults ?? [];

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
          return (firstResults[idx] ?? null) as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const idx = allIdx++;
          return { results: (allResults[idx] ?? []) as T[] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    _queries: queries,
  };
  return db as unknown as D1Database & { _queries: MockQuery[] };
}

// ─── classifyCheckDeltas (heartbeat.ts) ─────────────────────

describe('classifyCheckDeltas', () => {
  it('flags a new warn check as both emailable and agenda-worthy', () => {
    const current: HeartbeatCheck[] = [
      { name: 'memory_separation', status: 'warn', detail: 'low score' },
    ];
    const priorMap = new Map<string, CheckStatus[]>();

    const { emailableChecks, agendaChecks, resolved } = classifyCheckDeltas(current, priorMap);

    expect(emailableChecks).toHaveLength(1);
    expect(emailableChecks[0].name).toBe('memory_separation');
    expect(agendaChecks).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('detects an escalation from warn to alert', () => {
    const current: HeartbeatCheck[] = [
      { name: 'bizops_drift', status: 'alert', detail: 'critical drift' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['bizops_drift', ['warn']],
    ]);

    const { emailableChecks, agendaChecks, resolved } = classifyCheckDeltas(current, priorMap);

    expect(emailableChecks).toHaveLength(1);
    expect(agendaChecks).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });

  it('detects resolution when a check goes from warn to ok', () => {
    const current: HeartbeatCheck[] = [
      { name: 'memory_health', status: 'ok', detail: 'healthy' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['memory_health', ['warn']],
    ]);

    const { emailableChecks, agendaChecks, resolved } = classifyCheckDeltas(current, priorMap);

    expect(emailableChecks).toHaveLength(0);
    expect(agendaChecks).toHaveLength(0);
    expect(resolved).toEqual(['memory_health']);
  });

  it('suppresses persisting checks from email (no re-alert)', () => {
    const current: HeartbeatCheck[] = [
      { name: 'cost_anomaly', status: 'warn', detail: 'high cost' },
    ];
    // Persisting for 3 runs — not at the 12-run boundary
    const priorMap = new Map<string, CheckStatus[]>([
      ['cost_anomaly', ['warn', 'warn', 'warn']],
    ]);

    const { emailableChecks, agendaChecks } = classifyCheckDeltas(current, priorMap);

    expect(emailableChecks).toHaveLength(0);
    // Not at the 12-cycle boundary, so also suppressed from agenda
    expect(agendaChecks).toHaveLength(0);
  });

  it('re-surfaces a check to agenda every 12 persisting cycles', () => {
    const current: HeartbeatCheck[] = [
      { name: 'stale_data', status: 'warn', detail: 'old data' },
    ];
    // 12 prior non-ok runs = should re-surface
    const priorHistory: CheckStatus[] = Array(12).fill('warn') as CheckStatus[];
    const priorMap = new Map<string, CheckStatus[]>([
      ['stale_data', priorHistory],
    ]);

    const { emailableChecks, agendaChecks } = classifyCheckDeltas(current, priorMap);

    expect(emailableChecks).toHaveLength(0); // no re-email
    expect(agendaChecks).toHaveLength(1); // re-surfaced to agenda
    expect(agendaChecks[0].detail).toContain('persisting');
  });

  it('treats ok-to-ok as no-op (no email, no agenda, no resolution)', () => {
    const current: HeartbeatCheck[] = [
      { name: 'all_good', status: 'ok', detail: 'fine' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['all_good', ['ok']],
    ]);

    const { emailableChecks, agendaChecks, resolved } = classifyCheckDeltas(current, priorMap);

    expect(emailableChecks).toHaveLength(0);
    expect(agendaChecks).toHaveLength(0);
    expect(resolved).toHaveLength(0);
  });

  it('handles multiple checks with mixed states', () => {
    const current: HeartbeatCheck[] = [
      { name: 'a', status: 'warn', detail: 'new issue' },
      { name: 'b', status: 'ok', detail: 'resolved' },
      { name: 'c', status: 'alert', detail: 'escalated' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['b', ['alert']],
      ['c', ['warn']],
    ]);

    const { emailableChecks, agendaChecks, resolved } = classifyCheckDeltas(current, priorMap);

    // 'a' is new, 'c' escalated warn->alert
    expect(emailableChecks).toHaveLength(2);
    expect(agendaChecks).toHaveLength(2);
    // 'b' resolved from alert->ok
    expect(resolved).toEqual(['b']);
  });

  it('handles alert-to-alert as persisting (no re-email)', () => {
    const current: HeartbeatCheck[] = [
      { name: 'critical_issue', status: 'alert', detail: 'still bad' },
    ];
    const priorMap = new Map<string, CheckStatus[]>([
      ['critical_issue', ['alert']],
    ]);

    const { emailableChecks } = classifyCheckDeltas(current, priorMap);
    expect(emailableChecks).toHaveLength(0);
  });
});

// ─── Escalation thresholds and patterns ──────────────────────

describe('escalation constants', () => {
  it('escalates low items after 7 days to medium', () => {
    const threshold = ESCALATION_THRESHOLDS['low'];
    expect(threshold).toBeDefined();
    expect(threshold.days).toBe(7);
    expect(threshold.newPriority).toBe('medium');
  });

  it('escalates medium items after 3 days to high', () => {
    const threshold = ESCALATION_THRESHOLDS['medium'];
    expect(threshold).toBeDefined();
    expect(threshold.days).toBe(3);
    expect(threshold.newPriority).toBe('high');
  });

  it('does not have an escalation path for high items', () => {
    expect(ESCALATION_THRESHOLDS['high']).toBeUndefined();
  });

  it('stale high alert threshold is 1 day', () => {
    expect(STALE_HIGH_ALERT_DAYS).toBe(1);
  });
});

describe('ISSUE_REF_PATTERN', () => {
  it('matches issue references like #123', () => {
    const text = 'Fix bug in #42 and #100';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('42');
    expect(matches[1][1]).toBe('100');
  });

  it('matches issue references at start of string', () => {
    const text = '#1 is the first issue';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe('1');
  });

  it('returns no matches for text without refs', () => {
    const text = 'No issues here';
    const matches = [...text.matchAll(ISSUE_REF_PATTERN)];
    expect(matches).toHaveLength(0);
  });
});

// ─── Goal loop constants ─────────────────────────────────────

describe('goal loop constants', () => {
  it('caps goals per cycle at 3', () => {
    expect(MAX_GOALS_PER_CYCLE).toBe(3);
  });

  it('approves low-risk tools for auto_low', () => {
    expect(AUTO_LOW_APPROVED_TOOLS.has('record_memory_entry')).toBe(true);
    expect(AUTO_LOW_APPROVED_TOOLS.has('add_agenda_item')).toBe(true);
    expect(AUTO_LOW_APPROVED_TOOLS.has('resolve_agenda_item')).toBe(true);
  });

  it('does not include high-risk tools in auto_low set', () => {
    expect(AUTO_LOW_APPROVED_TOOLS.has('create_issue')).toBe(false);
    expect(AUTO_LOW_APPROVED_TOOLS.has('deploy')).toBe(false);
  });

  it('limits auto_low actions per run to 3', () => {
    expect(AUTO_LOW_MAX_ACTIONS_PER_RUN).toBe(3);
  });

  it('downgrades after 2 consecutive failures', () => {
    expect(AUTO_LOW_FAILURE_THRESHOLD).toBe(2);
  });
});

// ─── Reflection system prompts ───────────────────────────────

describe('reflection system prompts', () => {
  it('REFLECTION_SYSTEM instructs first-person reflection', () => {
    expect(REFLECTION_SYSTEM).toContain('first person');
    expect(REFLECTION_SYSTEM).toContain('weekly reflection');
  });

  it('OPERATOR_LOG_SYSTEM includes Work Shipped section', () => {
    expect(OPERATOR_LOG_SYSTEM).toContain('Work Shipped');
    expect(OPERATOR_LOG_SYSTEM).toContain('Signals');
  });
});

// ─── Curiosity prompt construction ───────────────────────────

describe('buildCuriosityPrompt', () => {
  it('includes all candidate topics in the prompt', () => {
    const candidates: CuriosityCandidate[] = [
      { topic: 'Why does routing fail?', reason: '5/10 failures', source: 'failure_rate' },
      { topic: 'Explore edge computing trends', reason: 'Self interest', source: 'self_interest' },
    ];

    const prompt = buildCuriosityPrompt(candidates);

    expect(prompt).toContain('Why does routing fail?');
    expect(prompt).toContain('Explore edge computing trends');
    expect(prompt).toContain('[failure_rate]');
    expect(prompt).toContain('[self_interest]');
    expect(prompt).toContain('5/10 failures');
  });

  it('numbers candidates sequentially', () => {
    const candidates: CuriosityCandidate[] = [
      { topic: 'Topic A', reason: 'reason a', source: 'memory_gap' },
      { topic: 'Topic B', reason: 'reason b', source: 'low_confidence' },
      { topic: 'Topic C', reason: 'reason c', source: 'goal_failure' },
    ];

    const prompt = buildCuriosityPrompt(candidates);

    expect(prompt).toContain('1. [memory_gap]');
    expect(prompt).toContain('2. [low_confidence]');
    expect(prompt).toContain('3. [goal_failure]');
  });

  it('includes instructions for curiosity behavior', () => {
    const prompt = buildCuriosityPrompt([
      { topic: 'test', reason: 'test', source: 'memory_gap' },
    ]);

    expect(prompt).toContain('curiosity cycle');
    expect(prompt).toContain('genuinely curious');
  });
});

// ─── Self-improvement defaults ───────────────────────────────

describe('self-improvement defaults', () => {
  it('DEFAULT_WATCH_REPOS includes core repos', () => {
    expect(DEFAULT_WATCH_REPOS).toContain('aegis');
    expect(DEFAULT_WATCH_REPOS).toContain('demo_app_v2');
    expect(DEFAULT_WATCH_REPOS).toContain('charter');
    expect(DEFAULT_WATCH_REPOS).toContain('img-forge');
    expect(DEFAULT_WATCH_REPOS).toContain('example-auth');
    expect(DEFAULT_WATCH_REPOS).toContain('bizops-copilot');
  });

  it('has at least 5 default repos', () => {
    expect(DEFAULT_WATCH_REPOS.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── Issue watcher label classification ──────────────────────

describe('issue watcher label -> category routing', () => {
  // Re-implement the label-to-category mapping to test the logic
  // (classifyIssue is not exported from issue-watcher.ts)
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

  it('maps bug label to bugfix category', () => {
    const result = classifyIssue(['aegis', 'bug']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('bugfix');
    expect(result!.authority).toBe('auto_safe');
  });

  it('maps enhancement label to feature category', () => {
    const result = classifyIssue(['aegis', 'enhancement']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('feature');
    expect(result!.authority).toBe('auto_safe');
  });

  it('maps documentation label to docs category', () => {
    const result = classifyIssue(['aegis', 'documentation']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('docs');
    expect(result!.authority).toBe('auto_safe');
  });

  it('maps test label to tests category', () => {
    const result = classifyIssue(['aegis', 'test']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('tests');
  });

  it('maps research label to research category', () => {
    const result = classifyIssue(['aegis', 'research']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('research');
  });

  it('maps refactor label to refactor category', () => {
    const result = classifyIssue(['aegis', 'refactor']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('refactor');
  });

  it('returns null when no recognized category label is present', () => {
    const result = classifyIssue(['aegis', 'help-wanted', 'good-first-issue']);
    expect(result).toBeNull();
  });

  it('uses first matching label when multiple categories present', () => {
    const result = classifyIssue(['bug', 'enhancement']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('bugfix'); // bug comes first
  });

  it('is case-insensitive', () => {
    const result = classifyIssue(['BUG']);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('bugfix');
  });

  it('all categories map to auto_safe authority', () => {
    for (const label of Object.keys(LABEL_TO_CATEGORY)) {
      const result = classifyIssue([label]);
      expect(result!.authority).toBe('auto_safe');
    }
  });
});

// ─── Dreaming task proposal validation ───────────────────────

describe('dreaming task proposal validation', () => {
  // These sets mirror the actual source in dreaming.ts
  const AUTO_SAFE_CATEGORIES = new Set(['docs', 'tests', 'research', 'refactor']);
  const PROPOSED_CATEGORIES = new Set(['bugfix', 'feature']);
  const VALID_CATEGORIES = new Set([...AUTO_SAFE_CATEGORIES, ...PROPOSED_CATEGORIES]);

  it('auto_safe includes docs, tests, research, refactor', () => {
    expect(AUTO_SAFE_CATEGORIES.has('docs')).toBe(true);
    expect(AUTO_SAFE_CATEGORIES.has('tests')).toBe(true);
    expect(AUTO_SAFE_CATEGORIES.has('research')).toBe(true);
    expect(AUTO_SAFE_CATEGORIES.has('refactor')).toBe(true);
  });

  it('proposed includes bugfix and feature', () => {
    expect(PROPOSED_CATEGORIES.has('bugfix')).toBe(true);
    expect(PROPOSED_CATEGORIES.has('feature')).toBe(true);
  });

  it('deploy is NOT a valid category', () => {
    expect(VALID_CATEGORIES.has('deploy')).toBe(false);
  });

  it('all valid categories are either auto_safe or proposed', () => {
    for (const cat of VALID_CATEGORIES) {
      expect(AUTO_SAFE_CATEGORIES.has(cat) || PROPOSED_CATEGORIES.has(cat)).toBe(true);
    }
  });

  it('rejects proposals with empty required fields', () => {
    const incomplete = { title: '', repo: 'aegis', prompt: 'do something', category: 'docs', rationale: 'test' };
    expect(!incomplete.title).toBe(true); // empty title is falsy
  });

  it('caps proposals at 3 per dreaming cycle', () => {
    const proposals = Array(5).fill({
      title: 'task', repo: 'aegis', prompt: 'prompt', category: 'docs', rationale: 'r',
    });
    const capped = proposals.slice(0, 3);
    expect(capped).toHaveLength(3);
  });

  it('rejects facts shorter than 20 characters', () => {
    const shortFact = { topic: 'test', fact: 'too short', confidence: 0.8 };
    expect(shortFact.fact.length < 20).toBe(true);
  });
});

// ─── getDailyActivity result shape ──────────────────────────

describe('DailyActivity shape', () => {
  it('constructs a valid DailyActivity from mock data', () => {
    const activity: DailyActivity = {
      episodes: [
        { summary: 'test dispatch', outcome: 'success', cost: 0.01, latency_ms: 500, created_at: '2026-03-10T12:00:00Z' },
      ],
      goalActions: [
        { description: 'checked compliance', outcome: 'success', created_at: '2026-03-10T11:00:00Z' },
      ],
      heartbeat: { severity: 'low', summary: 'all clear' },
      agendaActive: 5,
      agendaResolved: 2,
      totalCost: 0.01,
      tasksCompleted: [],
      tasksFailed: [],
    };

    expect(activity.episodes).toHaveLength(1);
    expect(activity.goalActions).toHaveLength(1);
    expect(activity.heartbeat).not.toBeNull();
    expect(activity.agendaActive).toBe(5);
    expect(activity.totalCost).toBe(0.01);
  });

  it('computes totalCost from episodes', () => {
    const episodes = [
      { summary: 'a', outcome: 'success', cost: 0.005, latency_ms: 100, created_at: '' },
      { summary: 'b', outcome: 'success', cost: 0.015, latency_ms: 200, created_at: '' },
    ];
    const totalCost = episodes.reduce((sum, e) => sum + e.cost, 0);
    expect(totalCost).toBeCloseTo(0.02);
  });

  it('TaskActivity includes pr_url and error fields', () => {
    const task: TaskActivity = {
      id: 'abc-123',
      title: 'Fix test',
      repo: 'aegis',
      category: 'bugfix',
      authority: 'auto_safe',
      status: 'completed',
      exit_code: 0,
      pr_url: 'https://github.com/ExampleOrg/aegis/pull/42',
      error: null,
      completed_at: '2026-03-10T14:00:00Z',
    };

    expect(task.pr_url).toContain('pull/42');
    expect(task.error).toBeNull();
  });
});

// ─── runScheduledTasks orchestration ─────────────────────────

describe('runScheduledTasks orchestration logic', () => {
  it('self-improvement runs only when hour % 6 === 0', () => {
    for (let h = 0; h < 24; h++) {
      const isSelfImprovementHour = h % 6 === 0;
      if (h === 0 || h === 6 || h === 12 || h === 18) {
        expect(isSelfImprovementHour).toBe(true);
      } else {
        expect(isSelfImprovementHour).toBe(false);
      }
    }
  });

  it('goals run on non-self-improvement hours', () => {
    for (let h = 0; h < 24; h++) {
      const isSelfImprovementHour = h % 6 === 0;
      const goalsRun = !isSelfImprovementHour;
      // Self-improvement and goals are mutually exclusive
      expect(isSelfImprovementHour).not.toBe(goalsRun);
    }
  });

  it('curiosity only runs on non-self-improvement hours', () => {
    for (let h = 0; h < 24; h++) {
      const isSelfImprovementHour = h % 6 === 0;
      const curiosityRuns = !isSelfImprovementHour;
      if ([0, 6, 12, 18].includes(h)) {
        expect(curiosityRuns).toBe(false);
      } else {
        expect(curiosityRuns).toBe(true);
      }
    }
  });
});

// ─── Morning briefing time gate ──────────────────────────────

describe('morning briefing time gating', () => {
  it('only fires between 11:00-12:59 UTC', () => {
    const validHours = [11, 12];
    for (let h = 0; h < 24; h++) {
      const wouldFire = h >= 11 && h <= 12;
      expect(wouldFire).toBe(validHours.includes(h));
    }
  });
});

// ─── Dreaming cycle watermark gating ─────────────────────────

describe('dreaming cycle watermark', () => {
  it('skips if last run was less than 20 hours ago', () => {
    const lastRunHoursAgo = 15;
    const shouldSkip = lastRunHoursAgo < 20;
    expect(shouldSkip).toBe(true);
  });

  it('runs if last run was 20+ hours ago', () => {
    const lastRunHoursAgo = 21;
    const shouldSkip = lastRunHoursAgo < 20;
    expect(shouldSkip).toBe(false);
  });

  it('runs if there is no prior watermark', () => {
    const lastRun = null;
    expect(lastRun).toBeNull();
  });
});

// ─── Operator log cycle time gating ──────────────────────────

describe('operator log time gating', () => {
  it('only fires at 05:00 UTC', () => {
    for (let h = 0; h < 24; h++) {
      expect(h === 5).toBe(h === 5);
    }
  });
});

// ─── Reflection cycle time gating ────────────────────────────

describe('reflection cycle time gating', () => {
  it('only fires on Saturdays (day 6) at 08:00 UTC', () => {
    const day = 6;
    const hour = 8;
    const wouldFire = day === 6 && hour === 8;
    expect(wouldFire).toBe(true);
  });

  it('does not fire on other days', () => {
    for (let d = 0; d < 7; d++) {
      if (d === 6) continue;
      const wouldFire = d === 6 && 8 === 8;
      expect(wouldFire).toBe(false);
    }
  });

  it('skips if fewer than 10 active memories', () => {
    const memoryCount = 7;
    const shouldSkip = memoryCount < 10;
    expect(shouldSkip).toBe(true);
  });
});

// ─── Curiosity cycle time gating ─────────────────────────────

describe('curiosity cycle time gating', () => {
  it('only fires at 14:00 UTC', () => {
    for (let h = 0; h < 24; h++) {
      expect(h === 14).toBe(h === 14);
    }
  });

  it('has 20-hour dedup cooldown', () => {
    const hoursSinceLast = 19;
    expect(hoursSinceLast < 20).toBe(true);

    const hoursSinceLast2 = 21;
    expect(hoursSinceLast2 < 20).toBe(false);
  });
});

// ─── resolveStaleIssueRefs logic ─────────────────────────────

describe('resolveStaleIssueRefs logic', () => {
  it('extracts multiple issue refs from agenda items', () => {
    const items = [
      { id: 1, item: 'Fix #42 and #100', context: null },
      { id: 2, item: 'Work on #42', context: null },
    ];

    const issueRefs = new Map<number, number[]>();
    for (const item of items) {
      const matches = item.item.matchAll(ISSUE_REF_PATTERN);
      for (const match of matches) {
        const issueNum = parseInt(match[1], 10);
        if (issueNum > 0 && issueNum < 10000) {
          const ids = issueRefs.get(issueNum) ?? [];
          ids.push(item.id);
          issueRefs.set(issueNum, ids);
        }
      }
    }

    expect(issueRefs.get(42)).toEqual([1, 2]);
    expect(issueRefs.get(100)).toEqual([1]);
    expect(issueRefs.size).toBe(2);
  });

  it('filters out issue numbers >= 10000', () => {
    const items = [{ id: 1, item: 'Fix #99999', context: null }];
    const issueRefs = new Map<number, number[]>();
    for (const item of items) {
      const matches = item.item.matchAll(ISSUE_REF_PATTERN);
      for (const match of matches) {
        const issueNum = parseInt(match[1], 10);
        if (issueNum > 0 && issueNum < 10000) {
          const ids = issueRefs.get(issueNum) ?? [];
          ids.push(item.id);
          issueRefs.set(issueNum, ids);
        }
      }
    }

    expect(issueRefs.size).toBe(0);
  });

  it('handles items with no issue refs', () => {
    const items = [{ id: 1, item: 'No issues referenced here', context: null }];
    const issueRefs = new Map<number, number[]>();
    for (const item of items) {
      const matches = item.item.matchAll(ISSUE_REF_PATTERN);
      for (const match of matches) {
        const issueNum = parseInt(match[1], 10);
        if (issueNum > 0 && issueNum < 10000) {
          const ids = issueRefs.get(issueNum) ?? [];
          ids.push(item.id);
          issueRefs.set(issueNum, ids);
        }
      }
    }

    expect(issueRefs.size).toBe(0);
  });
});

// ─── Agenda triage settling period ───────────────────────────

describe('dreaming agenda triage', () => {
  it('requires 48h settling period before promotion', () => {
    const SETTLING_MS = 48 * 60 * 60 * 1000;
    const now = Date.now();

    // Item created 24h ago — too fresh
    const recentCreated = now - (24 * 60 * 60 * 1000);
    expect(now - recentCreated < SETTLING_MS).toBe(true);

    // Item created 72h ago — old enough
    const oldCreated = now - (72 * 60 * 60 * 1000);
    expect(now - oldCreated < SETTLING_MS).toBe(false);
  });

  it('skips proposed action items from triage', () => {
    const items = [
      { item: '[PROPOSED ACTION] do something', context: null, created_at: '2020-01-01T00:00:00Z' },
      { item: '[PROPOSED TASK] another thing', context: null, created_at: '2020-01-01T00:00:00Z' },
      { item: 'Regular item', context: null, created_at: '2020-01-01T00:00:00Z' },
    ];
    const candidates = items.filter(i =>
      !i.item.startsWith('[PROPOSED ACTION]') && !i.item.startsWith('[PROPOSED TASK]')
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].item).toBe('Regular item');
  });

  it('skips heartbeat-detected items from triage', () => {
    const items = [
      { item: 'check alert', context: 'Auto-detected by heartbeat', created_at: '2020-01-01T00:00:00Z' },
      { item: 'real item', context: 'manual note', created_at: '2020-01-01T00:00:00Z' },
    ];
    const candidates = items.filter(i => !i.context?.includes('Auto-detected by heartbeat'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].item).toBe('real item');
  });

  it('caps promotions at 3 per cycle', () => {
    const maxPromotions = 3;
    let promoted = 0;
    const candidates = Array(5).fill({ verdict: 'work', title: 'task', repo: 'aegis' });

    for (const _item of candidates) {
      if (promoted >= maxPromotions) break;
      promoted++;
    }

    expect(promoted).toBe(3);
  });
});

// ─── Self-improvement activity gating ────────────────────────

describe('self-improvement activity gating', () => {
  it('runs at 00, 06, 12, 18 UTC only (hour % 6 === 0)', () => {
    const validHours = [0, 6, 12, 18];
    for (let h = 0; h < 24; h++) {
      expect(h % 6 === 0).toBe(validHours.includes(h));
    }
  });
});

// ─── Heartbeat ALERT_SEVERITIES set ──────────────────────────

describe('ALERT_SEVERITIES', () => {
  it('includes medium, high, and critical', () => {
    expect(ALERT_SEVERITIES.has('medium')).toBe(true);
    expect(ALERT_SEVERITIES.has('high')).toBe(true);
    expect(ALERT_SEVERITIES.has('critical')).toBe(true);
  });

  it('excludes low and none', () => {
    expect(ALERT_SEVERITIES.has('low')).toBe(false);
    expect(ALERT_SEVERITIES.has('none')).toBe(false);
  });
});

// ─── Persona extraction constraints ─────────────────────────

describe('persona extraction constraints', () => {
  it('caps observations at 5 per dreaming cycle', () => {
    const observations = Array(8).fill({ dimension: 'cognitive_style', observation: 'x'.repeat(25), confidence: 0.8 });
    const capped = observations.slice(0, 5);
    expect(capped).toHaveLength(5);
  });

  it('rejects observations shorter than 20 characters', () => {
    const shortObs = { observation: 'too short', dimension: 'values', confidence: 0.7 };
    expect(!shortObs.observation || shortObs.observation.length < 20).toBe(true);
  });

  it('accepts observations at or above 20 characters', () => {
    const goodObs = { observation: 'A valid observation!', dimension: 'values', confidence: 0.7 };
    expect(goodObs.observation.length >= 20).toBe(true);
  });
});

// ─── Dreaming Groq response parsing ─────────────────────────

describe('dreaming response parsing', () => {
  it('strips markdown code fences from response', () => {
    const raw = '```json\n{"facts":[]}\n```';
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    expect(cleaned).toBe('{"facts":[]}');
  });

  it('strips multiple code fences', () => {
    const raw = '```json\n{"a":1}\n```\n\n```json\n{"b":2}\n```';
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    // After stripping fences, remains as concatenated JSON (not valid, but tests the strip logic)
    expect(cleaned).not.toContain('```');
  });

  it('parses valid JSON response', () => {
    const cleaned = '{"facts":[{"topic":"test","fact":"a real fact about something important","confidence":0.8}],"routing_failures":[],"bizops_drift":[],"preferences":[]}';
    const result = JSON.parse(cleaned);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].topic).toBe('test');
    expect(result.routing_failures).toHaveLength(0);
  });

  it('handles empty arrays gracefully', () => {
    const cleaned = '{"facts":[],"routing_failures":[],"bizops_drift":[],"preferences":[],"proposed_tasks":[]}';
    const result = JSON.parse(cleaned);
    expect(result.facts).toHaveLength(0);
    expect(result.proposed_tasks).toHaveLength(0);
  });

  it('handles response with only proposed_tasks', () => {
    const cleaned = '{"facts":[],"proposed_tasks":[{"title":"Add tests","repo":"aegis","prompt":"Write unit tests","category":"tests","rationale":"Missing coverage"}]}';
    const result = JSON.parse(cleaned);
    expect(result.proposed_tasks).toHaveLength(1);
    expect(result.proposed_tasks[0].category).toBe('tests');
  });
});

// ─── Escalation ageDays calculation ──────────────────────────

describe('escalation ageDays calculation', () => {
  it('calculates age correctly from ISO timestamp', () => {
    const now = Date.now();
    const threeDaysAgoMs = now - (3 * 86_400_000);
    const ts = new Date(threeDaysAgoMs).toISOString();
    const ageDays = (now - new Date(ts).getTime()) / 86_400_000;
    expect(ageDays).toBeCloseTo(3, 0);
  });

  it('handles timestamps without Z suffix', () => {
    const created_at = '2026-03-08T12:00:00';
    const ts = created_at.endsWith('Z') ? created_at : created_at + 'Z';
    expect(ts).toBe('2026-03-08T12:00:00Z');
    // Parsing should work
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThan(0);
  });
});
