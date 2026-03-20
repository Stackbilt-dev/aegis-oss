import { getProcedure, findNearMiss, procedureKey, PROCEDURE_MIN_SUCCESSES, PROCEDURE_MIN_SUCCESS_RATE, getConversationHistory } from './memory/index.js';
import { askGroq, askGroqWithLogprobs } from '../groq.js';
import type { KernelIntent, ExecutionPlan, Executor } from './types.js';
import { buildClassifySystem, getTaskPatterns } from '../operator/prompt-builder.js';
import { domainPreFilter } from './domain.js';

// ─── Confidence Thresholds ──────────────────────────────────
const CONFIDENCE_TRUST = 0.80;   // ≥ 0.80 → use classification as-is
const CONFIDENCE_VERIFY = 0.50;  // 0.50–0.79 → re-classify with Groq logprobs
                                 // < 0.50 → escalate (skip procedural lookup)

// ─── TarotScript classify-cast (zero inference, deterministic) ─

// Map TarotScript confidence levels to numeric values
const TS_CONFIDENCE: Record<string, number> = { high: 0.92, moderate: 0.70, low: 0.35 };

function cardNameToClassification(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_');
}

interface ClassifyCastFacts {
  classification?: string;
  classification_complexity?: string;
  classification_needs_tools?: string;
  classification_confidence?: string;
  tiebreaker_override?: string;
  compound_intent?: string;
  secondary_classification?: string;
}

async function classifyWithTarotScript(
  fetcher: Fetcher,
  message: string,
  source: string,
): Promise<{ classification: string; complexity: number; needsTools: boolean; confidence: number } | null> {
  const response = await fetcher.fetch('https://tarotscript-worker/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spreadType: 'classify-cast',
      querent: {
        id: 'aegis-router',
        intention: message,
        state: { message, source },
      },
    }),
  });

  if (!response.ok) return null;

  const result = await response.json() as { facts?: ClassifyCastFacts };
  const facts = result.facts;
  if (!facts?.classification) return null;

  // Apply tiebreaker override if present
  const override = facts.tiebreaker_override && facts.tiebreaker_override !== 'none'
    ? facts.tiebreaker_override : null;
  const rawClass = override ?? cardNameToClassification(facts.classification);

  return {
    classification: rawClass,
    complexity: parseInt(facts.classification_complexity ?? '2', 10),
    needsTools: facts.classification_needs_tools === 'true',
    confidence: TS_CONFIDENCE[facts.classification_confidence ?? 'moderate'] ?? 0.70,
  };
}

// ─── Workers AI classification (zero cost, zero network hop) ─

async function classifyWithWorkersAI(
  ai: Ai,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const result = await ai.run('@cf/meta/llama-3.2-3b-instruct', {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 200,
    temperature: 0.1,
  }) as { response?: string };
  return result.response ?? '';
}



// Fallback routes — used for degraded procedure replanning and when JSON classification fails
const DEFAULT_ROUTES: Record<string, Executor> = {
  heartbeat: 'direct',
  bizops_read: 'gpt_oss',
  bizops_mutate: 'gpt_oss',
  general_knowledge: 'gpt_oss',
  memory_recall: 'gpt_oss',
  greeting: 'gpt_oss',
  code_task: 'claude_code',
  code_review: 'gpt_oss',
  self_improvement: 'composite',
  web_research: 'gpt_oss',
  goal_execution: 'composite',
  symbolic_consultation: 'tarotscript',
  support_triage: 'tarotscript',
  tarot_pulse: 'tarotscript',
  tarot_trajectory: 'tarotscript',
  tarot_multi_angle: 'tarotscript',
  tarot_deep: 'tarotscript',
  tarot_shadow: 'tarotscript',
  tarot_orchestration: 'tarotscript',
  tarot_planning: 'tarotscript',
};

// Patterns that are explicitly decomposable into parallel tool subtasks.
// All other patterns stay on single-model executors that preserve conversation
// history and avoid the orchestrator reinterpreting user intent.
const COMPOSITE_ELIGIBLE: ReadonlySet<string> = new Set([
  'self_improvement',  // code review + GitHub + analysis — always multi-model
  'goal_execution',    // autonomous goals — often multi-tool
]);

