export interface DisambiguationRequest {
  concept: string;
  question: string;
}

const DATA_INTENT =
  /\b(what|show|calculate|report|compare|analy[sz]e|trend|metric|dashboard|how many|how much|rate)\b/i;

const KNOWN_DATA_SURFACES =
  /\b(compliance|deadline|deadlines|filing|filings|document|documents|project|projects|agenda|goal|goals|task|tasks|health|heartbeat)\b/i;

const DISAMBIGUATORS =
  /\b(by|defined as|definition|seat count|seats|mrr|arr|gross|net|monthly|annual|period|last \d+|past \d+|count|rate)\b/i;

const AMBIGUOUS_CONCEPTS: Array<{ name: string; pattern: RegExp; question: string }> = [
  {
    name: 'churn',
    pattern: /\bchurn\b/i,
    question: 'Do you mean churn by seat count, account count, revenue, MRR, or another defined basis?',
  },
  {
    name: 'retention',
    pattern: /\bretention\b/i,
    question: 'Do you mean retention by user, account, seat, revenue, cohort, or another defined basis?',
  },
  {
    name: 'active users',
    pattern: /\b(active users?|users?)\b/i,
    question: 'Do you mean active users by login, event activity, paid seat, account membership, or another defined rule?',
  },
  {
    name: 'conversion',
    pattern: /\b(conversion|activation)\b/i,
    question: 'Do you mean conversion by visit, signup, qualified lead, paid account, or another funnel step?',
  },
  {
    name: 'revenue',
    pattern: /\b(revenue|growth)\b/i,
    question: 'Do you mean revenue by gross, net, MRR, ARR, cash receipts, or another defined basis?',
  },
];

export function detectDisambiguationNeed(message: string): DisambiguationRequest | null {
  if (!DATA_INTENT.test(message)) return null;
  if (KNOWN_DATA_SURFACES.test(message)) return null;
  if (DISAMBIGUATORS.test(message)) return null;

  for (const concept of AMBIGUOUS_CONCEPTS) {
    if (concept.pattern.test(message)) {
      return { concept: concept.name, question: concept.question };
    }
  }

  return null;
}
