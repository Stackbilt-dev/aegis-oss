import { type EdgeEnv } from '../dispatch.js';
import { consolidateEpisodicToSemantic, maintainProcedures } from '../memory/index.js';
import { garbageCollectTools, promoteHighUsageTools } from '../dynamic-tools.js';
import { pruneMemory } from '../memory-adapter.js';
import { runCrossDomainSynthesis } from '../memory/synthesis.js';
import { maintainNarratives, detectStaleNarratives, precomputeCognitiveState, pruneNarratives, getCognitiveState, type ProductPortfolioEntry } from '../cognition.js';
import { updateBlock } from '../memory/blocks.js';
// topic-discovery is an extension point — consumers can provide their own
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function discoverEmergentTopics(_db: D1Database, _binding: any): Promise<void> { /* no-op in core */ }
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';

export async function runMemoryConsolidation(env: EdgeEnv): Promise<void> {
  await consolidateEpisodicToSemantic(env.db, env.groqApiKey, env.groqModel, env.groqBaseUrl, {
    wikiBinding: env.wikiBinding,
    wikiToken: env.wikiToken,
  });
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
    await discoverEmergentTopics(env.db, env.memoryBinding);
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
