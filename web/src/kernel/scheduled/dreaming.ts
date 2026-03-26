// Dreaming Cycle — nightly reflection over conversation threads.
// Thin orchestrator that sequences 5 independent phase modules.
//
// Phase 1: Fact extraction (conversation analysis → memory)
// Phase 1b: Task proposals (extracted tasks → cc_tasks queue)
// Phase 2: Agenda triage (promote work items → GitHub issues)
// Phase 3: Persona extraction (behavioral patterns → memory)
// Phase 4: Pattern synthesis / PRISM (cross-topic connections → meta_insight)
// Phase 5: Symbolic reflection (TarotScript SingleDraw → memory)

import type { EdgeEnv } from '../dispatch.js';
import { fetchConversationThreads, extractFacts, processFacts } from './dreaming/facts.js';
import { processTaskProposals } from './dreaming/task-proposals.js';
import { triageAgendaToIssues } from './dreaming/agenda-triage.js';
import { extractPersonaDimensions } from './dreaming/persona.js';
import { runPatternSynthesis } from './dreaming/pattern-synthesis.js';
import { runSymbolicReflection } from './dreaming/symbolic.js';
import { createDynamicTool, listDynamicTools, invalidateToolCache } from '../dynamic-tools.js';

export async function runDreamingCycle(env: EdgeEnv): Promise<void> {
  // Guard: only run once per day
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_dreaming_at'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const hoursSince = (Date.now() - new Date(lastRun.received_at + 'Z').getTime()) / (1000 * 60 * 60);
    if (hoursSince < 20) return;
  }

  // Load conversation threads + CC sessions from past 24h
  const threadContents = await fetchConversationThreads(env);

  if (threadContents.length === 0) {
    await advanceWatermark(env.db);
    return;
  }

  // Phase 1: Fact extraction (blocking — phases 1b, 2 depend on result)
  const result = await extractFacts(env, threadContents);
  if (!result) {
    await advanceWatermark(env.db);
    return;
  }

  await processFacts(env, result);

  // Phase 1b + 2: Sequential (depend on extraction result)
  await processTaskProposals(env.db, result.proposed_tasks);
  await triageAgendaToIssues(env);

  // Phase 3 + 4 + 5: Independent — run in parallel
  await Promise.all([
    extractPersonaDimensions(env, threadContents),
    runPatternSynthesis(env),
    runSymbolicReflection(env),
  ]);

  await advanceWatermark(env.db);
}

async function advanceWatermark(db: D1Database): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_dreaming_at', datetime('now'))"
  ).run();
}
