// sanitize.ts — strip PII and internal identifiers from content before publishing
//
// Used by operator-log and reflection pipelines to make internal content
// safe for the public blog. Applies regex-based redactions in a single pass.

// ─── Known internal entities (replace with generic labels) ───
const ENTITY_MAP: [RegExp, string][] = [
  // Company / product names that reveal internal structure
  [/ExampleCo\s+LLC/gi, '[Company]'],
  [/Citizens\s+Reunited,?\s*PBC/gi, '[Partner Org]'],
  [/Citizens\s+Reunited/gi, '[Partner Org]'],

  // People — full names only (first names are OK per journal guidelines)
  [/Jane\s+Doe/gi, '[Operator]'],
  [/John\s+Doe/gi, '[Client]'],

  // Internal service names that shouldn't be public
  [/bizops-copilot/gi, '[internal-service]'],
  [/aegis-memory/gi, '[memory-service]'],
];

// ─── Regex patterns for sensitive data ───────────────────────
const SENSITIVE_PATTERNS: [RegExp, string][] = [
  // EIN (XX-XXXXXXX)
  [/\b\d{2}-\d{7}\b/g, '[EIN-REDACTED]'],

  // UUIDs
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID-REDACTED]'],

  // API tokens / bearer tokens (aegis_*, memory_*, sk-*, etc.)
  [/\b(?:aegis|memory|sk|Bearer)\s*[_-]?[a-zA-Z0-9]{16,}\b/gi, '[TOKEN-REDACTED]'],

  // Email addresses
  [/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, '[EMAIL-REDACTED]'],

  // Phone numbers (US formats)
  [/\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g, '[PHONE-REDACTED]'],

  // Credit card numbers (13-19 digits, possibly separated)
  [/\b(?:\d[-\s]?){13,19}\b/g, '[CC-REDACTED]'],

  // IP addresses
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP-REDACTED]'],

  // Dollar amounts with specific figures (keep general like "$500" but redact exact like "$10.42")
  [/\$\d{1,3}(?:,\d{3})*\.\d{2}\b/g, '[AMOUNT-REDACTED]'],

  // Cloudflare account IDs (32-char hex)
  [/\b[0-9a-f]{32}\b/g, '[ACCOUNT-REDACTED]'],

  // Internal URLs with tokens or auth paths
  [/https?:\/\/[^\s]*(?:token|secret|key|auth)[^\s]*/gi, '[URL-REDACTED]'],
];

/**
 * Sanitize content for public blog publication.
 * Strips PII, internal identifiers, and sensitive business data.
 */
export function sanitizeForBlog(content: string): string {
  let result = content;

  // Pass 1: Named entity replacements
  for (const [pattern, replacement] of ENTITY_MAP) {
    result = result.replace(pattern, replacement);
  }

  // Pass 2: Sensitive data patterns
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}
