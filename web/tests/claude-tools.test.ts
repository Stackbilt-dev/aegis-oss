// Claude-tools unit tests — tool schema generation, dispatching, domain handlers
// Issue #148

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (must precede imports) ───────────────────────────

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'TestOp', possessive: "TestOp's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['TestCo LLC'], memoryTopics: ['project', 'preference'] },
    integrations: {
      bizops: { enabled: false, toolPrefix: 'bizops', fallbackUrl: '' },
      github: { enabled: true },
      brave: { enabled: true },
      goals: { enabled: true },
      email: {
        defaultProfile: 'stackbilt',
        profiles: {
          stackbilt: { from: 'aegis@stackbilt.dev', defaultTo: 'test@test.com', keyEnvField: 'resendApiKey' },
          personal: { from: 'aegis@personal.com', defaultTo: 'test@test.com', keyEnvField: 'resendApiKeyPersonal' },
        },
      },
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

vi.mock('../src/operator/prompt-builder.js', () => ({
  buildSystemPrompt: () => 'SYSTEM_PROMPT',
}));

// Mock kernel memory functions
const mockGetConversationHistory = vi.fn().mockResolvedValue([]);
const mockGetAgendaContext = vi.fn().mockResolvedValue('');
const mockGetRecentHeartbeatContext = vi.fn().mockResolvedValue('');
const mockAddAgendaItem = vi.fn().mockResolvedValue(42);
const mockResolveAgendaItem = vi.fn().mockResolvedValue(undefined);
const mockBudgetConversationHistory = vi.fn();
const mockAddGoal = vi.fn().mockResolvedValue('goal-123');
const mockGetActiveGoals = vi.fn().mockResolvedValue([]);
const mockUpdateGoalStatus = vi.fn().mockResolvedValue(undefined);
const mockGetGoalActions = vi.fn().mockResolvedValue([]);

vi.mock('../src/kernel/memory/index.js', () => ({
  getConversationHistory: (...args: unknown[]) => mockGetConversationHistory(...args),
  getAgendaContext: (...args: unknown[]) => mockGetAgendaContext(...args),
  getRecentHeartbeatContext: (...args: unknown[]) => mockGetRecentHeartbeatContext(...args),
  addAgendaItem: (...args: unknown[]) => mockAddAgendaItem(...args),
  resolveAgendaItem: (...args: unknown[]) => mockResolveAgendaItem(...args),
  budgetConversationHistory: (...args: unknown[]) => mockBudgetConversationHistory(...args),
  addGoal: (...args: unknown[]) => mockAddGoal(...args),
  getActiveGoals: (...args: unknown[]) => mockGetActiveGoals(...args),
  updateGoalStatus: (...args: unknown[]) => mockUpdateGoalStatus(...args),
  getGoalActions: (...args: unknown[]) => mockGetGoalActions(...args),
}));

const mockGetAllMemoryForContext = vi.fn().mockResolvedValue({ text: '', ids: [] });
const mockRecallMemory = vi.fn().mockResolvedValue(undefined);
const mockRecordMemory = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/kernel/memory-adapter.js', () => ({
  getAllMemoryForContext: (...args: unknown[]) => mockGetAllMemoryForContext(...args),
  recallMemory: (...args: unknown[]) => mockRecallMemory(...args),
  recordMemory: (...args: unknown[]) => mockRecordMemory(...args),
}));

const mockGetCognitiveState = vi.fn().mockResolvedValue(null);
const mockFormatCognitiveContext = vi.fn().mockReturnValue('');
vi.mock('../src/kernel/cognition.js', () => ({
  getCognitiveState: (...args: unknown[]) => mockGetCognitiveState(...args),
  formatCognitiveContext: (...args: unknown[]) => mockFormatCognitiveContext(...args),
}));

// Mock github.ts
const mockGetRepoTree = vi.fn();
const mockGetFileContent = vi.fn();
const mockGetRecentCommits = vi.fn();
const mockListIssues = vi.fn();
const mockListPullRequests = vi.fn();
const mockListOrgRepos = vi.fn();
const mockCreateIssue = vi.fn();
const mockCreateBranch = vi.fn();
const mockGetFileSha = vi.fn();
const mockUpdateFile = vi.fn();
const mockCreatePullRequest = vi.fn();
const mockCreateBlob = vi.fn();
const mockGetBaseTreeSha = vi.fn();
const mockCreateTree = vi.fn();
const mockCreateGitCommit = vi.fn();
const mockUpdateRef = vi.fn();
const mockListWorkflowRuns = vi.fn();
const mockGetCombinedStatus = vi.fn();
const mockMergePullRequest = vi.fn();
vi.mock('../src/github.js', () => ({
  getRepoTree: (...args: unknown[]) => mockGetRepoTree(...args),
  getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
  getRecentCommits: (...args: unknown[]) => mockGetRecentCommits(...args),
  listIssues: (...args: unknown[]) => mockListIssues(...args),
  listPullRequests: (...args: unknown[]) => mockListPullRequests(...args),
  listOrgRepos: (...args: unknown[]) => mockListOrgRepos(...args),
  createIssue: (...args: unknown[]) => mockCreateIssue(...args),
  createBranch: (...args: unknown[]) => mockCreateBranch(...args),
  getFileSha: (...args: unknown[]) => mockGetFileSha(...args),
  updateFile: (...args: unknown[]) => mockUpdateFile(...args),
  createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  createBlob: (...args: unknown[]) => mockCreateBlob(...args),
  getBaseTreeSha: (...args: unknown[]) => mockGetBaseTreeSha(...args),
  createTree: (...args: unknown[]) => mockCreateTree(...args),
  createGitCommit: (...args: unknown[]) => mockCreateGitCommit(...args),
  updateRef: (...args: unknown[]) => mockUpdateRef(...args),
  listWorkflowRuns: (...args: unknown[]) => mockListWorkflowRuns(...args),
  getCombinedStatus: (...args: unknown[]) => mockGetCombinedStatus(...args),
  mergePullRequest: (...args: unknown[]) => mockMergePullRequest(...args),
  resolveRepoName: (repo: string) => repo.includes('/') ? repo : `Stackbilt-dev/${repo}`,
}));

