// Court-Card-Routed Agent Orchestration
// Maps tarot court cards to cognitive orientations that influence
// how the composite executor decomposes, analyzes, and synthesizes queries.
//
// King (Pentacles)  → Strategy, architecture, decisions, tradeoffs
// Queen (Cups)      → Empathy, communication, relationships, culture
// Knight (Swords)   → Action, implementation, execution, shipping
// Page (Wands)      → Research, learning, exploration, curiosity
//
// Classification is heuristic — derived from existing intent classification
// and lightweight keyword matching. Zero extra model calls.

export type CourtCard = 'king' | 'queen' | 'knight' | 'page';

export interface CourtCardProfile {
  card: CourtCard;
  suit: string;
  label: string;
  orientation: string;
  orchestratorHint: string;
  analysisLens: string;
  synthesisVoice: string;
}

const PROFILES: Record<CourtCard, CourtCardProfile> = {
  king: {
    card: 'king',
    suit: 'Pentacles',
    label: 'King of Pentacles',
    orientation: 'strategic',
    orchestratorHint:
      'Decompose with strategic emphasis — identify decision points, tradeoffs, and long-term implications. Prioritize subtasks that surface architectural constraints and business impact.',
    analysisLens:
      'Analyze through a strategic lens: what are the tradeoffs? What decision does this inform? What are the second-order consequences?',
    synthesisVoice:
      'Synthesize as a strategic advisor — lead with the decision framework, then supporting evidence. Frame recommendations in terms of risk, leverage, and long-term positioning.',
  },
  queen: {
    card: 'queen',
    suit: 'Cups',
    label: 'Queen of Cups',
    orientation: 'relational',
    orchestratorHint:
      'Decompose with relational emphasis — consider stakeholder perspectives, communication needs, and human factors. Prioritize subtasks that surface context others need to understand.',
    analysisLens:
      'Analyze through a relational lens: who is affected? How should this be communicated? What context or empathy is needed?',
    synthesisVoice:
      'Synthesize with clarity and care — lead with what matters to the people involved, explain context fully, and frame technical details in human terms.',
  },
  knight: {
    card: 'knight',
    suit: 'Swords',
    label: 'Knight of Swords',
    orientation: 'operational',
    orchestratorHint:
      'Decompose with execution emphasis — identify concrete steps, blockers, and dependencies. Prioritize subtasks that produce actionable outputs and unblock progress.',
    analysisLens:
      'Analyze through an operational lens: what needs to happen next? What is blocking progress? What is the fastest path to done?',
    synthesisVoice:
      'Synthesize for action — lead with what to do, then why. Be direct and concrete. Provide steps, commands, or specific next actions.',
  },
  page: {
    card: 'page',
    suit: 'Wands',
    label: 'Page of Wands',
    orientation: 'exploratory',
    orchestratorHint:
      'Decompose with exploratory emphasis — cast a wide net, surface related concepts, and identify knowledge gaps. Prioritize subtasks that gather diverse perspectives and raw data.',
    analysisLens:
      'Analyze through an exploratory lens: what patterns emerge? What connections exist? What is surprising or worth investigating further?',
    synthesisVoice:
      'Synthesize for understanding — lead with the key insight, then build the full picture. Connect dots across domains and highlight what warrants deeper exploration.',
  },
};

// ─── Classification heuristics ──────────────────────────────
// Uses existing intent classification + keyword signals to select
// a court card with zero extra model calls.

const KEYWORD_SIGNALS: Array<{ card: CourtCard; weight: number; patterns: RegExp }> = [
  // King — strategy & architecture
  { card: 'king', weight: 2, patterns: /\b(strateg|architect|decision|tradeoff|trade-off|prioriti[sz]|should we|roadmap|long.?term|evaluat|compar[ei]|versus|vs\.?|pros? (?:and|&) cons?|weigh)\b/i },
  // Queen — empathy & communication
  { card: 'queen', weight: 2, patterns: /\b(explain to|help .* understand|communicate|stakeholder|team|culture|onboard|mentor|document for|write up for|how to tell|present to|narrative)\b/i },
  // Knight — action & implementation
  { card: 'knight', weight: 2, patterns: /\b(implement|build|deploy|ship|fix|execut|migrat|refactor|set up|configure|install|run|launch|unblock|do it|make it)\b/i },
  // Page — research & learning
  { card: 'page', weight: 2, patterns: /\b(research|learn|explor|investigat|what is|how does|why does|understand|discover|survey|analyz|deep.?dive|look into|find out)\b/i },
];

// Intent classification → default court card mapping
// bizops_read / bizops_mutate are optional — only active when BizOps integration is enabled
const CLASSIFICATION_DEFAULTS: Record<string, CourtCard> = {
  // Strategic
  self_improvement: 'king',
  goal_execution: 'king',
  bizops_mutate: 'king',  // Optional: BizOps write operations
  // Relational
  greeting: 'queen',
  user_correction: 'queen',
  memory_recall: 'queen',
  // Operational
  code_task: 'knight',
  code_review: 'knight',
  heartbeat: 'knight',
  // Exploratory
  general_knowledge: 'page',
  web_research: 'page',
  symbolic_consultation: 'page',
  bizops_read: 'page',    // Optional: BizOps read operations
};

/**
 * Classify a query into a court card based on intent classification and keyword signals.
 * Returns the selected profile with zero model calls.
 */
export function classifyCourtCard(
  query: string,
  classification?: string,
  complexity?: number,
): CourtCardProfile {
  // Score each card
  const scores: Record<CourtCard, number> = { king: 0, queen: 0, knight: 0, page: 0 };

  // Factor 1: Intent classification default (weight 3)
  if (classification) {
    const defaultCard = CLASSIFICATION_DEFAULTS[classification];
    if (defaultCard) scores[defaultCard] += 3;
  }

  // Factor 2: Keyword signals
  for (const signal of KEYWORD_SIGNALS) {
    if (signal.patterns.test(query)) {
      scores[signal.card] += signal.weight;
    }
  }

  // Factor 3: Complexity nudge — high complexity favors King (strategic), low favors Page (learning)
  if (complexity !== undefined) {
    if (complexity >= 3) scores.king += 1;
    else if (complexity === 0) scores.page += 1;
  }

  // Pick highest score, ties broken by: knight > king > page > queen (action bias)
  const tiebreaker: CourtCard[] = ['knight', 'king', 'page', 'queen'];
  let best: CourtCard = 'knight';
  let bestScore = -1;

  for (const card of tiebreaker) {
    if (scores[card] > bestScore) {
      bestScore = scores[card];
      best = card;
    }
  }

  return PROFILES[best];
}

/**
 * Get a court card profile by name.
 */
export function getCourtCard(card: CourtCard): CourtCardProfile {
  return PROFILES[card];
}
