import { createIntent, dispatch, type EdgeEnv } from '../dispatch.js';
import { getRecentHeartbeats } from '../memory/index.js';
import { operatorConfig } from '../../operator/index.js';
import { type HeartbeatCheck } from './heartbeat.js';

// ─── Curiosity Cycles (#66) ───────────────────────────────────

export interface CuriosityCandidate {
  topic: string;
  reason: string;
  source: 'memory_gap' | 'low_confidence' | 'failure_rate' | 'heartbeat_warn' | 'goal_failure' | 'self_interest';
}

export async function gatherCuriosityTopics(env: EdgeEnv): Promise<CuriosityCandidate[]> {
  const candidates: CuriosityCandidate[] = [];

  // Source 1: Memory gaps — topics with few entries relative to others
  if (env.memoryBinding) {
    try {
      const stats = await env.memoryBinding.stats('aegis');
      const thinTopics = stats.topics.filter(t => t.count <= 2).slice(0, 5);
      for (const t of thinTopics) {
        candidates.push({
          topic: `What more should I know about "${t.topic}"?`,
          reason: `Only ${t.count} memory entries — thin coverage`,
          source: 'memory_gap',
        });
      }
    } catch (err) {
      console.warn('[curiosity] Memory stats failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Source 2: Low-confidence memories — things I'm unsure about
  if (env.memoryBinding) {
    try {
      const lowConf = await env.memoryBinding.recall('aegis', { min_confidence: 0, limit: 20 });
      const low = lowConf.filter(f => f.confidence < 0.6).slice(0, 5);
      for (const m of low) {
        candidates.push({
          topic: `Verify: "${m.content}" (confidence ${m.confidence})`,
          reason: `Low-confidence memory in ${m.topic}`,
          source: 'low_confidence',
        });
      }
    } catch (err) {
      console.warn('[curiosity] Low-confidence recall failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Source 3: High failure-rate intent classes
  const failRates = await env.db.prepare(
    `SELECT intent_class,
       SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) as fails,
       COUNT(*) as total
     FROM episodic_memory
     WHERE created_at > datetime('now', '-7 days')
     GROUP BY intent_class
     HAVING total >= 3 AND fails * 1.0 / total > 0.3
     ORDER BY fails * 1.0 / total DESC LIMIT 3`
  ).all<{ intent_class: string; fails: number; total: number }>();

  for (const r of failRates.results) {
    const rate = ((r.fails / r.total) * 100).toFixed(0);
    candidates.push({
      topic: `Why does "${r.intent_class}" fail ${rate}% of the time?`,
      reason: `${r.fails}/${r.total} failures in last 7 days`,
      source: 'failure_rate',
    });
  }

  // Source 4: Recent heartbeat warnings
  const recentHeartbeats = await getRecentHeartbeats(env.db, 3);
  for (const hb of recentHeartbeats) {
    const checks = JSON.parse(hb.checks_json) as HeartbeatCheck[];
    for (const c of checks) {
      if (c.status === 'warn' || c.status === 'alert') {
        candidates.push({
          topic: `Investigate heartbeat "${c.name}" (${c.status})`,
          reason: c.detail.slice(0, 120),
          source: 'heartbeat_warn',
        });
      }
    }
  }

  // Source 5: Goal failures
  const goalFailures = await env.db.prepare(
    `SELECT DISTINCT a.goal_id, g.title, a.description
     FROM agent_actions a JOIN agent_goals g ON a.goal_id = g.id
     WHERE a.outcome = 'failure' AND a.created_at > datetime('now', '-7 days')
     LIMIT 3`
  ).all<{ goal_id: number; title: string; description: string }>();

  for (const gf of goalFailures.results) {
    candidates.push({
      topic: `Why did goal "${gf.title}" fail?`,
      reason: gf.description.slice(0, 120),
      source: 'goal_failure',
    });
  }

  // Source 6: Self-model interests — autonomous exploration driven by what I find interesting
  const { selfModel } = operatorConfig;
  if (selfModel?.interests.length) {
    // Rotate through interests based on day-of-year so we don't always pick the same one
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000);
    const idx = dayOfYear % selfModel.interests.length;
    const interest = selfModel.interests[idx];
    candidates.push({
      topic: `Explore recent developments in: ${interest}`,
      reason: `Self-model interest — autonomous learning driven by what I find genuinely interesting`,
      source: 'self_interest',
    });
    // Add a second interest if we have enough
    if (selfModel.interests.length > 2) {
      const idx2 = (idx + Math.floor(selfModel.interests.length / 2)) % selfModel.interests.length;
      candidates.push({
        topic: `What's new in ${selfModel.interests[idx2]}?`,
        reason: `Self-model interest — keeping current in areas that matter to me`,
        source: 'self_interest',
      });
    }
  }

  return candidates;
}

export function buildCuriosityPrompt(candidates: CuriosityCandidate[]): string {
  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.source}] ${c.topic}\n   Reason: ${c.reason}`
  ).join('\n');

  return `You are AEGIS, running a daily curiosity cycle. Below are topics mined from your operational data and self-model interests — gaps, uncertainties, patterns, and areas you find genuinely interesting.

**Candidate topics:**
${candidateList}

Pick the 1-2 most interesting or impactful topics. For each:
1. Think through what you know and don't know
2. Form a specific question or hypothesis
3. Use available tools to investigate (BizOps data, GitHub, memory, web search)
4. Record findings as memory entries — be specific, include data points
5. If investigation reveals an actionable issue, create an agenda item

Be genuinely curious. This is undirected exploration, not a checklist. Follow threads that seem interesting. Topics from your self-model interests are things YOU want to learn about — pursue them with the same rigor as operational issues.`;
}

export async function runCuriosityCycle(env: EdgeEnv): Promise<void> {
  // Guard: run at 14:00 UTC daily (morning ET, afternoon EU)
  const now = new Date();
  if (now.getUTCHours() !== 14) return;

  // Guard: 20h dedup
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_curiosity_cycle'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const hoursSince = (Date.now() - new Date(lastRun.received_at + 'Z').getTime()) / 3_600_000;
    if (hoursSince < 20) return;
  }

  const candidates = await gatherCuriosityTopics(env);
  if (candidates.length === 0) {
    console.log('[curiosity] No topics mined — skipping cycle');
    return;
  }

  const prompt = buildCuriosityPrompt(candidates);
  const intent = createIntent('curiosity-cycle', prompt, {
    source: { channel: 'internal', threadId: 'curiosity-cycle' },
    classified: 'goal_execution',
    costCeiling: 'expensive',
    raw: prompt,
  });

  try {
    const result = await dispatch(intent, env);
    console.log(`[curiosity] Cycle complete — explored ${candidates.length} candidates, $${result.cost.toFixed(4)}`);

    await env.db.prepare(
      "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_curiosity_cycle', datetime('now'))"
    ).run();
  } catch (err) {
    console.error('[curiosity] Cycle failed:', err instanceof Error ? err.message : String(err));
  }
}