// Mock search.ts
const mockBraveSearch = vi.fn();
const mockFetchUrlText = vi.fn();
vi.mock('../src/search.js', () => ({
  braveSearch: (...args: unknown[]) => mockBraveSearch(...args),
  fetchUrlText: (...args: unknown[]) => mockFetchUrlText(...args),
}));

// Mock content pipeline
const mockRunRoundtableGeneration = vi.fn();
const mockQueueRoundtableTopic = vi.fn();
vi.mock('../src/content/index.js', () => ({
  runRoundtableGeneration: (...args: unknown[]) => mockRunRoundtableGeneration(...args),
  queueRoundtableTopic: (...args: unknown[]) => mockQueueRoundtableTopic(...args),
}));

const mockRunDispatchGeneration = vi.fn();
vi.mock('../src/dispatch.js', () => ({
  runDispatchGeneration: (...args: unknown[]) => mockRunDispatchGeneration(...args),
}));

// Mock email.ts dependency
vi.mock('../src/email.js', () => ({
  resolveEmailProfile: (profile: string, keys: Record<string, string>) => ({
    apiKey: profile === 'personal' ? keys.resendApiKeyPersonal : keys.resendApiKey,
    from: profile === 'personal' ? 'aegis@personal.com' : 'aegis@stackbilt.dev',
    defaultTo: 'test@test.com',
  }),
}));

// Mock MCP client
vi.mock('../src/mcp-client.js', () => ({
  McpClient: vi.fn(),
  McpRegistry: vi.fn(),
}));

// ─── Import after mocks ─────────────────────────────────────

const { buildContext, handleInProcessTool, resolveMcpTool, GITHUB_TOOLS } = await import('../src/claude-tools/index.js');
const { handleGithubTool } = await import('../src/claude-tools/github.js');
const { handleGoalTool, GOAL_TOOLS } = await import('../src/claude-tools/goals.js');
const { handleContentTool, ROUNDTABLE_TOOLS, DISPATCH_TOOLS } = await import('../src/claude-tools/content.js');
const { handleWebTool, WEB_TOOLS } = await import('../src/claude-tools/web.js');
const { handleEmailTool, SEND_EMAIL_TOOL } = await import('../src/claude-tools/email.js');

// ─── Test Helpers ───────────────────────────────────────────

function baseMockDb() {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  return {
    prepare(sql: string) {
      const entry = { sql, bindings: [] as unknown[] };
      queries.push(entry);
      return {
        bind(...args: unknown[]) {
          entry.bindings = args;
          return this;
        },
        async run() {
          return { meta: { changes: 1 }, success: true };
        },
        async first<T>(): Promise<T | null> {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
    _queries: queries,
  };
}

function mockDb() {
  return baseMockDb() as unknown as D1Database & { _queries: { sql: string; bindings: unknown[] }[] };
}

const resendApiKeys = { resendApiKey: 'test-resend', resendApiKeyPersonal: 'test-resend-personal' };

beforeEach(() => {
  vi.restoreAllMocks();
  // Re-stub fetch for email tests
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ id: 'email-123' }),
    text: () => Promise.resolve('ok'),
  }));
});

// ═══════════════════════════════════════════════════════════════
// resolveMcpTool()
// ═══════════════════════════════════════════════════════════════

