// MCP subsystem tests — protocol compliance, tool routing, handler coverage, schema validation
// Issue #149

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────

// Mock operator config (must be before handler/tools imports)
vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'TestOp', possessive: "TestOp's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['TestCo LLC'], memoryTopics: ['project', 'preference'] },
    integrations: {
      bizops: { enabled: false, toolPrefix: 'bizops', fallbackUrl: '' },
      github: { enabled: false },
      brave: { enabled: false },
      goals: { enabled: false },
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

// Mock kernel dispatch
const mockDispatch = vi.fn();
const mockCreateIntent = vi.fn();
vi.mock('../src/kernel/dispatch.js', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    dispatch: (...args: unknown[]) => mockDispatch(...args),
    createIntent: (...args: unknown[]) => mockCreateIntent(...args),
  };
});

// Mock memory functions
const mockGetAllProcedures = vi.fn();
const mockGetActiveAgendaItems = vi.fn();
const mockAddAgendaItem = vi.fn();
const mockResolveAgendaItem = vi.fn();
const mockAddGoal = vi.fn();
const mockUpdateGoalStatus = vi.fn();
const mockGetActiveGoals = vi.fn();
vi.mock('../src/kernel/memory/index.js', () => ({
  getAllProcedures: (...args: unknown[]) => mockGetAllProcedures(...args),
  getActiveAgendaItems: (...args: unknown[]) => mockGetActiveAgendaItems(...args),
  addAgendaItem: (...args: unknown[]) => mockAddAgendaItem(...args),
  resolveAgendaItem: (...args: unknown[]) => mockResolveAgendaItem(...args),
  addGoal: (...args: unknown[]) => mockAddGoal(...args),
  updateGoalStatus: (...args: unknown[]) => mockUpdateGoalStatus(...args),
  getActiveGoals: (...args: unknown[]) => mockGetActiveGoals(...args),
}));

const mockGetMemoryEntries = vi.fn();
const mockRecordMemory = vi.fn();
vi.mock('../src/kernel/memory-adapter.js', () => ({
  getMemoryEntries: (...args: unknown[]) => mockGetMemoryEntries(...args),
  recordMemory: (...args: unknown[]) => mockRecordMemory(...args),
}));

// Import after mocks
const { handleMcpRequest } = await import('../src/mcp/server.js');
const { TOOLS } = await import('../src/mcp/tools.js');
const handlers = await import('../src/mcp/handlers.js');

// ─── Test Helpers ────────────────────────────────────────────

function createMockDb(overrides?: Partial<ReturnType<typeof baseMockDb>>) {
  return { ...baseMockDb(), ...overrides };
}

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

function makeEnv(dbOverrides?: Record<string, unknown>) {
  const db = createMockDb(dbOverrides);
  return {
    db: db as unknown as D1Database,
    anthropicApiKey: 'test-key',
    claudeModel: 'test-model',
    opusModel: 'test-opus',
    gptOssModel: 'test-gpt',
    groqApiKey: 'test-groq',
    groqModel: 'test-groq-model',
    groqResponseModel: 'test-groq-resp',
    groqGptOssModel: 'test-groq-gpt',
    bizopsFetcher: {} as Fetcher,
    bizopsToken: 'test-token',
    resendApiKey: 'test-resend',
    resendApiKeyPersonal: 'test-resend-personal',
    githubToken: 'test-github',
    githubRepo: 'test-repo',
    memoryBinding: {
      recall: vi.fn().mockResolvedValue([]),
      store: vi.fn().mockResolvedValue({ stored: 0 }),
    },
    roundtableDb: createMockDb() as unknown as D1Database,
    _mockDb: db,
  };
}

