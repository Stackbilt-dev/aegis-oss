// Product Health Sweep -- pings each product's /health endpoint
// and writes status back to BizOps via the project_heartbeat MCP tool.
// Configure your products below or via operator config.

import { type EdgeEnv } from '../dispatch.js';
import { McpClient } from '../../mcp-client.js';
import { operatorConfig } from '../../operator/index.js';

interface ProductTarget {
  name: string;
  bizopsProjectId: string;
  healthUrl: string;
  /** Extract version + status from the /health JSON response */
  parse: (body: unknown) => { version?: string; status: string };
}

// Configure your product health targets here.
// Each entry defines a /health endpoint to poll and how to parse it.
const PRODUCTS: ProductTarget[] = [
  // Example:
  // {
  //   name: 'my-api',
  //   bizopsProjectId: '',
  //   healthUrl: 'https://api.example.com/health',
  //   parse: (b) => {
  //     const d = b as { status?: string; version?: string };
  //     return { status: d.status ?? 'unknown', version: d.version };
  //   },
  // },
];

export async function runProductHealthSweep(env: EdgeEnv): Promise<void> {
  if (PRODUCTS.length === 0) return;

  // Rate-limit: run once every 6 hours
  const lastRun = await env.db.prepare(
    "SELECT received_at FROM web_events WHERE event_id = 'last_product_health_sweep'"
  ).first<{ received_at: string }>();

  if (lastRun) {
    const hoursSince = (Date.now() - new Date(lastRun.received_at + 'Z').getTime()) / (1000 * 60 * 60);
    if (hoursSince < 6) return;
  }

  const client = new McpClient({
    url: operatorConfig.integrations.bizops.fallbackUrl,
    token: env.bizopsToken,
    prefix: 'bizops',
    fetcher: env.bizopsFetcher,
    rpcPath: '/rpc',
  });

  for (const product of PRODUCTS) {
    let healthStatus = 'unreachable';
    let version: string | undefined;
    let detail = '';

    try {
      const resp = await fetch(product.healthUrl, {
        signal: AbortSignal.timeout(5_000),
      });

      if (resp.ok) {
        const body = await resp.json();
        const parsed = product.parse(body);
        healthStatus = parsed.status === 'ok' || parsed.status === 'healthy' ? 'healthy' : parsed.status;
        version = parsed.version;
      } else {
        healthStatus = 'degraded';
        detail = `HTTP ${resp.status}`;
      }
    } catch (err) {
      healthStatus = 'unreachable';
      detail = err instanceof Error ? err.message : String(err);
    }

    // Log status (always)
    const statusLine = `[product-health] ${product.name}: ${healthStatus}${version ? ` v${version}` : ''}${detail ? ` (${detail})` : ''}`;
    if (healthStatus === 'unreachable' || healthStatus === 'degraded') {
      console.error(statusLine);
    } else {
      console.log(statusLine);
    }

    // Write back to BizOps (only for products with a project ID)
    if (product.bizopsProjectId) {
      try {
        const args: Record<string, unknown> = {
          id: product.bizopsProjectId,
          health_status: healthStatus,
        };
        if (version) args.deploy_version = version;
        if (healthStatus === 'healthy') args.deploy_status = 'live';
        if (detail) args.health_details = detail;

        await client.callTool('project_heartbeat', args);
      } catch (err) {
        console.warn(`[product-health] BizOps writeback failed for ${product.name}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Advance watermark
  await env.db.prepare(
    "INSERT OR REPLACE INTO web_events (event_id, received_at) VALUES ('last_product_health_sweep', datetime('now'))"
  ).run();
}