// Complexity-aware executor selection — used for Phase 3 (no mature procedure)
function selectDefaultExecutor(classification: string, intent: KernelIntent): Executor {
  const complexity = intent.complexity ?? 2;
  const needsTools = intent.needsTools ?? true;
  const confidence = intent.confidence ?? 0.8;

  // Fixed executors (unchanged regardless of complexity or confidence)
  if (classification === 'heartbeat') return 'direct';
  if (classification === 'greeting') return 'gpt_oss'; // GPT-OSS 120B — smart enough for re-entry briefing
  if (classification === 'code_task') return 'claude_code';
  if (classification === 'symbolic_consultation') return 'tarotscript';
  if (classification === 'support_triage') return 'tarotscript';
  // User corrections need thread history to understand the original intent
  if (classification === 'user_correction') return 'gpt_oss';
  // memory_recall needs buildContext() for semantic memory access — never route to
  // workers_ai or groq which lack memory context (see: equity recall failure 2026-03-04)
  if (classification === 'memory_recall') return 'gpt_oss';

  // Self-improvement always needs multi-model pipeline (code review + GitHub + analysis)
  if (classification === 'self_improvement') return 'composite';

  // Goal execution: complexity-aware routing
  // Simple goals (single tool call) → gpt_oss (direct tool loop, no 4-model overhead)
  // Complex goals (multi-step reasoning) → composite
  if (classification === 'goal_execution') {
    if (complexity <= 1 && needsTools) return 'gpt_oss';
    return 'composite';
  }

  // ─── Confidence-based tier escalation ────────────────────
  // Escalate zone (<0.50): classification itself is suspect → send to Claude
  if (confidence < CONFIDENCE_VERIFY) return 'claude';

  // High complexity → Opus (deep reasoning)
  if (complexity >= 3) return 'claude_opus';

  // Verify zone (0.50-0.79): bump one tier for safety margin
  // Only route to composite if the pattern is explicitly decomposable.
  // Conversational/advisory follow-ups stay on single-model executors that
  // preserve thread history and avoid orchestrator intent drift.
  if (confidence < CONFIDENCE_TRUST) {
    if (needsTools) return 'gpt_oss';
    if (complexity <= 1) return 'gpt_oss'; // workers_ai → gpt_oss
    return 'claude'; // moderate no-tool → claude
  }

  // ─── Trust zone (≥0.80): standard routing ───────────────

  // BizOps mutations stay on gpt_oss — the single-model tool loop handles
  // sequential lookup→update patterns better than multi-model decomposition,
  // which splits them into parallel subtasks that can't share data (#85).
  if (classification === 'bizops_mutate') return 'gpt_oss';

  // Tool-requiring patterns → GPT-OSS-120B (single-model tool loop with thread history)
  // Composite is reserved for COMPOSITE_ELIGIBLE patterns only.
  if (needsTools) return 'gpt_oss';
  if (['bizops_read', 'web_research'].includes(classification)) return 'gpt_oss';

  // Simple no-tool queries → Workers AI (Llama 70B, cheapest)
  if (complexity <= 1) return 'workers_ai';

  // Moderate no-tool → GPT-OSS-120B
  return 'gpt_oss';
}

export interface RouteResult {
  plan: ExecutionPlan;
  nearMiss?: string;
  reclassified?: boolean;
}