function jsonRpcRequest(method: string, params?: Record<string, unknown>, id: string | number = 1) {
  return new Request('https://test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

function jsonRpcNotification(method: string, params?: Record<string, unknown>) {
  return new Request('https://test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });
}

// ─── Protocol Tests ─────────────────────────────────────────

describe('MCP Protocol (handleMcpRequest)', () => {
  const env = makeEnv();

  describe('HTTP method handling', () => {
    it('returns 202 for DELETE (session termination)', async () => {
      const req = new Request('https://test/mcp', { method: 'DELETE' });
      const res = await handleMcpRequest(req, env as any);
      expect(res.status).toBe(202);
    });

    it('returns 405 with SSE error for GET', async () => {
      const req = new Request('https://test/mcp', { method: 'GET' });
      const res = await handleMcpRequest(req, env as any);
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.error.code).toBe(-32000);
      expect(body.error.message).toContain('SSE not supported');
    });

    it('returns 405 for PUT', async () => {
      const req = new Request('https://test/mcp', { method: 'PUT' });
      const res = await handleMcpRequest(req, env as any);
      expect(res.status).toBe(405);
    });

    it('returns parse error for invalid JSON body', async () => {
      const req = new Request('https://test/mcp', {
        method: 'POST',
        body: 'not json{{{',
      });
      const res = await handleMcpRequest(req, env as any);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe(-32700);
      expect(body.error.message).toBe('Parse error');
    });
  });

  describe('JSON-RPC initialize', () => {
    it('returns protocol version, capabilities, and server info', async () => {
      const res = await handleMcpRequest(jsonRpcRequest('initialize'), env as any);
      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result.protocolVersion).toBe('2025-03-26');
      expect(body.result.capabilities.tools.listChanged).toBe(false);
      expect(body.result.serverInfo.name).toBe('aegis');
    });
  });

  describe('JSON-RPC ping', () => {
    it('returns empty result', async () => {
      const res = await handleMcpRequest(jsonRpcRequest('ping'), env as any);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.result).toEqual({});
    });
  });

  describe('JSON-RPC tools/list', () => {
    it('returns tools array', async () => {
      const res = await handleMcpRequest(jsonRpcRequest('tools/list'), env as any);
      const body = await res.json();
      expect(body.result.tools).toEqual(TOOLS);
      expect(Array.isArray(body.result.tools)).toBe(true);
      expect(body.result.tools.length).toBeGreaterThan(10);
    });
  });

  describe('JSON-RPC tools/call', () => {
    it('returns error for missing tool name', async () => {
      const res = await handleMcpRequest(
        jsonRpcRequest('tools/call', { arguments: {} }),
        env as any,
      );
      const body = await res.json();
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toBe('Missing tool name');
    });

    it('returns isError for unknown tool', async () => {
      const res = await handleMcpRequest(
        jsonRpcRequest('tools/call', { name: 'nonexistent_tool', arguments: {} }),
        env as any,
      );
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain('Unknown tool');
    });
  });

  describe('unknown method', () => {
    it('returns -32601 method not found', async () => {
      const res = await handleMcpRequest(jsonRpcRequest('foo/bar'), env as any);
      const body = await res.json();
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Method not found');
    });
  });

  describe('notifications (no id)', () => {
    it('returns 202 with no body for notification', async () => {
      const res = await handleMcpRequest(jsonRpcNotification('initialized'), env as any);
      expect(res.status).toBe(202);
    });
  });

  describe('batch requests', () => {
    it('processes multiple requests and returns array', async () => {
      const req = new Request('https://test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'initialize' },
        ]),
      });
      const res = await handleMcpRequest(req, env as any);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe(1);
      expect(body[1].id).toBe(2);
    });

    it('returns 202 for batch of only notifications', async () => {
      const req = new Request('https://test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', method: 'initialized' },
          { jsonrpc: '2.0', method: 'notifications/cancelled' },
        ]),
      });
      const res = await handleMcpRequest(req, env as any);
      expect(res.status).toBe(202);
    });

    it('filters out notifications from batch response', async () => {
      const req = new Request('https://test/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', method: 'initialized' },  // notification
          { jsonrpc: '2.0', id: 1, method: 'ping' },  // request
        ]),
      });
      const res = await handleMcpRequest(req, env as any);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(1);
    });
  });

  describe('request id preservation', () => {
    it('preserves string id', async () => {
      const res = await handleMcpRequest(jsonRpcRequest('ping', {}, 'my-id'), env as any);
      const body = await res.json();
      expect(body.id).toBe('my-id');
    });

    it('preserves numeric id', async () => {
      const res = await handleMcpRequest(jsonRpcRequest('ping', {}, 42), env as any);
      const body = await res.json();
      expect(body.id).toBe(42);
    });
  });
});

