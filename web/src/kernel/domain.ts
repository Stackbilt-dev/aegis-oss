// ─── Domain Pre-Filter (Phase 0 — observe only) ────────────
// Tags queries with a domain slug from a fixed taxonomy.
// Does NOT affect routing — purely observational for data collection.

export interface DomainTag {
  domain: string;      // slug from taxonomy
  confidence: number;  // 0.0-1.0
}

const DOMAIN_SIGNALS: Record<string, RegExp[]> = {
  legal: [/\bllc\b/i, /\bcompliance\b/i, /\bfiling\b/i, /\bcontract\b/i, /\bcorporat/i, /\bein\b/i, /\bregistered agent/i, /\btrademark\b/i],
  finance: [/\brevenue\b/i, /\bcost\b/i, /\bcogs\b/i, /\bmargin\b/i, /\btax\b/i, /\binvoice\b/i, /\bstripe\b/i, /\brunway\b/i, /\bburn\b/i],
  technical: [/\binfra/i, /\bdevops\b/i, /\bdeploy/i, /\bworker\b/i, /\bcloudflare\b/i, /\bd1\b/i, /\bkv\b/i, /\bdurable object/i],
  software: [/\brefactor/i, /\bfunction\b/i, /\bclass\b/i, /\bapi\b/i, /\bendpoint\b/i, /\btypescript\b/i, /\bbug\b/i],
  ai_ml: [/\bmodel\b/i, /\bllm\b/i, /\binference\b/i, /\btraining\b/i, /\bagent\b/i, /\bprompt\b/i, /\bembedding/i, /\bvector/i],
  creative: [/\bblog\b/i, /\bwriting\b/i, /\bdesign\b/i, /\bcontent\b/i, /\bmarketing\b/i],
  operations: [/\bproject\b/i, /\bsprint\b/i, /\bpipeline\b/i, /\bprocess\b/i, /\bworkflow\b/i],
  general: [],  // fallback
};

export function domainPreFilter(query: string): DomainTag {
  let bestDomain = 'general';
  let bestCount = 0;
  let tied = false;

  for (const [domain, patterns] of Object.entries(DOMAIN_SIGNALS)) {
    if (patterns.length === 0) continue;
    let matchCount = 0;
    for (const pattern of patterns) {
      if (pattern.test(query)) matchCount++;
    }
    if (matchCount > bestCount) {
      bestDomain = domain;
      bestCount = matchCount;
      tied = false;
    } else if (matchCount > 0 && matchCount === bestCount) {
      tied = true;
    }
  }

  // No matches or tie → general with low confidence
  if (bestCount === 0 || tied) {
    return { domain: 'general', confidence: 0.3 };
  }

  const totalPossible = DOMAIN_SIGNALS[bestDomain].length;
  const confidence = totalPossible > 0 ? bestCount / totalPossible : 0.3;

  return { domain: bestDomain, confidence };
}