export async function route(
  intent: KernelIntent,
  db: D1Database,
  groqApiKey: string,
  groqModel: string,
  groqBaseUrl?: string,
  ai?: Ai,
  tarotscriptFetcher?: Fetcher,
): Promise<RouteResult> {
  // ─── Phase 0: Internal triggers bypass classification ──────
  if (intent.source.channel === 'internal' && intent.classified) {
    const procKey = procedureKey(intent.classified, intent.complexity);
    const procedure = await getProcedure(db, procKey);

    if (procedure) {
      if (procedure.status === 'degraded' || procedure.status === 'broken') {
        return {
          plan: {
            executor: DEFAULT_ROUTES[intent.classified] ?? 'direct',
            reasoning: `Internal trigger "${intent.classified}" — procedure ${procedure.status}, replanning`,
            costCeiling: 'free',
          },
        };
      }

      if (procedure.success_count >= PROCEDURE_MIN_SUCCESSES) {
        return {
          plan: {
            executor: procedure.executor as Executor,
            reasoning: `Internal trigger with known procedure (${procedure.success_count} successes)`,
            procedureId: procedure.id,
            costCeiling: intent.costCeiling,
          },
        };
      }
    }

    return {
      plan: {
        executor: DEFAULT_ROUTES[intent.classified] ?? 'direct',
        reasoning: `Internal trigger "${intent.classified}" — no mature procedure, using default`,
        costCeiling: 'free',
      },
    };
  }

  // ─── Phase 0.5: Domain pre-filter (observe only) ──────────
  const domainTag = domainPreFilter(intent.raw);
  intent.domain = domainTag.domain;
  intent.domainConfidence = domainTag.confidence;
  console.log(`[router] domain pre-filter: ${domainTag.domain} (confidence=${domainTag.confidence.toFixed(2)})`);

  // ─── Phase 1: Classification ──────────────────────────────
  // Priority: TarotScript classify-cast (zero cost, semantic keyword matching)
  //         → Workers AI (zero cost, zero network hop)
  //         → Groq (low cost fallback)
  let classification = '';
  let routerNearMiss: string | undefined;

  // Fetch recent conversation context for multi-turn classification
  let classifyInput = intent.raw;
  if (intent.source.channel === 'web' && intent.source.threadId) {
    try {
      const history = await getConversationHistory(db, intent.source.threadId, 4);
      if (history.length > 0) {
        const contextLines = history.slice(-4).map(m =>
          `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`
        ).join('\n');
        classifyInput = `[Conversation context]\n${contextLines}\n\n[Current message to classify]\n${intent.raw}`;
      }
    } catch {
      // Context fetch failed — classify without it
    }
  }

  // ── Phase 1a: TarotScript classify-cast ──
  if (tarotscriptFetcher) {
    try {
      const tsResult = await classifyWithTarotScript(
        tarotscriptFetcher,
        intent.raw,
        intent.source.channel === 'internal' ? 'internal' : 'user',
      );

      if (tsResult && getTaskPatterns().includes(tsResult.classification)) {
        classification = tsResult.classification;
        intent.complexity = tsResult.complexity;
        intent.needsTools = tsResult.needsTools;
        intent.confidence = tsResult.confidence;
        intent.classifierSource = 'classify-cast';
        console.log(`[router] classify-cast: ${classification} (confidence=${tsResult.confidence})`);
      }
    } catch (err) {
      console.warn('[router] classify-cast failed, falling back to LLM chain:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Phase 1b: LLM fallback (Workers AI → Groq) ──
  if (!classification) {
    const classifySystem = buildClassifySystem();
    let rawClassification: string | null = null;

    if (ai) {
      try {
        rawClassification = await classifyWithWorkersAI(ai, classifySystem, classifyInput);
        if (!rawClassification || rawClassification.trim().length === 0) {
          rawClassification = null;
        } else {
          intent.classifierSource = 'workers-ai';
        }
      } catch (err) {
        console.warn('[router] Workers AI classification failed, falling back to Groq:', err instanceof Error ? err.message : String(err));
      }
    }

    if (!rawClassification) {
      try {
        rawClassification = await askGroq(groqApiKey, groqModel, classifySystem, classifyInput, groqBaseUrl);
        intent.classifierSource = 'groq';
      } catch (err) {
        console.warn('[router] Groq classification failed — falling back to general_knowledge:', err instanceof Error ? err.message : String(err));
        routerNearMiss = 'router_fallback:groq_error';
        classification = 'general_knowledge';
      }
    }

    if (rawClassification && !classification) {
      const cleaned = rawClassification.trim();
      try {
        const parsed = JSON.parse(cleaned);
        classification = (parsed.pattern as string ?? '').toLowerCase().replace(/[^a-z_]/g, '');
        intent.complexity = parsed.complexity ?? 2;
        intent.needsTools = parsed.needs_tools ?? false;
        intent.confidence = parsed.confidence ?? 0.8;
      } catch {
        classification = cleaned.toLowerCase().replace(/[^a-z_]/g, '');
      }

      if (!getTaskPatterns().includes(classification)) {
        console.warn(`[router] unrecognized classification "${cleaned.slice(0, 80)}" — falling back to general_knowledge`);
        routerNearMiss = `router_fallback:invalid_class:${cleaned.slice(0, 50)}`;
        classification = 'general_knowledge';
      }
    }
  }

  if (!classification) {
    classification = 'general_knowledge';
  }

  intent.classified = classification;

  // ─── Phase 1.5: Confidence evaluation ──────────────────────
  const confidence = intent.confidence ?? 0.8;
  let reclassified = false;

  if (confidence < CONFIDENCE_VERIFY) {
    // Escalate zone (<0.50): classification is suspect — skip procedural lookup,
    // go straight to confidence-aware default routing
    console.log(`[router] Low confidence ${confidence.toFixed(2)} for "${classification}" — escalating`);
    const executor = selectDefaultExecutor(classification, intent);
    return {
      plan: {
        executor,
        reasoning: `Low-confidence classification (${confidence.toFixed(2)}) "${classification}" → escalated to ${executor}`,
        costCeiling: executor === 'claude' || executor === 'claude_opus' ? 'expensive' : executor === 'composite' ? 'expensive' : 'cheap',
      },
      nearMiss: routerNearMiss,
      reclassified: false,
    };
  }

  if (confidence < CONFIDENCE_TRUST) {
    // Verify zone (0.50-0.79): re-classify with Groq 70B + logprobs for a second opinion
    try {
      const groqResult = await askGroqWithLogprobs(
        groqApiKey,
        groqModel,
        buildClassifySystem(),
        classifyInput,
        groqBaseUrl,
      );

      if (groqResult.tokenConfidence >= 0.75) {
        // Groq is confident — adopt its classification
        const newClass = groqResult.pattern;
        if (getTaskPatterns().includes(newClass)) {
          console.log(`[router] Reclassified "${classification}" → "${newClass}" (token confidence ${groqResult.tokenConfidence.toFixed(2)})`);
          classification = newClass;
          intent.classified = classification;
          intent.complexity = groqResult.complexity;
          intent.needsTools = groqResult.needs_tools;
          intent.confidence = groqResult.selfReportedConfidence;
          reclassified = true;
        }
      } else {
        // Groq also uncertain — let low confidence flow into Phase 3
        console.log(`[router] Groq also uncertain (token=${groqResult.tokenConfidence.toFixed(2)}) for "${classification}" — keeping with verify-zone routing`);
      }
    } catch (err) {
      console.warn('[router] Groq logprobs re-classification failed:', err instanceof Error ? err.message : String(err));
      // Failure to re-classify is non-fatal — continue with original classification + verify-zone routing
    }
  }

  // ─── Phase 2: Procedural lookup ───────────────────────────
  const procKey = procedureKey(classification, intent.complexity);
  const procedure = await getProcedure(db, procKey);
  let nearMiss: string | undefined;

  if (procedure) {
    if (procedure.status === 'degraded' || procedure.status === 'broken') {
      const executor = DEFAULT_ROUTES[classification] ?? 'claude';
      return {
        plan: {
          executor,
          reasoning: `Procedure "${procKey}" is ${procedure.status} — replanning via ${executor}`,
          costCeiling: executor === 'groq' ? 'cheap' : executor === 'direct' ? 'free' : 'expensive',
        },
      };
    }

    const total = procedure.success_count + procedure.fail_count;
    const successRate = total > 0 ? procedure.success_count / total : 0;

    if (procedure.success_count >= PROCEDURE_MIN_SUCCESSES && successRate >= PROCEDURE_MIN_SUCCESS_RATE) {
      return {
        plan: {
          executor: procedure.executor as Executor,
          reasoning: `Matched procedure "${procKey}" (${procedure.success_count} successes, ${Math.round(procedure.avg_latency_ms)}ms avg)`,
          procedureId: procedure.id,
          costCeiling: intent.costCeiling,
        },
      };
    }
  } else {
    nearMiss = (await findNearMiss(db, procKey)) ?? undefined;
  }

  // ─── Phase 3: Complexity-aware routing ───────────────────
  const executor = selectDefaultExecutor(classification, intent);

  return {
    plan: {
      executor,
      reasoning: `First-time routing: "${classification}" → ${executor} (complexity=${intent.complexity ?? '?'}, tools=${intent.needsTools ?? '?'}, confidence=${confidence.toFixed(2)})`,
      costCeiling: executor === 'groq' || executor === 'workers_ai' || executor === 'gpt_oss' ? 'cheap' : executor === 'direct' ? 'free' : executor === 'composite' ? 'expensive' : 'expensive',
    },
    nearMiss: nearMiss ?? routerNearMiss,
    reclassified,
  };
}
