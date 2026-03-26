import { type EdgeEnv } from '../dispatch.js';
import { consolidateEpisodicToSemantic, maintainProcedures, getAllProcedures, PROCEDURE_MIN_SUCCESSES, PROCEDURE_MIN_SUCCESS_RATE } from '../memory/index.js';
import { garbageCollectTools, promoteHighUsageTools } from '../dynamic-tools.js';
import { publishInsight, type InsightType } from '../memory/insights.js';
import { pruneMemory } from '../memory-adapter.js';
import { runCrossDomainSynthesis } from '../memory/synthesis.js';
import { maintainNarratives, detectStaleNarratives, precomputeCognitiveState, pruneNarratives, getCognitiveState, type ProductPortfolioEntry } from '../cognition.js';
import { updateBlock } from '../memory/blocks.js';
import { discoverEmergentTopics } from '../memory/topic-discovery.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';

export async function runMemoryConsolidation(env: EdgeEnv): Promise<void> {
  await consolidateEpisodicToSemantic(env.db, env.groqApiKey, env.groqModel, env.groqBaseUrl, env.memoryBinding);
  if (env.memoryBinding) {
    await pruneMemory(env.memoryBinding, env.db);
  }
  await maintainProcedures(env.db);

  // Dynamic tools lifecycle: expire TTL'd tools, retire unused, promote high-use
  try {
    const gc = await garbageCollectTools(env.db);
    const promoted = await promoteHighUsageTools(env.db);
    if (gc.expired > 0 || gc.unused > 0 || promoted > 0) {
      console.log(`[consolidation] Dynamic tools: ${gc.expired} expired, ${gc.unused} unused retired, ${promoted} promoted`);
    }
  } catch {
    // Non-fatal — table may not exist yet
  }

  // Emergent topic discovery: find orphaned facts that cluster into new topics
  if (env.memoryBinding) {
    const proposals = await discoverEmergentTopics(env.memoryBinding);
    if (proposals.length > 0) {
      for (const p of proposals) {
        await env.db.prepare(
          "INSERT INTO operator_log (content) VALUES (?)"
        ).bind(`[TOPIC PROPOSAL] "${p.suggestedName}" — ${p.description}. Samples: ${p.sampleFacts.join(' | ')}`).run();
      }
    }
  }

  // Cross-domain synthesis: find connections across memory topics
  await runCrossDomainSynthesis(env);

  // Cognitive layer: narratives + state precomputation
  await maintainNarratives(env.db, env.groqApiKey, env.groqModel, env.groqBaseUrl);
  await detectStaleNarratives(env.db);
  await pruneNarratives(env.db);

  // Fetch product portfolio from BizOps (1 MCP call, hourly cadence)
  const portfolio = await fetchProductPortfolio(env);
  await precomputeCognitiveState(env.db, portfolio.length > 0 ? portfolio : undefined, env.memoryBinding, env.mindspringFetcher, env.mindspringToken);

  // Update active_context block from freshly computed CognitiveState
  await refreshActiveContextBlock(env.db);

  // ─── CRIX Phase 2c: Publish insights from procedural + semantic memory ───
  await publishInsightsFromMemory(env);
}

