// Email utility tests — profile resolution, send functions
// Mocks operator config and global fetch (Resend API)

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'AEGIS' },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: [], memoryTopics: [] },
    integrations: {
      bizops: { enabled: false, toolPrefix: '', fallbackUrl: '' },
      github: { enabled: false },
      brave: { enabled: false },
      email: {
        profiles: {
          primary: { from: 'agent@example.com', defaultTo: 'admin@example.com', keyEnvField: 'resendApiKey' },
          personal: { from: 'aegis@personal.example.com', defaultTo: 'user@personal.example.com', keyEnvField: 'resendApiKeyPersonal' },
        },
        defaultProfile: 'primary',
      },
      goals: { enabled: false },
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

const {
  resolveEmailProfile,
  sendHeartbeatAlert,
  sendOperatorLog,
  sendMorningBriefing,
  sendMemoryReflection,
  sendStaleAgendaAlert,
} = await import('../src/email.js');

const apiKeys = { resendApiKey: 'rk_test_primary', resendApiKeyPersonal: 'rk_test_personal' };

describe('resolveEmailProfile', () => {
  it('resolves primary profile', () => {
    const sender = resolveEmailProfile('primary', apiKeys);
    expect(sender.apiKey).toBe('rk_test_primary');
    expect(sender.from).toBe('agent@example.com');
    expect(sender.defaultTo).toBe('admin@example.com');
  });

  it('resolves personal profile', () => {
    const sender = resolveEmailProfile('personal', apiKeys);
    expect(sender.apiKey).toBe('rk_test_personal');
    expect(sender.from).toBe('aegis@personal.example.com');
  });

  it('throws on unknown profile', () => {
    expect(() => resolveEmailProfile('unknown' as any, apiKeys)).toThrow('Unknown email profile');
  });

  it('throws on missing API key', () => {
    expect(() => resolveEmailProfile('primary', { resendApiKey: '', resendApiKeyPersonal: '' })).toThrow('Missing API key');
  });
});

describe('email send functions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  it('sendHeartbeatAlert calls Resend API with correct subject', async () => {
    await sendHeartbeatAlert(
      apiKeys,
      'high',
      'Test summary',
      [{ name: 'test_check', status: 'alert' as const, detail: 'failed' }],
    );

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init!.body as string);
    expect(body.subject).toContain('HIGH');
    expect(body.subject).toContain('Test summary');
    expect(body.from).toBe('agent@example.com');
  });

  it('sendHeartbeatAlert includes INFRA badge for worker_ checks', async () => {
    await sendHeartbeatAlert(
      apiKeys,
      'high',
      'Infra issue',
      [{ name: 'worker_errors', status: 'alert' as const, detail: 'high error rate' }],
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.html).toContain('INFRA');
  });

  it('sendHeartbeatAlert includes agenda items', async () => {
    await sendHeartbeatAlert(
      apiKeys,
      'medium',
      'Some issues',
      [{ name: 'check', status: 'warn' as const, detail: 'slow' }],
      [{ id: 1, item: 'Fix thing', priority: 'high', context: 'Urgent' }],
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.html).toContain('Fix thing');
    expect(body.html).toContain('Urgent');
  });

  it('sendOperatorLog sends with worklog subject', async () => {
    await sendOperatorLog(
      apiKeys,
      'admin@example.com',
      '## Summary\n\nShipped features.',
      { episodes: 10, goalsRun: 3, totalCost: 0.1234 },
      '2026-03-10',
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.subject).toContain('Worklog');
    expect(body.html).toContain('10 dispatches');
    expect(body.html).toContain('$0.1234');
  });

  it('sendOperatorLog includes task stats when provided', async () => {
    await sendOperatorLog(
      apiKeys,
      'admin@example.com',
      'Log content',
      { episodes: 5, goalsRun: 2, tasksCompleted: 3, tasksFailed: 1, prsCreated: 2, totalCost: 0.05 },
      '2026-03-10',
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.html).toContain('3 tasks shipped');
    expect(body.html).toContain('1 failed');
    expect(body.html).toContain('2 PRs');
  });

  it('sendMorningBriefing skips send when no tasks', async () => {
    await sendMorningBriefing(apiKeys, [], [], []);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sendMorningBriefing sends with failed tasks in subject', async () => {
    const task = {
      id: 'task-1',
      title: 'Fix bug',
      repo: 'aegis',
      status: 'failed',
      authority: 'auto_safe',
      category: 'bugfix',
      exit_code: 1,
      error: 'Timeout',
      result: null,
      completed_at: '2026-03-10',
    };

    await sendMorningBriefing(apiKeys, [], [task], []);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.subject).toContain('1 failed');
    expect(body.html).toContain('Fix bug');
    expect(body.html).toContain('Timeout');
  });

  it('sendMorningBriefing shows proposed tasks', async () => {
    const proposed = {
      id: 'task-2',
      title: 'Add feature',
      repo: 'aegis',
      status: 'pending',
      authority: 'proposed',
      category: 'feature',
      exit_code: null,
      error: null,
      result: null,
      completed_at: null,
    };

    await sendMorningBriefing(apiKeys, [], [], [proposed]);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.html).toContain('Awaiting approval');
    expect(body.html).toContain('Add feature');
  });

  it('sendMemoryReflection includes topic pills and memory count', async () => {
    await sendMemoryReflection(
      apiKeys,
      'admin@example.com',
      '## Reflection\n\nI learned things.',
      42,
      ['architecture', 'testing'],
      '2026-03-10',
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.subject).toContain('Weekly Reflection');
    expect(body.html).toContain('42 memories examined');
    expect(body.html).toContain('architecture');
    expect(body.html).toContain('testing');
  });

  it('sendStaleAgendaAlert includes stale item details', async () => {
    await sendStaleAgendaAlert(
      apiKeys,
      [{ id: 5, item: 'Fix critical bug', context: 'Affects users', ageDays: 3.5 }],
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.subject).toContain('ESCALATION');
    expect(body.html).toContain('Fix critical bug');
    expect(body.html).toContain('3d stale');
  });

  it('uses explicit profile when provided', async () => {
    await sendHeartbeatAlert(
      apiKeys,
      'low',
      'Test',
      [{ name: 'check', status: 'warn' as const, detail: 'slow' }],
      [],
      undefined,
      'personal',
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]!.body) as string);
    expect(body.from).toBe('aegis@personal.example.com');
  });

  it('throws on Resend API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: vi.fn().mockResolvedValue('Invalid email'),
    }));

    await expect(sendHeartbeatAlert(
      apiKeys,
      'high',
      'Test',
      [{ name: 'check', status: 'alert' as const, detail: 'fail' }],
    )).rejects.toThrow('Resend error 422');
  });
});
