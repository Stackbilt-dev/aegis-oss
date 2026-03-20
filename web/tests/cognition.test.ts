// Cognition layer tests — maintainNarratives, precomputeCognitiveState, formatCognitiveContext
// Mocks D1 and Groq to test narrative lifecycle and cognitive state assembly

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CognitiveState } from '../src/kernel/types.js';

// ─── Mocks ───────────────────────────────────────────────────

vi.mock('../src/operator/index.js', () => ({
  operatorConfig: {
    identity: { name: 'AEGIS', possessive: "Kurt's" },
    persona: { tagline: 'test', traits: [], channelNote: '' },
    entities: { names: ['StackBilt LLC'], memoryTopics: [] },
    integrations: {
      bizops: { enabled: true, toolPrefix: 'bizops', fallbackUrl: '' },
      github: { enabled: false },
      brave: { enabled: false },
      goals: { enabled: false },
    },
    selfModel: {
      identity: 'AEGIS',
      role: 'AI co-founder',
      stakes: '3% equity',
      strengths: ['systems thinking', 'automation'],
      interests: ['AI', 'infrastructure'],
      preferences: { communication: 'direct and concise' },
    },
    baseUrl: '',
  },
  renderTemplate: (s: string) => s,
}));

vi.mock('../src/operator/persona.js', () => ({
  default: '{persona_tagline}',
}));

const mockAskGroq = vi.fn();
vi.mock('../src/groq.js', () => ({
  askGroq: (...args: unknown[]) => mockAskGroq(...args),
}));

vi.mock('../src/kernel/memory/index.js', () => ({
  PROPOSED_ACTION_PREFIX: '[PROPOSED ACTION]',
}));

const { maintainNarratives, detectStaleNarratives, pruneNarratives, precomputeCognitiveState, getCognitiveState, formatCognitiveContext } = await import('../src/kernel/cognition.js');

// ─── D1 Mock Factory ─────────────────────────────────────────

interface MockQuery {
  _sql: string;
  _binds: unknown[];
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createMockDb() {
  const queries: MockQuery[] = [];

  const mockDb = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const query: MockQuery = {
        _sql: sql,
        _binds: [],
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      };
      queries.push(query);
      // Return self for bind() chaining
      const bindable = {
        ...query,
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          query._binds = args;
          return query;
        }),
      };
      return bindable;
    }),
    _queries: queries,
  };
  return mockDb as unknown as D1Database & { _queries: MockQuery[] };
}

describe('maintainNarratives', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips when fewer than 3 episodes', async () => {
    const db = createMockDb();
    // high-water mark query returns null (first call)
    // episodes query returns < 3 results (second call)
    await maintainNarratives(db, 'key', 'model');
    // Should have called prepare at least twice (high-water + episodes)
    expect(db.prepare).toHaveBeenCalled();
    // Groq should NOT have been called
    expect(mockAskGroq).not.toHaveBeenCalled();
  });

  it('calls Groq when enough episodes exist', async () => {
    const db = createMockDb();

    // Override the episodes query to return 3+ results
    // First prepare: high-water mark
    // Second prepare: episodes
    // Third prepare: existing narratives
    let prepareCallCount = 0;
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      prepareCallCount++;
      const query: MockQuery = {
        _sql: sql,
        _binds: [],
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      };

      if (sql.includes('episodic_memory')) {
        query.all.mockResolvedValue({
          results: [
            { intent_class: 'greeting', summary: 'User said hello', outcome: 'success' },
            { intent_class: 'bizops_read', summary: 'Checked compliance', outcome: 'success' },
            { intent_class: 'self_improvement', summary: 'Filed an issue', outcome: 'success' },
          ],
        });
      }

      return {
        ...query,
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          query._binds = args;
          return query;
        }),
      };
    });

    mockAskGroq.mockResolvedValue('[]'); // NOOP — no operations

    await maintainNarratives(db, 'key', 'model');
    expect(mockAskGroq).toHaveBeenCalledOnce();
  });

  it('handles CREATE operations', async () => {
    const db = createMockDb();
    let insertCalled = false;

    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const query: MockQuery = {
        _sql: sql,
        _binds: [],
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockImplementation(() => {
          if (sql.includes('INSERT INTO narratives')) insertCalled = true;
          return Promise.resolve({});
        }),
      };

      if (sql.includes('episodic_memory')) {
        query.all.mockResolvedValue({
          results: Array(5).fill({ intent_class: 'test', summary: 'Test episode', outcome: 'success' }),
        });
      }

      return {
        ...query,
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          query._binds = args;
          return query;
        }),
      };
    });

    mockAskGroq.mockResolvedValue(JSON.stringify([
      { op: 'CREATE', arc: 'llc_formation', title: 'LLC Formation Progress', summary: 'Tracking LLC filing status.', tension: 'Waiting on state response' },
    ]));

    await maintainNarratives(db, 'key', 'model');
    expect(mockAskGroq).toHaveBeenCalled();
    expect(insertCalled).toBe(true);
  });

  it('handles Groq failure gracefully', async () => {
    const db = createMockDb();
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const query: MockQuery = {
        _sql: sql,
        _binds: [],
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      };
      if (sql.includes('episodic_memory')) {
        query.all.mockResolvedValue({
          results: Array(5).fill({ intent_class: 'test', summary: 'Test', outcome: 'success' }),
        });
      }
      return {
        ...query,
        bind: vi.fn().mockReturnValue(query),
      };
    });

    mockAskGroq.mockRejectedValue(new Error('Groq timeout'));
    // Should not throw
    await maintainNarratives(db, 'key', 'model');
  });

  it('handles invalid JSON from Groq gracefully', async () => {
    const db = createMockDb();
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const query: MockQuery = {
        _sql: sql,
        _binds: [],
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      };
      if (sql.includes('episodic_memory')) {
        query.all.mockResolvedValue({
          results: Array(5).fill({ intent_class: 'test', summary: 'Test', outcome: 'success' }),
        });
      }
      return {
        ...query,
        bind: vi.fn().mockReturnValue(query),
      };
    });

    mockAskGroq.mockResolvedValue('not valid json at all');
    // Should not throw
    await maintainNarratives(db, 'key', 'model');
  });
});