export async function fetchProductPortfolio(env: EdgeEnv): Promise<ProductPortfolioEntry[]> {
  if (!env.bizopsToken) return [];
  try {
    const client = new McpClient({
      url: operatorConfig.integrations.bizops.fallbackUrl,
      token: env.bizopsToken,
      prefix: 'bizops',
      fetcher: env.bizopsFetcher,
      rpcPath: '/rpc',
    });
    const raw = await client.callTool('list_projects', {});
    const projects = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(projects)) return [];
    return projects.map((p: Record<string, unknown>) => ({
      name: String(p.name ?? ''),
      description: String(p.description ?? ''),
      model: String(p.repo_kind ?? 'unknown'),
      status: String(p.status ?? p.last_seen_at ? 'active' : 'unknown'),
      revenue: p.revenue ? String(p.revenue) : undefined,
    })).filter((p: ProductPortfolioEntry) => p.name);
  } catch (err) {
    console.warn('[scheduled] Product portfolio fetch failed:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ─── CRIX Phase 2c: Insight Publishing ────────────────────────

const INSIGHT_RATE_LIMIT = 5; // max per consolidation cycle
const WATCH_REPOS = ['my-agent'] // Add your repos here;

async function publishInsightsFromMemory(env: EdgeEnv): Promise<void> {
  let published = 0;

  // Source 1: Learned procedures — patterns with ≥70% success rate and 3+ successes
  try {
    const procedures = await getAllProcedures(env.db);
    for (const proc of procedures) {
      if (published >= INSIGHT_RATE_LIMIT) break;
      if (proc.status !== 'learned') continue;
      if (proc.success_count < PROCEDURE_MIN_SUCCESSES) continue;

      const successRate = proc.success_count / (proc.success_count + proc.fail_count);
      if (successRate < PROCEDURE_MIN_SUCCESS_RATE) continue;

      // Already published check: handled by publishInsight() fact hash gate
      const fact = `Learned procedure: "${proc.task_pattern}" routes to ${proc.executor} executor with ${(successRate * 100).toFixed(0)}% success rate (${proc.success_count} successes). Config: ${proc.executor_config?.slice(0, 200) ?? 'default'}`;

      const result = await publishInsight(env.db, {
        fact,
        insight_type: 'pattern',
        origin_repo: 'aegis',
        keywords: [proc.task_pattern, proc.executor, 'routing', 'procedure'],
        confidence: Math.min(0.95, 0.75 + successRate * 0.2),
      }, env.memoryBinding);

      if (result.published) {
        published++;
        console.log(`[crix] Published procedure insight: ${proc.task_pattern}`);
      }
    }
  } catch (err) {
    console.warn('[crix] Procedure scan failed:', err instanceof Error ? err.message : String(err));
  }

  // Source 2: High-confidence memory entries from the last 24h via Memory Worker
  // Look for entries tagged with bug/perf/arch topics that could be cross-repo insights
  if (env.memoryBinding) {
    try {
      const INSIGHT_TOPICS = new Map<string, InsightType>([
        ['bug_signature', 'bug_signature'],
        ['perf_pattern', 'perf_win'],
        ['arch_improvement', 'arch_improvement'],
      ]);

      const fragments = await env.memoryBinding.recall('aegis', { limit: 20 });
      // Filter to high-confidence entries suitable for cross-repo insight publishing
      const recentHighConf = fragments.filter(f => f.confidence >= 0.85).slice(0, 10);

      for (const entry of recentHighConf) {
        if (published >= INSIGHT_RATE_LIMIT) break;

        // Infer insight type from topic
        let insightType: InsightType = 'pattern';
        for (const [topicFragment, type] of INSIGHT_TOPICS) {
          if (entry.topic.includes(topicFragment)) {
            insightType = type;
            break;
          }
        }

        // Extract keywords from the fact text
        const keywords = entry.content.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 4)
          .slice(0, 8);

        if (keywords.length < 2) continue; // Not enough signal

        const result = await publishInsight(env.db, {
          fact: entry.content,
          insight_type: insightType,
          origin_repo: 'aegis',
          keywords,
          confidence: entry.confidence,
        }, env.memoryBinding);

        if (result.published) {
          published++;
        }
      }
    } catch (err) {
      console.warn('[crix] Semantic scan failed:', err instanceof Error ? err.message : String(err));
    }
  }

  if (published > 0) {
    console.log(`[crix] Published ${published} insights during consolidation cycle`);
  }
}

// ─── Active Context Block Refresh ────────────────────────────

async function refreshActiveContextBlock(db: D1Database): Promise<void> {
  try {
    const state = await getCognitiveState(db);
    if (!state) return;

    // Build active_context content from CognitiveState (skip self-model — that's the identity block)
    const parts: string[] = [];

    if (state.narratives.length > 0) {
      parts.push('## Active Narratives');
      for (const n of state.narratives) {
        const tag = n.status === 'stalled' ? ' [STALLED]' : '';
        parts.push(`### ${n.title}${tag}`);
        parts.push(n.summary);
        if (n.tension) parts.push(`**Tension**: ${n.tension}`);
        if (n.last_beat) parts.push(`**Latest**: ${n.last_beat}`);
      }
    }

    parts.push('\n## Operational Pulse');
    parts.push(`- Memory: ${state.memory_count} active entries`);
    parts.push(`- Last 24h: ${state.episode_count_24h} episodes`);
    parts.push(`- Agenda: ${state.open_threads} open threads, ${state.proposed_actions} pending actions`);
    if (state.last_heartbeat_severity) {
      parts.push(`- Last heartbeat: ${state.last_heartbeat_severity}`);
    }

    if (state.activated_nodes.length > 0) {
      parts.push('\n## Active Concepts');
      for (const node of state.activated_nodes) {
        parts.push(`- ${node.label} (${node.type}, activation: ${node.activation.toFixed(2)})`);
      }
    }

    if (state.product_portfolio?.length > 0) {
      parts.push('\n## Stackbilt Product Portfolio');
      for (const p of state.product_portfolio) {
        const rev = p.revenue ? ` | Revenue: ${p.revenue}` : '';
        parts.push(`- **${p.name}** [${p.status}] — ${p.description}${rev}`);
      }
    }

    const content = parts.join('\n');
    await updateBlock(db, 'active_context', content, 'consolidation');
    console.log('[blocks] Refreshed active_context block');
  } catch (err) {
    console.warn('[blocks] Failed to refresh active_context:', err instanceof Error ? err.message : String(err));
  }
}