describe('resolveMcpTool', () => {
  it('returns null when no MCP match', () => {
    const client = { toMcpToolName: vi.fn().mockReturnValue(null), toAnthropicTools: vi.fn() } as any;
    expect(resolveMcpTool('unknown_tool', client)).toBeNull();
  });

  it('resolves via single client when name matches', () => {
    const client = { toMcpToolName: vi.fn().mockReturnValue('mcp__bizops__query'), toAnthropicTools: vi.fn() } as any;
    const result = resolveMcpTool('mcp__bizops__query', client);
    expect(result).toEqual({ client, mcpName: 'mcp__bizops__query' });
  });

  it('delegates to registry when present', () => {
    const registry = { resolveClient: vi.fn().mockReturnValue({ client: 'reg-client', mcpName: 'resolved' }) } as any;
    const client = { toMcpToolName: vi.fn() } as any;
    const result = resolveMcpTool('some_tool', client, registry);
    expect(result).toEqual({ client: 'reg-client', mcpName: 'resolved' });
    expect(registry.resolveClient).toHaveBeenCalledWith('some_tool');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool schema exports
// ═══════════════════════════════════════════════════════════════

describe('tool schema exports', () => {
  it('exports all expected tool arrays', async () => {
    const github = await import('../src/claude-tools/github.js');
    const goals = await import('../src/claude-tools/goals.js');
    const content = await import('../src/claude-tools/content.js');
    const web = await import('../src/claude-tools/web.js');
    const email = await import('../src/claude-tools/email.js');

    expect(github.GITHUB_TOOLS).toHaveLength(12);
    expect(goals.GOAL_TOOLS).toHaveLength(5);
    expect(content.ROUNDTABLE_TOOLS).toHaveLength(5);
    expect(content.DISPATCH_TOOLS).toHaveLength(3);
    expect(web.WEB_TOOLS).toHaveLength(2);
    expect(email.SEND_EMAIL_TOOL.name).toBe('send_email');
  });

  it('all tool definitions have name and input_schema', async () => {
    const github = await import('../src/claude-tools/github.js');
    const allTools = [
      ...github.GITHUB_TOOLS,
      ...GOAL_TOOLS,
      ...ROUNDTABLE_TOOLS,
      ...DISPATCH_TOOLS,
      ...WEB_TOOLS,
      SEND_EMAIL_TOOL,
    ];
    for (const tool of allTools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('input_schema');
      expect(tool).toHaveProperty('description');
      expect(typeof tool.name).toBe('string');
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('no duplicate tool names across all modules', async () => {
    const github = await import('../src/claude-tools/github.js');
    const allNames = [
      ...github.GITHUB_TOOLS.map((t: any) => t.name),
      ...GOAL_TOOLS.map(t => t.name),
      ...ROUNDTABLE_TOOLS.map(t => t.name),
      ...DISPATCH_TOOLS.map(t => t.name),
      ...WEB_TOOLS.map(t => t.name),
      SEND_EMAIL_TOOL.name,
    ];
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildContext()
// ═══════════════════════════════════════════════════════════════

describe('buildContext', () => {
  it('always includes 4 core tools (memory, agenda, resolve, cc_session)', async () => {
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web' };
    const ctx = await buildContext(config);
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('record_memory_entry');
    expect(names).toContain('add_agenda_item');
    expect(names).toContain('resolve_agenda_item');
    expect(names).toContain('lookup_cc_session');
  });

  it('includes github tools when integration enabled + token present', async () => {
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web', githubToken: 'ghp_test', githubRepo: 'org/repo' };
    const ctx = await buildContext(config);
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('list_repo_files');
    expect(names).toContain('create_improvement_issue');
  });

  it('includes web tools when brave integration enabled + key present', async () => {
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web', braveApiKey: 'brave-key' };
    const ctx = await buildContext(config);
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('web_search');
    expect(names).toContain('fetch_url');
  });

  it('includes goal tools when goals integration enabled', async () => {
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web' };
    const ctx = await buildContext(config);
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('add_goal');
    expect(names).toContain('list_goals');
  });

  it('includes roundtable + dispatch tools when roundtableDb provided', async () => {
    const db = mockDb();
    const roundtableDb = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web' };
    const ctx = await buildContext(config, roundtableDb);
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('list_roundtable_drafts');
    expect(names).toContain('generate_dispatch');
  });

  it('includes email tool when resend keys present', async () => {
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web', resendApiKeys };
    const ctx = await buildContext(config);
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('send_email');
  });

  it('builds system prompt with cognitive + heartbeat + agenda + memory', async () => {
    mockGetRecentHeartbeatContext.mockResolvedValue('[heartbeat]');
    mockGetAgendaContext.mockResolvedValue('[agenda]');
    mockGetAllMemoryForContext.mockResolvedValue({ text: '[memory]', ids: ['m1'] });
    mockGetCognitiveState.mockResolvedValue({ some: 'state' });
    mockFormatCognitiveContext.mockReturnValue('[cognitive]');

    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web', memoryBinding: { recall: vi.fn().mockResolvedValue([]), store: vi.fn() } };
    const ctx = await buildContext(config);
    expect(ctx.systemPrompt).toContain('SYSTEM_PROMPT');
    expect(ctx.systemPrompt).toContain('[cognitive]');
    expect(ctx.systemPrompt).toContain('[heartbeat]');
    expect(ctx.systemPrompt).toContain('[agenda]');
    expect(ctx.systemPrompt).toContain('[memory]');
  });

  it('calls recallMemory when memory IDs present', async () => {
    mockGetAllMemoryForContext.mockResolvedValue({ text: '', ids: ['m1', 'm2'] });
    const binding = { recall: vi.fn().mockResolvedValue([]), store: vi.fn() };
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web', memoryBinding: binding };
    await buildContext(config);
    expect(mockRecallMemory).toHaveBeenCalledWith(binding, ['m1', 'm2']);
  });

  it('trims trailing user message from conversation history', async () => {
    mockGetConversationHistory.mockResolvedValue([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'last' },
    ]);
    const db = mockDb();
    const mcpClient = { listTools: vi.fn(), toAnthropicTools: vi.fn().mockReturnValue([]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, db, channel: 'web', conversationId: 'conv-1' };
    const ctx = await buildContext(config);
    expect(ctx.conversationHistory).toHaveLength(2);
    expect(ctx.conversationHistory[1].role).toBe('assistant');
  });

  it('uses registry when provided', async () => {
    const db = mockDb();
    const mcpClient = {} as any;
    const registry = { listAllTools: vi.fn().mockResolvedValue([{ name: 'mcp_tool' }]) } as any;
    const config = { apiKey: 'k', model: 'm', mcpClient, mcpRegistry: registry, db, channel: 'web' };
    const ctx = await buildContext(config);
    expect(registry.listAllTools).toHaveBeenCalled();
    const names = ctx.tools.map((t: any) => t.name);
    expect(names).toContain('mcp_tool');
  });
});

// ═══════════════════════════════════════════════════════════════
// handleInProcessTool() — core tools
// ═══════════════════════════════════════════════════════════════

describe('handleInProcessTool — core tools', () => {
  it('record_memory_entry calls recordMemory', async () => {
    const db = mockDb();
    const binding = { recall: vi.fn(), store: vi.fn() };
    const result = await handleInProcessTool(
      db, 'record_memory_entry',
      { topic: 'project', fact: 'test fact', confidence: 0.9, source: 'test' },
      undefined, undefined, undefined, undefined, undefined, binding,
    );
    expect(result).toContain('Recorded');
    expect(result).toContain('test fact');
    expect(mockRecordMemory).toHaveBeenCalledWith(binding, 'project', 'test fact', 0.9, 'test', db);
  });

  it('record_memory_entry returns error without binding', async () => {
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'record_memory_entry',
      { topic: 'project', fact: 'test', confidence: 0.9, source: 'test' },
    );
    expect(result).toContain('Error');
    expect(result).toContain('unavailable');
  });

  it('add_agenda_item calls addAgendaItem and returns ID', async () => {
    mockAddAgendaItem.mockResolvedValue(42);
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'add_agenda_item',
      { item: 'Do something', priority: 'high', context: 'test context' },
    );
    expect(result).toContain('#42');
    expect(result).toContain('Do something');
    expect(mockAddAgendaItem).toHaveBeenCalledWith(db, 'Do something', 'test context', 'high');
  });

  it('resolve_agenda_item calls resolveAgendaItem', async () => {
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'resolve_agenda_item',
      { id: 5, status: 'done' },
    );
    expect(result).toContain('#5');
    expect(result).toContain('done');
    expect(mockResolveAgendaItem).toHaveBeenCalledWith(db, 5, 'done');
  });

  it('lookup_cc_session by ID queries DB', async () => {
    const db = baseMockDb();
    // Override first() to return a session
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('id = ?')) {
        stmt.first = async () => ({ id: 'sess-1', summary: 'test session' }) as any;
      }
      return stmt;
    };
    const result = await handleInProcessTool(
      db as unknown as D1Database, 'lookup_cc_session', { id: 'sess-1' },
    );
    expect(result).toContain('sess-1');
    expect(result).toContain('test session');
  });

  it('lookup_cc_session lists recent when no ID', async () => {
    const db = baseMockDb();
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('datetime')) {
        stmt.all = async () => ({ results: [{ id: 'a' }, { id: 'b' }] }) as any;
      }
      return stmt;
    };
    const result = await handleInProcessTool(
      db as unknown as D1Database, 'lookup_cc_session', { days: 3 },
    );
    const parsed = JSON.parse(result!);
    expect(parsed).toHaveLength(2);
  });

  it('lookup_cc_session returns not-found message', async () => {
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'lookup_cc_session', { id: 'nonexistent' },
    );
    expect(result).toContain('No session found');
  });

  it('returns null for unknown tool name', async () => {
    const db = mockDb();
    const result = await handleInProcessTool(db, 'totally_unknown', {});
    expect(result).toBeNull();
  });

  it('delegates to github handler when token present', async () => {
    mockGetRepoTree.mockResolvedValue(['file1.ts', 'file2.ts']);
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'list_repo_files', {}, 'ghp_test', 'org/repo',
    );
    expect(result).toContain('file1.ts');
  });

  it('delegates to goal handler', async () => {
    mockGetActiveGoals.mockResolvedValue([{ id: 'g1', title: 'Test', schedule_hours: 6, run_count: 0 }]);
    const db = mockDb();
    const result = await handleInProcessTool(db, 'list_goals', {});
    expect(result).toContain('Test');
  });

  it('delegates to web handler when braveApiKey present', async () => {
    mockBraveSearch.mockResolvedValue([{ title: 'Result', url: 'https://example.com', snippet: 'test' }]);
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'web_search', { query: 'test' }, undefined, undefined, 'brave-key',
    );
    expect(result).toContain('Result');
  });

  it('delegates to email handler', async () => {
    const db = mockDb();
    const result = await handleInProcessTool(
      db, 'send_email',
      { to: 'test@test.com', subject: 'Hi', body: 'Hello' },
      undefined, undefined, undefined, undefined, undefined, undefined, resendApiKeys,
    );
    expect(result).toContain('Email sent');
  });

  it('delegates to content handler when roundtableDb present', async () => {
    const db = mockDb();
    const roundtableDb = baseMockDb();
    const origPrepare = roundtableDb.prepare.bind(roundtableDb);
    roundtableDb.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      stmt.all = async () => ({
        results: [{ slug: 'test-slug', title: 'Test Post', created_at: '2026-01-01' }],
      }) as any;
      return stmt;
    };
    const result = await handleInProcessTool(
      db, 'list_roundtable_drafts', {},
      undefined, undefined, undefined, roundtableDb as unknown as D1Database,
    );
    expect(result).toContain('Test Post');
  });
});