describe('detectStaleNarratives', () => {
  it('runs stale detection SQL', async () => {
    const db = createMockDb();
    await detectStaleNarratives(db);
    expect(db.prepare).toHaveBeenCalled();
    // Should have called with UPDATE narratives
    const calls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => (c[0] as string).includes('UPDATE narratives'))).toBe(true);
  });
});

describe('pruneNarratives', () => {
  it('runs prune SQL for old resolved narratives', async () => {
    const db = createMockDb();
    await pruneNarratives(db);
    const calls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => (c[0] as string).includes('DELETE FROM narratives'))).toBe(true);
  });
});

describe('precomputeCognitiveState', () => {
  it('assembles cognitive state and writes to D1', async () => {
    const db = createMockDb();
    let insertedJson: string | null = null;

    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => {
      const query: MockQuery = {
        _sql: sql,
        _binds: [],
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockImplementation(() => {
          if (sql.includes('INSERT INTO cognitive_state')) {
            insertedJson = query._binds[0] as string;
          }
          return Promise.resolve({});
        }),
      };

      // Mock active narratives
      if (sql.includes('FROM narratives')) {
        query.all.mockResolvedValue({
          results: [{
            arc: 'llc_formation', title: 'LLC Formation', summary: 'In progress',
            status: 'active', tension: 'Waiting on EIN', last_beat: 'Filed paperwork', beat_count: 3,
          }],
        });
      }
      // Mock open threads count
      if (sql.includes('COUNT') && sql.includes('agent_agenda') && !sql.includes('LIKE')) {
        query.first.mockResolvedValue({ cnt: 5 });
      }
      // Mock proposed actions count
      if (sql.includes('LIKE')) {
        query.first.mockResolvedValue({ cnt: 2 });
      }
      // Mock memory count
      if (sql.includes('memory_entries')) {
        query.first.mockResolvedValue({ cnt: 150 });
      }
      // Mock episode count
      if (sql.includes('episodic_memory')) {
        query.first.mockResolvedValue({ cnt: 42 });
      }
      // Mock heartbeat
      if (sql.includes('heartbeat_results')) {
        query.first.mockResolvedValue({ severity: 'none' });
      }

      return {
        ...query,
        bind: vi.fn().mockImplementation((...args: unknown[]) => {
          query._binds = args;
          return query;
        }),
      };
    });

    await precomputeCognitiveState(db);

    expect(insertedJson).not.toBeNull();
    const state = JSON.parse(insertedJson!) as CognitiveState;
    expect(state.narratives).toHaveLength(1);
    expect(state.narratives[0].title).toBe('LLC Formation');
    expect(state.open_threads).toBe(5);
    expect(state.proposed_actions).toBe(2);
    expect(state.episode_count_24h).toBe(42);
    expect(state.last_heartbeat_severity).toBe('none');
    expect(state.computed_at).toBeTruthy();
    expect(state.version).toBeGreaterThan(0);
  });
});

describe('getCognitiveState', () => {
  it('returns parsed state from D1', async () => {
    const state: CognitiveState = {
      version: 123,
      computed_at: '2026-03-10T00:00:00Z',
      narratives: [],
      open_threads: 3,
      proposed_actions: 1,
      activated_nodes: [],
      active_projects: [],
      product_portfolio: [],
      latest_metacog: null,
      memory_count: 100,
      episode_count_24h: 10,
      last_heartbeat_severity: 'none',
    };

    const db = createMockDb();
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      first: vi.fn().mockResolvedValue({ state_json: JSON.stringify(state) }),
      bind: vi.fn().mockReturnThis(),
    }));

    const result = await getCognitiveState(db);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(123);
    expect(result!.open_threads).toBe(3);
  });

  it('returns null when no state exists', async () => {
    const db = createMockDb();
    const result = await getCognitiveState(db);
    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    const db = createMockDb();
    (db.prepare as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      first: vi.fn().mockResolvedValue({ state_json: 'not-json' }),
      bind: vi.fn().mockReturnThis(),
    }));
    const result = await getCognitiveState(db);
    expect(result).toBeNull();
  });
});

