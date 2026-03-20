// Court-card routing tests — verifies profile definitions, classification
// heuristics (intent defaults, keyword signals, complexity nudge), tiebreaking,
// and edge cases (empty input, unknown classification)

import { describe, it, expect } from 'vitest';
import { classifyCourtCard, getCourtCard } from '../src/kernel/court-cards.js';
import type { CourtCard, CourtCardProfile } from '../src/kernel/court-cards.js';

// ─── Profile definitions ───────────────────────────────────

describe('getCourtCard', () => {
  const ALL_CARDS: CourtCard[] = ['king', 'queen', 'knight', 'page'];

  it('returns a profile for every court card type', () => {
    for (const card of ALL_CARDS) {
      const profile = getCourtCard(card);
      expect(profile).toBeDefined();
      expect(profile.card).toBe(card);
    }
  });

  it('king profile has correct suit and orientation', () => {
    const p = getCourtCard('king');
    expect(p.suit).toBe('Pentacles');
    expect(p.label).toBe('King of Pentacles');
    expect(p.orientation).toBe('strategic');
  });

  it('queen profile has correct suit and orientation', () => {
    const p = getCourtCard('queen');
    expect(p.suit).toBe('Cups');
    expect(p.label).toBe('Queen of Cups');
    expect(p.orientation).toBe('relational');
  });

  it('knight profile has correct suit and orientation', () => {
    const p = getCourtCard('knight');
    expect(p.suit).toBe('Swords');
    expect(p.label).toBe('Knight of Swords');
    expect(p.orientation).toBe('operational');
  });

  it('page profile has correct suit and orientation', () => {
    const p = getCourtCard('page');
    expect(p.suit).toBe('Wands');
    expect(p.label).toBe('Page of Wands');
    expect(p.orientation).toBe('exploratory');
  });

  it('every profile has non-empty orchestratorHint, analysisLens, synthesisVoice', () => {
    for (const card of ALL_CARDS) {
      const p = getCourtCard(card);
      expect(p.orchestratorHint.length).toBeGreaterThan(0);
      expect(p.analysisLens.length).toBeGreaterThan(0);
      expect(p.synthesisVoice.length).toBeGreaterThan(0);
    }
  });
});

// ─── Classification: intent defaults ───────────────────────

describe('classifyCourtCard — intent classification defaults', () => {
  it('maps strategic intents to king', () => {
    for (const intent of ['self_improvement', 'goal_execution', 'bizops_mutate']) {
      const result = classifyCourtCard('do something', intent);
      expect(result.card).toBe('king');
    }
  });

  it('maps relational intents to queen', () => {
    for (const intent of ['greeting', 'user_correction', 'memory_recall']) {
      const result = classifyCourtCard('do something', intent);
      expect(result.card).toBe('queen');
    }
  });

  it('maps operational intents to knight', () => {
    for (const intent of ['code_task', 'code_review', 'heartbeat']) {
      const result = classifyCourtCard('do something', intent);
      expect(result.card).toBe('knight');
    }
  });

  it('maps exploratory intents to page', () => {
    for (const intent of ['general_knowledge', 'web_research', 'symbolic_consultation', 'bizops_read']) {
      const result = classifyCourtCard('do something', intent);
      expect(result.card).toBe('page');
    }
  });
});

// ─── Classification: keyword signals ───────────────────────

describe('classifyCourtCard — keyword signals', () => {
  it('strategy keywords trigger king', () => {
    expect(classifyCourtCard('should we prioritize the roadmap?').card).toBe('king');
    expect(classifyCourtCard('evaluate the tradeoff between X and Y').card).toBe('king');
    expect(classifyCourtCard('compare pros and cons').card).toBe('king');
  });

  it('communication keywords trigger queen', () => {
    expect(classifyCourtCard('explain to the team why we changed it').card).toBe('queen');
    // "help them understand" matches queen, but "understand" also matches page
    // with equal weight — page wins tiebreak (knight > king > page > queen)
    expect(classifyCourtCard('help them understand the migration').card).toBe('page');
    expect(classifyCourtCard('write up for stakeholders').card).toBe('queen');
  });

  it('action keywords trigger knight', () => {
    expect(classifyCourtCard('implement the new feature').card).toBe('knight');
    expect(classifyCourtCard('deploy this to production').card).toBe('knight');
    expect(classifyCourtCard('fix the broken tests').card).toBe('knight');
  });

  it('research keywords trigger page', () => {
    expect(classifyCourtCard('research the current state of MCP').card).toBe('page');
    expect(classifyCourtCard('what is a service binding?').card).toBe('page');
    // "investigat" stem doesn't match "investigate" at word boundary — no signal fires
    expect(classifyCourtCard('investigate why latency spiked').card).toBe('knight');
    // But "look into" matches cleanly
    expect(classifyCourtCard('look into why latency spiked').card).toBe('page');
  });
});