// ─── Tool Handler Tests ──────────────────────────────────────

describe('MCP Tool Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllProcedures.mockResolvedValue([]);
    mockGetActiveAgendaItems.mockResolvedValue([]);
    mockAddAgendaItem.mockResolvedValue(42);
    mockResolveAgendaItem.mockResolvedValue(undefined);
    mockAddGoal.mockResolvedValue('goal-123');
    mockUpdateGoalStatus.mockResolvedValue(undefined);
    mockGetActiveGoals.mockResolvedValue([]);
    mockGetMemoryEntries.mockResolvedValue([]);
    mockRecordMemory.mockResolvedValue({ fragment_id: 'test-fragment-id' });
  });

  // ─── aegis_chat ──────────────────────────────────────────

  describe('toolAegisChat', () => {
    it('returns error when message is empty', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisChat({ message: '' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('message is required');
    });

    it('returns error when message is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisChat({}, env as any);
      expect(result.isError).toBe(true);
    });

    it('dispatches message through kernel and returns response', async () => {
      const env = makeEnv();
      mockCreateIntent.mockReturnValue({ source: { channel: 'mcp' }, raw: 'hello' });
      mockDispatch.mockResolvedValue({
        text: 'Hi there!',
        classification: 'greeting',
        executor: 'groq',
        cost: 0.001,
        latency_ms: 50,
        procedureHit: false,
      });

      const result = await handlers.toolAegisChat({ message: 'hello' }, env as any);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.response).toBe('Hi there!');
      expect(parsed.classification).toBe('greeting');
      expect(parsed.executor).toBe('groq');
      expect(parsed.conversation_id).toBeDefined();
    });
  });

  // ─── aegis_conversations ─────────────────────────────────

  describe('toolAegisConversations', () => {
    it('returns conversation list', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisConversations({ limit: 5 }, env as any);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('clamps limit between 1 and 50 (query fetches limit*2 for filtering)', async () => {
      const env = makeEnv();
      // Exceeds max → clamped to 50, SQL gets limit*2=100
      await handlers.toolAegisConversations({ limit: 100 }, env as any);
      const q1 = (env._mockDb as any)._queries[0];
      expect(q1.bindings[0]).toBe(100); // 50 * 2

      // 0 is falsy, so || 20 kicks in, SQL gets 20*2=40
      const env2 = makeEnv();
      await handlers.toolAegisConversations({ limit: 0 }, env2 as any);
      const q2 = (env2._mockDb as any)._queries[0];
      expect(q2.bindings[0]).toBe(40); // 20 * 2
    });
  });

  // ─── aegis_conversation_history ──────────────────────────

  describe('toolAegisConversationHistory', () => {
    it('returns error when conversation_id is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisConversationHistory({}, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('conversation_id is required');
    });

    it('returns message history for valid conversation', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisConversationHistory({ conversation_id: 'abc-123' }, env as any);
      expect(result.isError).toBeUndefined();
    });
  });

  // ─── aegis_agenda ────────────────────────────────────────

  describe('toolAegisAgenda', () => {
    it('returns active agenda items', async () => {
      mockGetActiveAgendaItems.mockResolvedValue([
        { id: 1, item: 'Review PR', priority: 'high', status: 'active' },
      ]);

      const env = makeEnv();
      const result = await handlers.toolAegisAgenda(env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.items[0].item).toBe('Review PR');
    });
  });

  // ─── aegis_health ────────────────────────────────────────

  describe('toolAegisHealth', () => {
    it('returns health status with kernel stats', async () => {
      mockGetAllProcedures.mockResolvedValue([
        { task_pattern: 'greeting', executor: 'groq', status: 'learned', success_count: 10, fail_count: 0 },
        { task_pattern: 'knowledge', executor: 'workers_ai', status: 'learning', success_count: 2, fail_count: 1 },
      ]);

      const env = makeEnv();
      const result = await handlers.toolAegisHealth(env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('ok');
      expect(parsed.service).toBe('aegis-web');
      expect(parsed.kernel.learned).toBe(1);
      expect(parsed.kernel.learning).toBe(1);
      expect(parsed.procedures).toHaveLength(2);
      expect(parsed.procedures[0].successRate).toBe(1);
    });

    it('handles empty procedures', async () => {
      mockGetAllProcedures.mockResolvedValue([]);
      const env = makeEnv();
      const result = await handlers.toolAegisHealth(env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.kernel.learned).toBe(0);
      expect(parsed.procedures).toHaveLength(0);
    });
  });

  // ─── aegis_memory ────────────────────────────────────────

  describe('toolAegisMemory', () => {
    it('returns error when memoryBinding is unavailable', async () => {
      const env = makeEnv();
      (env as any).memoryBinding = undefined;
      const result = await handlers.toolAegisMemory({}, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Memory Worker binding unavailable');
    });

    it('uses keyword search when query is provided', async () => {
      const env = makeEnv();
      env.memoryBinding!.recall = vi.fn().mockResolvedValue([
        { id: '1', topic: 'project', content: 'Test fact', confidence: 0.9 },
      ]);

      const result = await handlers.toolAegisMemory({ query: 'test', limit: 10 }, env as any);
      expect(env.memoryBinding!.recall).toHaveBeenCalledWith('aegis', { keywords: 'test', topic: undefined, limit: 10 });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
    });

    it('falls back to getMemoryEntries when no query', async () => {
      const env = makeEnv();
      mockGetMemoryEntries.mockResolvedValue([
        { id: '1', topic: 'pref', content: 'Uses vim', confidence: 0.8 },
      ]);

      const result = await handlers.toolAegisMemory({ topic: 'pref' }, env as any);
      expect(mockGetMemoryEntries).toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
    });

    it('returns full content without truncation', async () => {
      const env = makeEnv();
      const longContent = 'A'.repeat(400);
      mockGetMemoryEntries.mockResolvedValue([
        { id: '1', topic: 'test', content: longContent, confidence: 0.8 },
      ]);

      const result = await handlers.toolAegisMemory({}, env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.entries[0].fact.length).toBe(400);
      expect(parsed.entries[0].fact).toBe(longContent);
    });

    it('clamps limit between 1 and 100', async () => {
      const env = makeEnv();
      mockGetMemoryEntries.mockResolvedValue([]);
      await handlers.toolAegisMemory({ limit: 200 }, env as any);
      // No error — limit is clamped internally
    });
  });

  // ─── aegis_record_memory ─────────────────────────────────

  describe('toolAegisRecordMemory', () => {
    it('returns error when memoryBinding is unavailable', async () => {
      const env = makeEnv();
      (env as any).memoryBinding = undefined;
      const result = await handlers.toolAegisRecordMemory({ topic: 'test', fact: 'test' }, env as any);
      expect(result.isError).toBe(true);
    });

    it('returns error when topic is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisRecordMemory({ fact: 'test' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('topic and fact are required');
    });

    it('returns error when fact is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisRecordMemory({ topic: 'test' }, env as any);
      expect(result.isError).toBe(true);
    });

    it('records memory with defaults', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisRecordMemory({ topic: 'project', fact: 'The project uses TypeScript for all modules' }, env as any);
      expect(result.isError).toBeUndefined();
      expect(mockRecordMemory).toHaveBeenCalledWith(
        env.memoryBinding, 'project', 'The project uses TypeScript for all modules', 0.8, 'claude_code',
      );
      expect(result.content[0].text).toContain('Recorded');
    });

    it('uses provided confidence and source', async () => {
      const env = makeEnv();
      await handlers.toolAegisRecordMemory(
        { topic: 'operator_preferences', fact: 'Operator prefers dark mode for all UIs', confidence: 0.95, source: 'direct' },
        env as any,
      );
      expect(mockRecordMemory).toHaveBeenCalledWith(
        env.memoryBinding, 'operator_preferences', 'Operator prefers dark mode for all UIs', 0.95, 'direct',
      );
    });
  });

  // ─── aegis_add_agenda ────────────────────────────────────

  describe('toolAegisAddAgenda', () => {
    it('returns error when item is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisAddAgenda({}, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('item is required');
    });

    it('adds agenda item with defaults', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisAddAgenda({ item: 'Review PR #42' }, env as any);
      expect(mockAddAgendaItem).toHaveBeenCalledWith(env.db, 'Review PR #42', undefined, 'medium');
      expect(result.content[0].text).toContain('#42');
      expect(result.content[0].text).toContain('medium');
    });

    it('passes priority and context', async () => {
      const env = makeEnv();
      await handlers.toolAegisAddAgenda(
        { item: 'Deploy fix', context: 'Prod down', priority: 'high' },
        env as any,
      );
      expect(mockAddAgendaItem).toHaveBeenCalledWith(env.db, 'Deploy fix', 'Prod down', 'high');
    });
  });

  // ─── aegis_resolve_agenda ────────────────────────────────

  describe('toolAegisResolveAgenda', () => {
    it('returns error when id is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisResolveAgenda({ status: 'done' }, env as any);
      expect(result.isError).toBe(true);
    });

    it('returns error when status is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisResolveAgenda({ id: 1 }, env as any);
      expect(result.isError).toBe(true);
    });

    it('resolves agenda item', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisResolveAgenda({ id: 5, status: 'done' }, env as any);
      expect(mockResolveAgendaItem).toHaveBeenCalledWith(env.db, 5, 'done');
      expect(result.content[0].text).toContain('#5');
      expect(result.content[0].text).toContain('done');
    });
  });

  // ─── aegis_add_goal ──────────────────────────────────────

  describe('toolAegisAddGoal', () => {
    it('returns error when title is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisAddGoal({}, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('title is required');
    });

    it('creates goal with defaults', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisAddGoal({ title: 'Monitor billing' }, env as any);
      expect(mockAddGoal).toHaveBeenCalledWith(env.db, 'Monitor billing', undefined, 6);
      expect(result.content[0].text).toContain('Monitor billing');
      expect(result.content[0].text).toContain('goal-123');
    });

    it('passes description and schedule_hours', async () => {
      const env = makeEnv();
      await handlers.toolAegisAddGoal(
        { title: 'Check metrics', description: 'Check CF analytics', schedule_hours: 12 },
        env as any,
      );
      expect(mockAddGoal).toHaveBeenCalledWith(env.db, 'Check metrics', 'Check CF analytics', 12);
    });
  });

  // ─── aegis_update_goal ───────────────────────────────────

  describe('toolAegisUpdateGoal', () => {
    it('returns error when id is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisUpdateGoal({ status: 'paused' }, env as any);
      expect(result.isError).toBe(true);
    });

    it('returns error when status is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisUpdateGoal({ id: 'g1' }, env as any);
      expect(result.isError).toBe(true);
    });

    it('updates goal status', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisUpdateGoal({ id: 'g1', status: 'completed' }, env as any);
      expect(mockUpdateGoalStatus).toHaveBeenCalledWith(env.db, 'g1', 'completed');
      expect(result.content[0].text).toContain('g1');
      expect(result.content[0].text).toContain('completed');
    });
  });

  // ─── aegis_list_goals ────────────────────────────────────

  describe('toolAegisListGoals', () => {
    it('returns active goals', async () => {
      mockGetActiveGoals.mockResolvedValue([
        { id: 'g1', title: 'Monitor', status: 'active' },
      ]);
      const env = makeEnv();
      const result = await handlers.toolAegisListGoals(env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.goals[0].title).toBe('Monitor');
    });
  });

  // ─── aegis_cc_sessions ───────────────────────────────────

  describe('toolAegisCcSessions', () => {
    it('looks up specific session by id', async () => {
      const env = makeEnv();
      // Override first() to return a session
      const db = baseMockDb();
      const origPrepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        stmt.first = vi.fn().mockResolvedValue({ id: 'sess-1', summary: 'test session' });
        return stmt;
      };
      const envWithSession = { ...env, db: db as unknown as D1Database };
      const result = await handlers.toolAegisCcSessions({ id: 'sess-1' }, envWithSession as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.id).toBe('sess-1');
    });

    it('returns error for unknown session id', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCcSessions({ id: 'nonexistent' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No session found');
    });

    it('lists recent sessions when no id', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCcSessions({}, env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBeDefined();
      expect(parsed.sessions).toBeDefined();
    });
  });

  // ─── aegis_create_cc_task ────────────────────────────────

  describe('toolAegisCreateCcTask', () => {
    it('returns error when required fields are missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCreateCcTask({ title: 'Test' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('title, repo, and prompt are required');
    });

    it('creates task with defaults', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCreateCcTask(
        { title: 'Add tests', repo: 'my-project', prompt: 'Write unit tests' },
        env as any,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Queued task');
      expect(result.content[0].text).toContain('Add tests');
      expect(result.content[0].text).toContain('operator');
      expect(result.content[0].text).toContain('feature');
    });

    it('uses provided authority and category', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCreateCcTask(
        { title: 'Docs', repo: 'aegis', prompt: 'Write docs', authority: 'proposed', category: 'docs' },
        env as any,
      );
      expect(result.content[0].text).toContain('proposed');
      expect(result.content[0].text).toContain('docs');
    });

    it('defaults invalid authority to operator', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCreateCcTask(
        { title: 'Test', repo: 'r', prompt: 'p', authority: 'admin' },
        env as any,
      );
      expect(result.content[0].text).toContain('operator');
    });

    it('defaults invalid category to feature', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCreateCcTask(
        { title: 'Test', repo: 'r', prompt: 'p', category: 'yolo' },
        env as any,
      );
      expect(result.content[0].text).toContain('feature');
    });
  });

  // ─── aegis_list_cc_tasks ─────────────────────────────────

  describe('toolAegisListCcTasks', () => {
    it('lists all tasks when no status filter', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisListCcTasks({}, env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBeDefined();
      expect(parsed.tasks).toBeDefined();
    });

    it('filters by status', async () => {
      const env = makeEnv();
      await handlers.toolAegisListCcTasks({ status: 'pending' }, env as any);
      const query = (env._mockDb as any)._queries[0];
      expect(query.bindings).toContain('pending');
    });

    it('clamps limit between 1 and 50', async () => {
      const env = makeEnv();
      await handlers.toolAegisListCcTasks({ limit: 200 }, env as any);
      const query = (env._mockDb as any)._queries[0];
      expect(query.bindings).toContain(50);
    });
  });

  // ─── aegis_cancel_cc_task ────────────────────────────────

  describe('toolAegisCancelCcTask', () => {
    it('returns error when id is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCancelCcTask({}, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('id is required');
    });

    it('cancels a pending task', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisCancelCcTask({ id: 'task-1' }, env as any);
      expect(result.content[0].text).toContain('Cancelled task task-1');
    });

    it('returns error when task not found or not pending', async () => {
      const db = baseMockDb();
      const origPrepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        stmt.run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
        return stmt;
      };
      const env = { ...makeEnv(), db: db as unknown as D1Database };
      const result = await handlers.toolAegisCancelCcTask({ id: 'task-999' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found or not in a cancellable status');
    });
  });

  // ─── aegis_approve_cc_task ───────────────────────────────

  describe('toolAegisApproveCcTask', () => {
    it('returns error when id is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisApproveCcTask({}, env as any);
      expect(result.isError).toBe(true);
    });

    it('approves a proposed task', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisApproveCcTask({ id: 'task-1' }, env as any);
      expect(result.content[0].text).toContain('Approved task task-1');
    });

    it('returns error when task not proposed or not pending', async () => {
      const db = baseMockDb();
      const origPrepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        stmt.run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
        return stmt;
      };
      const env = { ...makeEnv(), db: db as unknown as D1Database };
      const result = await handlers.toolAegisApproveCcTask({ id: 'task-999' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found, not proposed, or not pending');
    });
  });

  // ─── aegis_task_summary ──────────────────────────────────

  describe('toolAegisTaskSummary', () => {
    it('returns task counts and queues', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisTaskSummary(env as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.counts).toBeDefined();
      expect(parsed.proposed).toBeDefined();
      expect(parsed.pending).toBeDefined();
      expect(parsed.recent_failures).toBeDefined();
      expect(parsed.failure_kinds).toBeDefined();
      expect(parsed.repo_risks).toBeDefined();
      expect(parsed.preflight_warnings).toBeDefined();
      expect(parsed.contract_alerts).toBeDefined();
    });
  });

  // ─── aegis_batch_approve ─────────────────────────────────

  describe('toolAegisBatchApprove', () => {
    it('returns error when ids is missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisBatchApprove({}, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ids is required');
    });

    it('approves all proposed tasks with "all"', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisBatchApprove({ ids: 'all' }, env as any);
      expect(result.content[0].text).toContain('Approved');
      expect(result.content[0].text).toContain('task(s)');
    });

    it('approves specific comma-separated ids', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisBatchApprove({ ids: 'id-1, id-2, id-3' }, env as any);
      expect(result.content[0].text).toContain('Approved');
    });

    it('returns error for empty ids string', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisBatchApprove({ ids: '  ' }, env as any);
      // "  " is not "all" and splits to no valid IDs
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no valid IDs');
    });
  });

  // ─── aegis_publish_tech_post ─────────────────────────────

  describe('toolAegisPublishTechPost', () => {
    it('returns error when required fields missing', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisPublishTechPost({ title: 'Test' }, env as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('title, slug, body required');
    });

    it('creates new post', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisPublishTechPost(
        { title: 'My Post', slug: 'my-post', body: '# Hello' },
        env as any,
      );
      expect(result.content[0].text).toContain('Created');
      expect(result.content[0].text).toContain('my-post');
      expect(result.content[0].text).toContain('saved as draft');
    });

    it('updates existing post when slug exists', async () => {
      const db = baseMockDb();
      const origPrepare = db.prepare.bind(db);
      let callIdx = 0;
      db.prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        if (callIdx === 0) {
          // First call = SELECT slug check
          stmt.first = vi.fn().mockResolvedValue({ id: 'existing-id' });
        }
        callIdx++;
        return stmt;
      };
      const env = { ...makeEnv(), db: db as unknown as D1Database };
      const result = await handlers.toolAegisPublishTechPost(
        { title: 'Updated', slug: 'my-post', body: '# Updated' },
        env as any,
      );
      expect(result.content[0].text).toContain('Updated');
      expect(result.content[0].text).toContain('saved as draft');
    });

    it('includes feed URL only for published posts', async () => {
      const env = makeEnv();
      const result = await handlers.toolAegisPublishTechPost(
        { title: 'New', slug: 'new-post', body: 'content', status: 'published' },
        env as any,
      );
      expect(result.content[0].text).toContain('your-blog.example.com/feed.xml');
      expect(result.content[0].text).toContain('https://your-blog.example.com/post/new-post');
    });
  });
});

