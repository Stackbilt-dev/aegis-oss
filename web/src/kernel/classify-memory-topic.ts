// Memory topic classification via TarotScript memory-topic-classify spread.
//
// The spread lives at Stackbilt-dev/tarotscript:spreads/memory-topic-classify.tarot
// and draws from decks/memory-topics (15 canonical topics for AEGIS semantic
// memory). See artifacts/tarotscript-classifier-migration.md in aegis-daemon
// for the broader design and rollout plan.
//
// Contract:
//   classifyMemoryTopic(fetcher, fact) → {
//     topic: canonical topic string,
//     confidence: 'high' | 'moderate' | 'low',
//     source: 'classifier' | 'fallback',
//     element?: element of drawn card (debugging aid),
//   }
//
// When the classifier returns confidence='low', OR when the classification
// lands on the 'general' fallback card, OR when the fetcher call fails for
// any reason, the helper falls through to { topic: 'general', source: 'fallback' }.
// Callers who want the raw classifier output can use runMemoryTopicClassification
// directly instead.
//
// Telemetry: the helper does not log or persist anything itself. Callers are
// responsible for recording divergence between operator-provided topics and
// classifier-inferred topics during the observation rollout.

// The set of canonical topics the classifier is trained to emit. Kept in sync
// with decks/memory-topics.deck in the tarotscript repo. If the deck adds a
// new card, also update this list so typecheck catches stale consumers.
export type CanonicalMemoryTopic =
  | 'operator'
  | 'feedback'
  | 'business_ops'
  | 'compliance'
  | 'execution'
  | 'content'
  | 'research'
  | 'reflection'
  | 'cross_repo_intelligence'
  | 'feed_intel'
  | 'aegis'
  | 'tarotscript'
  | 'infrastructure'
  | 'portfolio_project'
  | 'general';

export const CANONICAL_MEMORY_TOPICS: readonly CanonicalMemoryTopic[] = [
  'operator', 'feedback', 'business_ops', 'compliance', 'execution',
  'content', 'research', 'reflection', 'cross_repo_intelligence',
  'feed_intel', 'aegis', 'tarotscript', 'infrastructure',
  'portfolio_project', 'general',
] as const;

export type ClassificationConfidence = 'high' | 'moderate' | 'low';

export interface MemoryTopicClassification {
  topic: CanonicalMemoryTopic;
  confidence: ClassificationConfidence;
  source: 'classifier' | 'fallback';
  element?: string;
  receipt_hash?: string;
}

/**
 * Raw classification call. Invokes the memory-topic-classify spread on the
 * tarotscript worker and returns the parsed facts object, or null if the
 * call fails for any reason (network, auth, worker down, spread error).
 * The helper wrapper `classifyMemoryTopic` applies fallback semantics on
 * top of this; most callers should use the wrapper instead.
 */
export async function runMemoryTopicClassification(
  fetcher: Fetcher,
  fact: string,
  opts: { seed?: number } = {},
): Promise<{
  classification?: string;
  classification_confidence?: string;
  classification_element?: string;
  receipt_hash?: string;
} | null> {
  try {
    const response = await fetcher.fetch('https://internal/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spreadType: 'memory-topic-classify',
        querent: {
          id: 'aegis',
          intention: fact,
        },
        seed: opts.seed,
        inscribe: false, // classification is metadata, not a consultation
      }),
    });

    if (!response.ok) {
      console.warn(`[classify-memory-topic] worker returned ${response.status}`);
      return null;
    }

    const body = await response.json() as {
      facts?: Record<string, string>;
      receipt?: { hash?: string };
    };

    return {
      classification: body.facts?.classification,
      classification_confidence: body.facts?.classification_confidence,
      classification_element: body.facts?.classification_element,
      receipt_hash: body.receipt?.hash,
    };
  } catch (err) {
    console.warn(
      `[classify-memory-topic] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function isCanonicalTopic(value: string | undefined): value is CanonicalMemoryTopic {
  return typeof value === 'string'
    && (CANONICAL_MEMORY_TOPICS as readonly string[]).includes(value);
}

/**
 * High-level classifier with fallback. Calls the memory-topic-classify spread,
 * validates the output, and returns 'general' as a stable fallback when:
 *   - the fetcher call fails (network, auth, worker down)
 *   - the spread returns an unknown topic (deck drift — log + fall through)
 *   - the classification confidence is 'low' (deck scoring was ambiguous)
 *
 * The fallback is 'general' on purpose — that card exists in the deck for
 * exactly this reason and callers can filter on `source === 'fallback'` to
 * distinguish model output from fall-through behavior.
 */
export async function classifyMemoryTopic(
  fetcher: Fetcher,
  fact: string,
  opts: { seed?: number } = {},
): Promise<MemoryTopicClassification> {
  const raw = await runMemoryTopicClassification(fetcher, fact, opts);

  if (!raw) {
    return { topic: 'general', confidence: 'low', source: 'fallback' };
  }

  const confidence = (raw.classification_confidence ?? 'low') as ClassificationConfidence;

  if (confidence === 'low') {
    return { topic: 'general', confidence: 'low', source: 'fallback' };
  }

  if (!isCanonicalTopic(raw.classification)) {
    console.warn(
      `[classify-memory-topic] unknown canonical topic from classifier: "${raw.classification}" — falling through to 'general'`,
    );
    return { topic: 'general', confidence, source: 'fallback' };
  }

  return {
    topic: raw.classification,
    confidence,
    source: 'classifier',
    element: raw.classification_element,
    receipt_hash: raw.receipt_hash,
  };
}