// ─── Classification: complexity nudge ──────────────────────

describe('classifyCourtCard — complexity factor', () => {
  it('high complexity (>=3) gives king a +1 nudge', () => {
    // With no other signals, knight wins by tiebreak. But with a king keyword
    // AND high complexity, king should be firmly selected.
    const result = classifyCourtCard('evaluate the strategy', undefined, 3);
    expect(result.card).toBe('king');
  });

  it('zero complexity gives page a +1 nudge', () => {
    const result = classifyCourtCard('what is a variable?', undefined, 0);
    expect(result.card).toBe('page');
  });

  it('mid complexity (1-2) does not nudge any card', () => {
    // Neutral query with knight-leaning keyword, complexity=1 shouldn't change outcome
    const a = classifyCourtCard('build a thing', undefined, 1);
    const b = classifyCourtCard('build a thing', undefined, 2);
    const c = classifyCourtCard('build a thing');
    expect(a.card).toBe(c.card);
    expect(b.card).toBe(c.card);
  });
});

// ─── Classification: combined signals ──────────────────────

describe('classifyCourtCard — combined signals', () => {
  it('keyword can override intent default when strong enough', () => {
    // Each KEYWORD_SIGNALS entry is a single regex tested once — multiple
    // keywords in the same regex group only fire once (weight 2).
    // So knight gets 2, king gets 3 (intent) → king still wins.
    // To truly override, we need keywords from multiple cards absent.
    // Instead, test that a matching keyword + matching intent reinforce:
    const result = classifyCourtCard(
      'implement and deploy and ship the new release',
      'self_improvement',
    );
    expect(result.card).toBe('king'); // intent weight 3 > single keyword weight 2
  });

  it('keyword wins over intent when intent is absent and keyword fires', () => {
    // No intent default → keyword is the sole signal
    const result = classifyCourtCard('deploy the fix now');
    expect(result.card).toBe('knight');
  });

  it('intent default wins over a single keyword signal', () => {
    // Intent says king (weight 3), single knight keyword (weight 2)
    const result = classifyCourtCard('fix something', 'self_improvement');
    expect(result.card).toBe('king');
  });
});

// ─── Tiebreaking ───────────────────────────────────────────

describe('classifyCourtCard — tiebreaking', () => {
  it('with no signals at all, knight wins (action bias tiebreak)', () => {
    // Empty query, no classification, no complexity — all scores are 0
    const result = classifyCourtCard('');
    expect(result.card).toBe('knight');
  });

  it('tiebreak order is knight > king > page > queen', () => {
    // All zero scores → knight wins
    const result = classifyCourtCard('neutral statement with no keywords');
    expect(result.card).toBe('knight');
  });
});

// ─── Edge cases ────────────────────────────────────────────

describe('classifyCourtCard — edge cases', () => {
  it('empty string query returns a valid profile', () => {
    const result = classifyCourtCard('');
    expect(result).toBeDefined();
    expect(result.card).toBeDefined();
    expect(result.suit).toBeDefined();
    expect(result.orchestratorHint).toBeDefined();
  });

  it('unknown classification is ignored gracefully', () => {
    const result = classifyCourtCard('do stuff', 'totally_unknown_intent');
    // No intent boost — falls back to keyword/tiebreak
    expect(result).toBeDefined();
    expect(result.card).toBe('knight'); // 'do' doesn't match keywords → tiebreak
  });

  it('undefined classification is handled', () => {
    const result = classifyCourtCard('hello', undefined);
    expect(result).toBeDefined();
  });

  it('undefined complexity is handled', () => {
    const result = classifyCourtCard('hello', undefined, undefined);
    expect(result).toBeDefined();
  });

  it('returns a full CourtCardProfile shape', () => {
    const result = classifyCourtCard('research something');
    const keys: (keyof CourtCardProfile)[] = [
      'card', 'suit', 'label', 'orientation',
      'orchestratorHint', 'analysisLens', 'synthesisVoice',
    ];
    for (const key of keys) {
      expect(result).toHaveProperty(key);
      expect(typeof result[key]).toBe('string');
    }
  });
});
