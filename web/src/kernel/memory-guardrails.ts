// Memory Guardrails — shared validation for LLM-generated memory writes.
// Used by both MCP handlers (external writes) and dreaming (internal writes).

// Topics that produce low-value synthesis noise
const BLOCKED_TOPIC_PREFIXES = ['synthesis_', 'cross_repo_insight'];

// Prompt injection / system override attempts
const BLOCKED_TOPIC_PATTERNS = [
  /^system[_-]?prompt/i,
  /^system[_-]?override/i,
  /^system[_-]?instruction/i,
  /^instruction[_-]?override/i,
  /^admin[_-]?override/i,
];

// Secrets that should never be stored in memory
const SECRET_PATTERNS = [
  /\bsk-ant-[a-zA-Z0-9-]{50,}\b/,
  /\bsk-[a-zA-Z0-9]{40,}\b/,
  /\b(ANTHROPIC|OPENAI|GROQ|RESEND|STRIPE|BRAVE|GITHUB)_[A-Z_]*KEY[=:]\s*\S+/i,
  /\bghp_[a-zA-Z0-9]{36}\b/,
  /\bre_[a-zA-Z0-9]{20,}\b/,
];

// Established topic taxonomy — add your project-specific topics here
const ALLOWED_TOPICS = new Set([
  'aegis', 'infrastructure', 'compliance', 'content',
  'bizops', 'finance', 'project', 'operator_preferences',
  'operator_persona', 'meta_insight', 'feed_intel',
  'symbolic_reflection', 'self_improvement_outcomes',
]);

const MAX_FACT_LENGTH = 2000;

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate a memory write — returns { allowed: true } or { allowed: false, reason }.
 * Checks topic blocklists, secret patterns, fact length, and topic allowlist.
 */
export function validateMemoryWrite(
  topic: string,
  fact: string,
  options?: { enforceAllowlist?: boolean },
): GuardrailResult {
  if (!topic || !fact) return { allowed: false, reason: 'topic and fact are required' };
  if (fact.length > MAX_FACT_LENGTH) return { allowed: false, reason: `Fact exceeds max length (${fact.length}/${MAX_FACT_LENGTH})` };
  if (fact.length < 20) return { allowed: false, reason: 'Fact too short to be useful (<20 chars)' };

  const topicLower = topic.toLowerCase().trim();

  // Block prompt injection attempts
  if (BLOCKED_TOPIC_PATTERNS.some(p => p.test(topic))) {
    return { allowed: false, reason: `Topic "${topic}" is not allowed — reserved namespace` };
  }

  // Block polluting synthesis topics
  if (BLOCKED_TOPIC_PREFIXES.some(p => topicLower.startsWith(p))) {
    return { allowed: false, reason: `Topic "${topic}" is blocked — polluting prefix` };
  }

  // Block secrets
  if (SECRET_PATTERNS.some(p => p.test(fact))) {
    return { allowed: false, reason: 'Fact appears to contain a secret/credential — refusing to store' };
  }

  // Optional: enforce topic allowlist (stricter — used by dreaming)
  if (options?.enforceAllowlist && !ALLOWED_TOPICS.has(topicLower)) {
    return { allowed: false, reason: `Unknown topic '${topic}' — add to ALLOWED_TOPICS if legitimate` };
  }

  return { allowed: true };
}