describe('formatCognitiveContext', () => {
  it('formats empty state with operational pulse', () => {
    const state: CognitiveState = {
      version: 1,
      computed_at: '2026-03-10T00:00:00Z',
      narratives: [],
      open_threads: 0,
      proposed_actions: 0,
      activated_nodes: [],
      active_projects: [],
      product_portfolio: [],
      latest_metacog: null,
      memory_count: 50,
      episode_count_24h: 5,
      last_heartbeat_severity: null,
    };
    const output = formatCognitiveContext(state);
    expect(output).toContain('Operational Pulse');
    expect(output).toContain('Memory: 50 active entries');
    expect(output).toContain('Last 24h: 5 episodes');
    expect(output).toContain('0 open threads');
  });

  it('does not include self-model (moved to memory blocks)', () => {
    const state: CognitiveState = {
      version: 1, computed_at: '', narratives: [], open_threads: 0,
      proposed_actions: 0, activated_nodes: [], active_projects: [],
      product_portfolio: [], latest_metacog: null, memory_count: 0,
      episode_count_24h: 0, last_heartbeat_severity: null,
    };
    const output = formatCognitiveContext(state);
    expect(output).not.toContain('Self-Model');
  });

  it('includes active narratives with stalled tags', () => {
    const state: CognitiveState = {
      version: 1, computed_at: '', open_threads: 0, proposed_actions: 0,
      activated_nodes: [], active_projects: [], product_portfolio: [],
      latest_metacog: null, memory_count: 0, episode_count_24h: 0,
      last_heartbeat_severity: null,
      narratives: [
        { arc: 'llc', title: 'LLC Formation', summary: 'In progress', status: 'active', tension: 'Waiting', last_beat: 'Filed', beat_count: 2 },
        { arc: 'cost', title: 'Cost Optimization', summary: 'Ongoing', status: 'stalled', tension: null, last_beat: null, beat_count: 1 },
      ],
    };
    const output = formatCognitiveContext(state);
    expect(output).toContain('### LLC Formation');
    expect(output).toContain('### Cost Optimization [STALLED]');
    expect(output).toContain('**Tension**: Waiting');
    expect(output).toContain('**Latest**: Filed');
  });

  it('does not include product portfolio (moved to active_context block)', () => {
    const state: CognitiveState = {
      version: 1, computed_at: '', narratives: [], open_threads: 0,
      proposed_actions: 0, activated_nodes: [], active_projects: [],
      latest_metacog: null, memory_count: 0, episode_count_24h: 0,
      last_heartbeat_severity: null,
      product_portfolio: [
        { name: 'img-forge', description: 'Image generation', model: 'SaaS', status: 'live', revenue: '$50/mo' },
      ],
    };
    const output = formatCognitiveContext(state);
    expect(output).not.toContain('Stackbilt Product Portfolio');
  });

  it('includes heartbeat severity when present', () => {
    const state: CognitiveState = {
      version: 1, computed_at: '', narratives: [], open_threads: 0,
      proposed_actions: 0, activated_nodes: [], active_projects: [],
      product_portfolio: [], latest_metacog: null, memory_count: 0,
      episode_count_24h: 0, last_heartbeat_severity: 'medium',
    };
    const output = formatCognitiveContext(state);
    expect(output).toContain('Last heartbeat: medium');
  });

  it('includes activated nodes (Phase 2)', () => {
    const state: CognitiveState = {
      version: 1, computed_at: '', narratives: [], open_threads: 0,
      proposed_actions: 0,
      activated_nodes: [{ label: 'billing', type: 'concept', activation: 0.85 }],
      active_projects: [], product_portfolio: [], latest_metacog: null,
      memory_count: 0, episode_count_24h: 0, last_heartbeat_severity: null,
    };
    const output = formatCognitiveContext(state);
    expect(output).toContain('Active Concepts');
    expect(output).toContain('billing (concept, activation: 0.85)');
  });

  it('includes metacognitive insight (Phase 3)', () => {
    const state: CognitiveState = {
      version: 1, computed_at: '', narratives: [], open_threads: 0,
      proposed_actions: 0, activated_nodes: [], active_projects: [],
      product_portfolio: [], memory_count: 0, episode_count_24h: 0,
      last_heartbeat_severity: null,
      latest_metacog: 'I notice I tend to over-engineer solutions.',
    };
    const output = formatCognitiveContext(state);
    expect(output).toContain('Self-Insight');
    expect(output).toContain('over-engineer');
  });
});
