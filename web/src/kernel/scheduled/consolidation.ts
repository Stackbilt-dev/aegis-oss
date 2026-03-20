import { type EdgeEnv } from '../dispatch.js';
import { consolidateEpisodicToSemantic, maintainProcedures, getAllProcedures, PROCEDURE_MIN_SUCCESSES, PROCEDURE_MIN_SUCCESS_RATE } from '../memory/index.js';
import { pruneMemory } from '../memory-adapter.js';
import { runCrossDomainSynthesis } from '../memory/synthesis.js';
import { maintainNarratives, detectStaleNarratives, precomputeCognitiveState, pruneNarratives, getCognitiveState, type ProductPortfolioEntry } from '../cognition.js';
import { updateBlock } from '../memory/blocks.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';

export async function runMemoryConsolidation(env: EdgeEnv): Promise<void> {
  await consolidateEpisodicToSemantic(env.db, env.groqApiKey, env.groqModel, env.groqBaseUrl, env.memoryBinding);
  if (env.memoryBinding) {
    await pruneMemory(env.memoryBinding, env.db);
  }
  await maintainProcedures(env.db);

  // Cross-domain synthesis: find connections across memory topics
  await runCrossDomainSynthesis(env);

  // Cognitive layer: narratives + state precomputation
  await maintainNarratives(env.db, env.groqApiKey, env.groqModel, env.groqBaseUrl);
  await detectStaleNarratives(env.db);
  await pruneNarratives(env.db);

  // Fetch product portfolio from BizOps if configured (1 MCP call, hourly cadence)
  const portfolio = await fetchProductPortfolio(env);
  await precomputeCognitiveState(env.db, portfolio.length > 0 ? portfolio : undefined, env.memoryBinding, env.mindspringFetcher, env.mindspringToken);

  // Update active_context block from freshly computed CognitiveState
  await refreshActiveContextBlock(env.db);

  // Insight publishing removed in OSS build
}

export async function fetchProductPortfolio(env: EdgeEnv): Promise<ProductPortfolioEntry[]> {
  if (!env.bizopsToken || !operatorConfig.integrations.bizops.enabled) return [];
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
      parts.push('\n## Product Portfolio');
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