// ═══════════════════════════════════════════════════════════════
// handleGithubTool()
// ═══════════════════════════════════════════════════════════════

describe('handleGithubTool', () => {
  const db = mockDb();
  const token = 'ghp_test';
  const repo = 'Stackbilt-dev/aegis';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list_org_repos returns formatted list', async () => {
    mockListOrgRepos.mockResolvedValue([
      { name: 'aegis', visibility: 'private', description: 'AI agent', language: 'TypeScript', updated_at: '2026-03-01T00:00:00Z', url: 'https://github.com/org/aegis' },
    ]);
    const result = await handleGithubTool(db, 'list_org_repos', {}, token, repo);
    expect(result).toContain('aegis');
    expect(result).toContain('private');
    expect(result).toContain('AI agent');
  });

  it('list_org_repos returns empty message', async () => {
    mockListOrgRepos.mockResolvedValue([]);
    const result = await handleGithubTool(db, 'list_org_repos', { org: 'empty-org' }, token, repo);
    expect(result).toContain('No repositories');
  });

  it('list_repo_files returns tree', async () => {
    mockGetRepoTree.mockResolvedValue(['src/index.ts', 'README.md']);
    const result = await handleGithubTool(db, 'list_repo_files', {}, token, repo);
    expect(result).toContain('src/index.ts');
    expect(result).toContain('2 files');
  });

  it('read_repo_file returns content', async () => {
    mockGetFileContent.mockResolvedValue('console.log("hello")');
    const result = await handleGithubTool(db, 'read_repo_file', { path: 'src/index.ts' }, token, repo);
    expect(result).toContain('console.log');
    expect(result).toContain('File: src/index.ts');
  });

  it('read_repo_file truncates at 8000 chars', async () => {
    mockGetFileContent.mockResolvedValue('x'.repeat(9000));
    const result = await handleGithubTool(db, 'read_repo_file', { path: 'big.ts' }, token, repo);
    expect(result).toContain('truncated at 8000');
  });

  it('read_repo_file handles 404', async () => {
    mockGetFileContent.mockRejectedValue(new Error('404 Not Found'));
    const result = await handleGithubTool(db, 'read_repo_file', { path: 'nope.ts' }, token, repo);
    expect(result).toContain('File not found');
    expect(result).toContain('list_repo_files');
  });

  it('read_repo_file re-throws non-404 errors', async () => {
    mockGetFileContent.mockRejectedValue(new Error('500 Server Error'));
    await expect(handleGithubTool(db, 'read_repo_file', { path: 'fail.ts' }, token, repo)).rejects.toThrow('500');
  });

  it('get_repo_commits returns formatted commits', async () => {
    mockGetRecentCommits.mockResolvedValue([
      { sha: 'abc12345def', message: 'fix bug', author: 'kurt', date: '2026-03-01T00:00:00Z' },
    ]);
    const result = await handleGithubTool(db, 'get_repo_commits', { limit: 5 }, token, repo);
    expect(result).toContain('abc12345');
    expect(result).toContain('fix bug');
  });

  it('get_repo_commits caps limit at 20', async () => {
    mockGetRecentCommits.mockResolvedValue([]);
    await handleGithubTool(db, 'get_repo_commits', { limit: 50 }, token, repo);
    expect(mockGetRecentCommits).toHaveBeenCalledWith(token, repo, 20);
  });

  it('get_repo_issues returns formatted issues', async () => {
    mockListIssues.mockResolvedValue([
      { number: 148, title: 'test coverage', state: 'open', labels: ['tests'], url: 'https://github.com/org/repo/issues/148' },
    ]);
    const result = await handleGithubTool(db, 'get_repo_issues', {}, token, repo);
    expect(result).toContain('#148');
    expect(result).toContain('test coverage');
  });

  it('get_repo_issues returns empty message', async () => {
    mockListIssues.mockResolvedValue([]);
    const result = await handleGithubTool(db, 'get_repo_issues', {}, token, repo);
    expect(result).toContain('No issues');
  });

  it('get_repo_prs returns formatted PRs', async () => {
    mockListPullRequests.mockResolvedValue([
      { number: 10, title: 'fix', state: 'open', merged: false, head: 'feat', base: 'main', url: 'https://github.com/org/repo/pull/10' },
    ]);
    const result = await handleGithubTool(db, 'get_repo_prs', {}, token, repo);
    expect(result).toContain('#10');
    expect(result).toContain('fix');
  });

  it('get_repo_prs shows merged status', async () => {
    mockListPullRequests.mockResolvedValue([
      { number: 5, title: 'merged PR', state: 'closed', merged: true, head: 'feat', base: 'main', url: 'url' },
    ]);
    const result = await handleGithubTool(db, 'get_repo_prs', { state: 'closed' }, token, repo);
    expect(result).toContain('merged');
  });

  it('get_repo_prs returns empty message', async () => {
    mockListPullRequests.mockResolvedValue([]);
    const result = await handleGithubTool(db, 'get_repo_prs', {}, token, repo);
    expect(result).toContain('No pull requests');
  });

  it('get_ci_status returns combined status + actions', async () => {
    mockGetCombinedStatus.mockResolvedValue({
      state: 'success', total: 1,
      statuses: [{ context: 'ci/test', state: 'success', description: 'passed' }],
    });
    mockListWorkflowRuns.mockResolvedValue([
      { name: 'CI', conclusion: 'success', status: 'completed', event: 'push', created_at: '2026-03-01T00:00:00Z', url: 'url' },
    ]);
    const result = await handleGithubTool(db, 'get_ci_status', {}, token, repo);
    expect(result).toContain('success');
    expect(result).toContain('ci/test');
    expect(result).toContain('CI');
  });

  it('get_ci_status handles no checks/runs', async () => {
    mockGetCombinedStatus.mockResolvedValue({ state: 'pending', total: 0, statuses: [] });
    mockListWorkflowRuns.mockResolvedValue([]);
    const result = await handleGithubTool(db, 'get_ci_status', { ref: 'dev' }, token, repo);
    expect(result).toContain('no status checks');
    expect(result).toContain('no workflow runs');
  });

  it('create_improvement_issue creates issue', async () => {
    mockCreateIssue.mockResolvedValue({ number: 200, url: 'https://github.com/org/repo/issues/200' });
    const result = await handleGithubTool(db, 'create_improvement_issue', {
      title: 'New issue', body: 'Body text', priority: 'medium', labels: ['bug'],
    }, token, repo);
    expect(result).toContain('#200');
    expect(mockCreateIssue).toHaveBeenCalledWith(token, repo, 'New issue', 'Body text', ['bug']);
  });

  it('create_improvement_issue uses default labels', async () => {
    mockCreateIssue.mockResolvedValue({ number: 201, url: 'url' });
    await handleGithubTool(db, 'create_improvement_issue', {
      title: 'Test', body: 'Body', priority: 'low',
    }, token, repo);
    expect(mockCreateIssue).toHaveBeenCalledWith(token, repo, 'Test', 'Body', ['self-improvement']);
  });

  it('create_improvement_pr creates branch + file + PR', async () => {
    mockGetRecentCommits.mockResolvedValue([{ sha: 'abc123def456' }]);
    mockGetFileSha.mockResolvedValue('old-sha');
    mockCreatePullRequest.mockResolvedValue({ number: 50, url: 'https://github.com/pr/50' });

    const result = await handleGithubTool(db, 'create_improvement_pr', {
      title: 'PR title', body: 'PR body', file_path: 'src/fix.ts',
      new_content: 'fixed code', branch_name: 'aegis/fix', commit_message: 'fix: stuff',
    }, token, repo);
    expect(result).toContain('PR #50');
    expect(mockCreateBranch).toHaveBeenCalledWith(token, repo, 'aegis/fix', 'abc123def456');
    expect(mockUpdateFile).toHaveBeenCalled();
  });

  it('create_multi_file_pr creates atomic commit', async () => {
    mockGetRecentCommits.mockResolvedValue([{ sha: 'head123' }]);
    mockGetBaseTreeSha.mockResolvedValue('tree-sha');
    mockCreateBlob.mockResolvedValue('blob-sha');
    mockCreateTree.mockResolvedValue('new-tree-sha');
    mockCreateGitCommit.mockResolvedValue('commit-sha');
    mockCreatePullRequest.mockResolvedValue({ number: 60, url: 'https://github.com/pr/60' });

    const result = await handleGithubTool(db, 'create_multi_file_pr', {
      title: 'Multi', body: 'Body', branch_name: 'aegis/multi', commit_message: 'multi change',
      files: [{ path: 'a.ts', content: 'a' }, { path: 'b.ts', content: 'b' }],
    }, token, repo);
    expect(result).toContain('PR #60');
    expect(result).toContain('2');
    expect(mockCreateBlob).toHaveBeenCalledTimes(2);
    expect(mockUpdateRef).toHaveBeenCalledWith(token, repo, 'heads/aegis/multi', 'commit-sha');
  });

  it('create_multi_file_pr rejects empty files', async () => {
    const result = await handleGithubTool(db, 'create_multi_file_pr', {
      title: 'T', body: 'B', branch_name: 'b', commit_message: 'c', files: [],
    }, token, repo);
    expect(result).toContain('empty');
  });

  it('create_multi_file_pr rejects >20 files', async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.ts`, content: 'x' }));
    const result = await handleGithubTool(db, 'create_multi_file_pr', {
      title: 'T', body: 'B', branch_name: 'b', commit_message: 'c', files,
    }, token, repo);
    expect(result).toContain('too many');
  });

  it('merge_pull_request merges and resolves agenda', async () => {
    mockMergePullRequest.mockResolvedValue({ merged: true, sha: 'merge-sha-123', message: 'ok' });
    const mergeDb = baseMockDb();
    const result = await handleGithubTool(
      mergeDb as unknown as D1Database, 'merge_pull_request',
      { pull_number: 42 }, token, repo,
    );
    expect(result).toContain('Merged PR #42');
    expect(result).toContain('squash');
    // Check agenda auto-resolve query
    const agendaQuery = mergeDb._queries.find(q => q.sql.includes('UPDATE agent_agenda'));
    expect(agendaQuery).toBeDefined();
    expect(agendaQuery!.bindings[0]).toContain('PR #42');
  });

  it('merge_pull_request reports failure', async () => {
    mockMergePullRequest.mockResolvedValue({ merged: false, sha: '', message: 'not ready' });
    const result = await handleGithubTool(db, 'merge_pull_request', { pull_number: 99 }, token, repo);
    expect(result).toContain('Failed');
    expect(result).toContain('not ready');
  });

  it('trigger_worker_deploy creates agenda item', async () => {
    mockGetRecentCommits.mockResolvedValue([{ sha: 'deploy-sha', message: 'ship it' }]);
    mockAddAgendaItem.mockResolvedValue(100);
    const result = await handleGithubTool(db, 'trigger_worker_deploy', {
      reason: 'CI green', pr_numbers: [42, 43],
    }, token, repo);
    expect(result).toContain('Deployment proposed');
    expect(result).toContain('#100');
    expect(mockAddAgendaItem).toHaveBeenCalled();
    const [, item, ctx] = mockAddAgendaItem.mock.calls[0];
    expect(item).toContain('PROPOSED ACTION');
    expect(ctx).toContain('#42');
  });

  it('returns null for unknown tool', async () => {
    const result = await handleGithubTool(db, 'nonexistent_tool', {}, token, repo);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// handleGoalTool()
// ═══════════════════════════════════════════════════════════════

describe('handleGoalTool', () => {
  const db = mockDb();

  beforeEach(() => vi.clearAllMocks());

  it('add_goal creates goal', async () => {
    mockAddGoal.mockResolvedValue('goal-abc');
    const result = await handleGoalTool(db, 'add_goal', { title: 'Monitor BOI', schedule_hours: 12 });
    expect(result).toContain('Monitor BOI');
    expect(result).toContain('goal-abc');
    expect(result).toContain('12h');
    expect(mockAddGoal).toHaveBeenCalledWith(db, 'Monitor BOI', undefined, 12);
  });

  it('add_goal uses default 6h schedule', async () => {
    mockAddGoal.mockResolvedValue('goal-def');
    await handleGoalTool(db, 'add_goal', { title: 'Test' });
    expect(mockAddGoal).toHaveBeenCalledWith(db, 'Test', undefined, 6);
  });

  it('list_goals returns formatted list', async () => {
    mockGetActiveGoals.mockResolvedValue([
      { id: 'g1', title: 'Goal A', schedule_hours: 6, run_count: 3, next_run_at: '2026-03-10T12:00:00Z', description: 'Desc A' },
      { id: 'g2', title: 'Goal B', schedule_hours: 12, run_count: 0, next_run_at: null, description: null },
    ]);
    const result = await handleGoalTool(db, 'list_goals', {});
    expect(result).toContain('Goal A');
    expect(result).toContain('Goal B');
    expect(result).toContain('Desc A');
    expect(result).toContain('run 3x');
  });

  it('list_goals returns empty message', async () => {
    mockGetActiveGoals.mockResolvedValue([]);
    const result = await handleGoalTool(db, 'list_goals', {});
    expect(result).toContain('No active goals');
  });

  it('update_goal_status updates status', async () => {
    const result = await handleGoalTool(db, 'update_goal_status', { id: 'g1', status: 'paused' });
    expect(result).toContain('g1');
    expect(result).toContain('paused');
    expect(mockUpdateGoalStatus).toHaveBeenCalledWith(db, 'g1', 'paused');
  });

  it('list_goal_actions returns formatted actions', async () => {
    mockGetGoalActions.mockResolvedValue([
      { created_at: '2026-03-10T10:30:00Z', action_type: 'propose', auto_executed: false, goal_id: 'g1', description: 'Proposed something important' },
    ]);
    const result = await handleGoalTool(db, 'list_goal_actions', { limit: 5 });
    expect(result).toContain('PROPOSE');
    expect(result).toContain('Proposed something');
    expect(mockGetGoalActions).toHaveBeenCalledWith(db, undefined, 5);
  });

  it('list_goal_actions returns empty message', async () => {
    mockGetGoalActions.mockResolvedValue([]);
    const result = await handleGoalTool(db, 'list_goal_actions', {});
    expect(result).toContain('No goal actions');
  });

  it('upgrade_goal_authority updates DB', async () => {
    const goalDb = baseMockDb();
    const result = await handleGoalTool(goalDb as unknown as D1Database, 'upgrade_goal_authority', {
      id: 'g1', authority_level: 'auto_low',
    });
    expect(result).toContain('auto_low');
    const q = goalDb._queries[0];
    expect(q.sql).toContain('UPDATE agent_goals');
    expect(q.bindings).toEqual(['auto_low', 'g1']);
  });

  it('returns null for unknown tool', async () => {
    const result = await handleGoalTool(db, 'not_a_goal_tool', {});
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// handleContentTool()
// ═══════════════════════════════════════════════════════════════

describe('handleContentTool', () => {
  const aegisDb = mockDb();
  const anthropicConfig = { apiKey: 'key', model: 'model', baseUrl: 'https://api.anthropic.com' };

  function contentDb(overrides?: { roundtables?: any[]; topics?: any[]; dispatches?: any[]; changes?: number }) {
    const db = baseMockDb();
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('roundtables') && sql.includes('SELECT')) {
        stmt.all = async () => ({ results: overrides?.roundtables ?? [] }) as any;
      }
      if (sql.includes('topic_queue')) {
        stmt.all = async () => ({ results: overrides?.topics ?? [] }) as any;
      }
      if (sql.includes('dispatches') && sql.includes('SELECT')) {
        stmt.all = async () => ({ results: overrides?.dispatches ?? [] }) as any;
      }
      if (sql.includes('UPDATE')) {
        stmt.run = async () => ({ meta: { changes: overrides?.changes ?? 1 }, success: true }) as any;
      }
      return stmt;
    };
    return db as unknown as D1Database;
  }

  beforeEach(() => vi.clearAllMocks());

  it('list_roundtable_drafts returns formatted drafts', async () => {
    const rdb = contentDb({ roundtables: [{ slug: 'ai-agents', title: 'AI Agents', created_at: '2026-03-01' }] });
    const result = await handleContentTool('list_roundtable_drafts', {}, rdb, aegisDb);
    expect(result).toContain('AI Agents');
    expect(result).toContain('ai-agents');
    expect(result).toContain('preview');
  });

  it('list_roundtable_drafts returns empty message', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('list_roundtable_drafts', {}, rdb, aegisDb);
    expect(result).toContain('No draft roundtables');
  });

  it('publish_roundtable publishes slug', async () => {
    const rdb = contentDb({ changes: 1 });
    const result = await handleContentTool('publish_roundtable', { slug: 'ai-agents' }, rdb, aegisDb);
    expect(result).toContain('Published');
    expect(result).toContain('ai-agents');
  });

  it('publish_roundtable reports not found', async () => {
    const rdb = contentDb({ changes: 0 });
    const result = await handleContentTool('publish_roundtable', { slug: 'nope' }, rdb, aegisDb);
    expect(result).toContain('No draft roundtable');
  });

  it('list_roundtable_topics returns topics', async () => {
    const rdb = contentDb({
      topics: [{ topic: 'Edge computing', cta_product: 'edgestack', status: 'queued', source: 'aegis_auto' }],
    });
    const result = await handleContentTool('list_roundtable_topics', {}, rdb, aegisDb);
    expect(result).toContain('Edge computing');
    expect(result).toContain('edgestack');
  });

  it('list_roundtable_topics returns empty message', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('list_roundtable_topics', { status: 'used' }, rdb, aegisDb);
    expect(result).toContain('No topics');
  });

  it('generate_roundtable calls pipeline', async () => {
    mockRunRoundtableGeneration.mockResolvedValue({ title: 'Generated Post', slug: 'gen-post', cost: 0.04 });
    const rdb = contentDb();
    const result = await handleContentTool('generate_roundtable', {}, rdb, aegisDb, anthropicConfig);
    expect(result).toContain('Generated Post');
    expect(result).toContain('gen-post');
    expect(result).toContain('draft');
    expect(mockRunRoundtableGeneration).toHaveBeenCalledWith(rdb, aegisDb, 'key', 'model', 'https://api.anthropic.com');
  });

  it('generate_roundtable returns error without config', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('generate_roundtable', {}, rdb, aegisDb);
    expect(result).toContain('Error');
    expect(result).toContain('config not available');
  });

  it('queue_roundtable_topic queues topic', async () => {
    mockQueueRoundtableTopic.mockResolvedValue(99);
    const rdb = contentDb();
    const result = await handleContentTool('queue_roundtable_topic', {
      topic: 'Workers AI perf', context: 'Observed latency', cta_product: 'edgestack',
    }, rdb, aegisDb);
    expect(result).toContain('Workers AI perf');
    expect(result).toContain('edgestack');
    expect(mockQueueRoundtableTopic).toHaveBeenCalledWith(rdb, 'Workers AI perf', 'Observed latency', 'edgestack', 'aegis_auto');
  });

  it('queue_roundtable_topic requires topic', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('queue_roundtable_topic', {}, rdb, aegisDb);
    expect(result).toContain('Error');
    expect(result).toContain('required');
  });

  it('list_dispatch_drafts returns formatted dispatches', async () => {
    const rdb = contentDb({
      dispatches: [{ slug: 'd-1', title: 'Dispatch 1', paper_title: 'Paper', created_at: '2026-03-05' }],
    });
    const result = await handleContentTool('list_dispatch_drafts', {}, rdb, aegisDb);
    expect(result).toContain('Dispatch 1');
    expect(result).toContain('Paper');
  });

  it('list_dispatch_drafts returns empty message', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('list_dispatch_drafts', {}, rdb, aegisDb);
    expect(result).toContain('No draft dispatches');
  });

  it('publish_dispatch publishes slug', async () => {
    const rdb = contentDb({ changes: 1 });
    const result = await handleContentTool('publish_dispatch', { slug: 'd-1' }, rdb, aegisDb);
    expect(result).toContain('Published');
  });

  it('publish_dispatch reports not found', async () => {
    const rdb = contentDb({ changes: 0 });
    const result = await handleContentTool('publish_dispatch', { slug: 'nope' }, rdb, aegisDb);
    expect(result).toContain('No draft dispatch');
  });

  it('generate_dispatch calls pipeline', async () => {
    mockRunDispatchGeneration.mockResolvedValue({ title: 'Gen Dispatch', slug: 'gen-d', cost: 0.04 });
    const rdb = contentDb();
    const result = await handleContentTool('generate_dispatch', {}, rdb, aegisDb, anthropicConfig, 'ghp_t', 'org/repo');
    expect(result).toContain('Gen Dispatch');
    expect(mockRunDispatchGeneration).toHaveBeenCalledWith(rdb, aegisDb, 'key', 'model', 'https://api.anthropic.com', 'ghp_t', 'org/repo');
  });

  it('generate_dispatch returns error without config', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('generate_dispatch', {}, rdb, aegisDb);
    expect(result).toContain('Error');
  });

  it('returns null for unknown tool', async () => {
    const rdb = contentDb();
    const result = await handleContentTool('not_content_tool', {}, rdb, aegisDb);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// handleWebTool()
// ═══════════════════════════════════════════════════════════════

describe('handleWebTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('web_search returns formatted results', async () => {
    mockBraveSearch.mockResolvedValue([
      { title: 'Result 1', url: 'https://example.com', snippet: 'First result' },
      { title: 'Result 2', url: 'https://other.com', snippet: 'Second result' },
    ]);
    const result = await handleWebTool('web_search', { query: 'test query', max_results: 2 }, 'brave-key');
    expect(result).toContain('Result 1');
    expect(result).toContain('Result 2');
    expect(result).toContain('https://example.com');
    expect(mockBraveSearch).toHaveBeenCalledWith('brave-key', 'test query', 2);
  });

  it('web_search caps max_results at 10', async () => {
    mockBraveSearch.mockResolvedValue([]);
    await handleWebTool('web_search', { query: 'test', max_results: 50 }, 'key');
    expect(mockBraveSearch).toHaveBeenCalledWith('key', 'test', 10);
  });

  it('web_search defaults max_results to 5', async () => {
    mockBraveSearch.mockResolvedValue([]);
    await handleWebTool('web_search', { query: 'test' }, 'key');
    expect(mockBraveSearch).toHaveBeenCalledWith('key', 'test', 5);
  });

  it('web_search returns no-results message', async () => {
    mockBraveSearch.mockResolvedValue([]);
    const result = await handleWebTool('web_search', { query: 'obscure query' }, 'key');
    expect(result).toContain('No results');
    expect(result).toContain('obscure query');
  });

  it('fetch_url returns content', async () => {
    mockFetchUrlText.mockResolvedValue('Page content here');
    const result = await handleWebTool('fetch_url', { url: 'https://example.com' }, 'key');
    expect(result).toContain('https://example.com');
    expect(result).toContain('Page content here');
    expect(mockFetchUrlText).toHaveBeenCalledWith('https://example.com');
  });

  it('returns null for unknown tool', async () => {
    const result = await handleWebTool('not_web_tool', {}, 'key');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// handleEmailTool()
// ═══════════════════════════════════════════════════════════════

describe('handleEmailTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'email-123' }),
      text: () => Promise.resolve('ok'),
    }));
  });

  it('sends email and returns confirmation', async () => {
    const result = await handleEmailTool('send_email', {
      to: 'user@test.com', subject: 'Hello', body: 'Hi there',
    }, resendApiKeys);
    expect(result).toContain('Email sent');
    expect(result).toContain('user@test.com');
    expect(result).toContain('Hello');
    expect(result).toContain('email-123');

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init!.body as string);
    expect(body.to).toEqual(['user@test.com']);
    expect(body.subject).toBe('Hello');
  });

  it('wraps plain text in HTML', async () => {
    await handleEmailTool('send_email', {
      to: 'x@x.com', subject: 'S', body: 'Line one\nLine two',
    }, resendApiKeys);

    const fetchMock = vi.mocked(fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.html).toContain('<p');
    expect(body.html).toContain('Line one');
  });

  it('passes raw HTML through', async () => {
    await handleEmailTool('send_email', {
      to: 'x@x.com', subject: 'S', body: '<h1>Header</h1>',
    }, resendApiKeys);

    const fetchMock = vi.mocked(fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.html).toBe('<h1>Header</h1>');
  });

  it('uses personal profile when specified', async () => {
    await handleEmailTool('send_email', {
      to: 'x@x.com', subject: 'S', body: 'Hi', profile: 'personal',
    }, resendApiKeys);

    const fetchMock = vi.mocked(fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.from).toBe('aegis@personal.com');
    const auth = (fetchMock.mock.calls[0][1]!.headers as Record<string, string>)['Authorization'];
    expect(auth).toContain('test-resend-personal');
  });

  it('reports API failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Validation error'),
    }));
    const result = await handleEmailTool('send_email', {
      to: 'x@x.com', subject: 'S', body: 'Hi',
    }, resendApiKeys);
    expect(result).toContain('failed');
    expect(result).toContain('422');
    expect(result).toContain('Validation error');
  });

  it('returns null for non-email tool', async () => {
    const result = await handleEmailTool('not_email', {}, resendApiKeys);
    expect(result).toBeNull();
  });
});