// ─── TOOLS Schema Validation ─────────────────────────────────

describe('MCP TOOLS schema', () => {
  it('exports an array of tool definitions', () => {
    expect(Array.isArray(TOOLS)).toBe(true);
    expect(TOOLS.length).toBeGreaterThan(10);
  });

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('tool names match the executeTool switch cases', () => {
    const expectedTools = [
      'aegis_chat', 'aegis_conversations', 'aegis_conversation_history',
      'aegis_agenda', 'aegis_health', 'aegis_memory', 'aegis_record_memory',
      'aegis_add_agenda', 'aegis_resolve_agenda', 'aegis_add_goal',
      'aegis_update_goal', 'aegis_list_goals', 'aegis_cc_sessions',
      'aegis_create_cc_task', 'aegis_list_cc_tasks', 'aegis_cancel_cc_task',
      'aegis_approve_cc_task', 'aegis_task_summary', 'aegis_batch_approve',
      'aegis_publish_tech_post',
    ];
    const toolNames = TOOLS.map(t => t.name);
    for (const name of expectedTools) {
      expect(toolNames).toContain(name);
    }
  });

  it('no duplicate tool names', () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('required fields are listed in properties', () => {
    for (const tool of TOOLS) {
      const required = tool.inputSchema.required ?? [];
      const propKeys = Object.keys(tool.inputSchema.properties);
      for (const req of required) {
        expect(propKeys).toContain(req);
      }
    }
  });

  // Spot-check specific schemas
  it('aegis_chat requires message', () => {
    const chat = TOOLS.find(t => t.name === 'aegis_chat')!;
    expect(chat.inputSchema.required).toContain('message');
    expect(chat.inputSchema.properties.message.type).toBe('string');
  });

  it('aegis_create_cc_task requires title, repo, prompt', () => {
    const task = TOOLS.find(t => t.name === 'aegis_create_cc_task')!;
    expect(task.inputSchema.required).toEqual(expect.arrayContaining(['title', 'repo', 'prompt']));
  });

  it('aegis_resolve_agenda requires id and status', () => {
    const resolve = TOOLS.find(t => t.name === 'aegis_resolve_agenda')!;
    expect(resolve.inputSchema.required).toEqual(expect.arrayContaining(['id', 'status']));
  });

  it('enum fields have valid values', () => {
    const addAgenda = TOOLS.find(t => t.name === 'aegis_add_agenda')!;
    expect(addAgenda.inputSchema.properties.priority.enum).toEqual(['low', 'medium', 'high']);

    const updateGoal = TOOLS.find(t => t.name === 'aegis_update_goal')!;
    expect(updateGoal.inputSchema.properties.status.enum).toEqual(['paused', 'completed', 'failed']);

    const createTask = TOOLS.find(t => t.name === 'aegis_create_cc_task')!;
    expect(createTask.inputSchema.properties.category.enum).toEqual(
      expect.arrayContaining(['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy']),
    );
    expect(createTask.inputSchema.properties.authority.enum).toEqual(
      expect.arrayContaining(['proposed', 'auto_safe', 'operator']),
    );
  });
});

// ─── Tool Routing Integration ────────────────────────────────

describe('Tool routing via server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveAgendaItems.mockResolvedValue([]);
    mockGetAllProcedures.mockResolvedValue([]);
    mockGetActiveGoals.mockResolvedValue([]);
  });

  it('routes aegis_agenda through to handler', async () => {
    mockGetActiveAgendaItems.mockResolvedValue([{ id: 1, item: 'Test', priority: 'low', status: 'active' }]);
    const env = makeEnv();
    const res = await handleMcpRequest(
      jsonRpcRequest('tools/call', { name: 'aegis_agenda', arguments: {} }),
      env as any,
    );
    const body = await res.json();
    expect(body.result.isError).toBeUndefined();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.count).toBe(1);
  });

  it('routes aegis_health through to handler', async () => {
    const env = makeEnv();
    const res = await handleMcpRequest(
      jsonRpcRequest('tools/call', { name: 'aegis_health', arguments: {} }),
      env as any,
    );
    const body = await res.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.status).toBe('ok');
  });

  it('routes aegis_list_goals through to handler', async () => {
    mockGetActiveGoals.mockResolvedValue([]);
    const env = makeEnv();
    const res = await handleMcpRequest(
      jsonRpcRequest('tools/call', { name: 'aegis_list_goals', arguments: {} }),
      env as any,
    );
    const body = await res.json();
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.count).toBe(0);
  });

  it('wraps handler exceptions in tool error result', async () => {
    mockGetAllProcedures.mockRejectedValue(new Error('DB connection failed'));
    const env = makeEnv();
    const res = await handleMcpRequest(
      jsonRpcRequest('tools/call', { name: 'aegis_health', arguments: {} }),
      env as any,
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('DB connection failed');
  });
});
