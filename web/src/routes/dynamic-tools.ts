// Dynamic Tools API — CRUD + invocation for runtime-created tools

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../types.js';
import {
  createDynamicTool,
  getDynamicTool,
  listDynamicTools,
  updateDynamicTool,
  retireDynamicTool,
  executeDynamicTool,
  invalidateToolCache,
} from '../kernel/dynamic-tools.js';
import { buildEdgeEnv } from '../edge-env.js';
import type { ToolExecutor, ToolStatus } from '../schema-enums.js';

const DYNAMIC_TOOLS_BODY_LIMIT = 100 * 1024;

const dynamicToolsRoutes = new Hono<{ Bindings: Env }>();

// GET /api/dynamic-tools — list active tools
dynamicToolsRoutes.get('/api/dynamic-tools', async (c) => {
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const tools = await listDynamicTools(c.env.DB, { status: status ?? undefined, limit });
  return c.json({ tools, count: tools.length });
});

// POST /api/dynamic-tools — create a new tool
dynamicToolsRoutes.post('/api/dynamic-tools', bodyLimit({ maxSize: DYNAMIC_TOOLS_BODY_LIMIT }), async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description: string;
      input_schema?: string;
      prompt_template: string;
      executor?: ToolExecutor;
      created_by?: string;
      ttl_days?: number;
      status?: 'active' | 'draft';
    }>();

    if (!body.name || !body.description || !body.prompt_template) {
      return c.json({ error: 'name, description, and prompt_template are required' }, 400);
    }

    const id = await createDynamicTool(c.env.DB, body);
    invalidateToolCache();
    return c.json({ id, name: body.name, status: body.status ?? 'active' }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

// GET /api/dynamic-tools/:id — get tool details
dynamicToolsRoutes.get('/api/dynamic-tools/:id', async (c) => {
  const tool = await getDynamicTool(c.env.DB, c.req.param('id'));
  if (!tool) return c.json({ error: 'Not found' }, 404);
  return c.json(tool);
});

// PUT /api/dynamic-tools/:id — update a tool
dynamicToolsRoutes.put('/api/dynamic-tools/:id', async (c) => {
  const id = c.req.param('id');
  const tool = await getDynamicTool(c.env.DB, id);
  if (!tool) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json<{
    description?: string;
    prompt_template?: string;
    executor?: ToolExecutor;
    input_schema?: string;
    status?: ToolStatus;
  }>();

  await updateDynamicTool(c.env.DB, tool.id, body);
  invalidateToolCache();
  return c.json({ updated: true, id: tool.id });
});

// DELETE /api/dynamic-tools/:id — retire a tool
dynamicToolsRoutes.delete('/api/dynamic-tools/:id', async (c) => {
  const id = c.req.param('id');
  const tool = await getDynamicTool(c.env.DB, id);
  if (!tool) return c.json({ error: 'Not found' }, 404);

  await retireDynamicTool(c.env.DB, tool.id);
  invalidateToolCache();
  return c.json({ retired: true, id: tool.id });
});

// POST /api/dynamic-tools/:id/invoke — execute a dynamic tool
dynamicToolsRoutes.post('/api/dynamic-tools/:id/invoke', bodyLimit({ maxSize: DYNAMIC_TOOLS_BODY_LIMIT }), async (c) => {
  const tool = await getDynamicTool(c.env.DB, c.req.param('id'));
  if (!tool) return c.json({ error: 'Not found' }, 404);
  if (tool.status === 'draft') return c.json({ error: 'Tool is in draft status — activate it first' }, 400);

  try {
    const body = await c.req.json<{ inputs?: Record<string, unknown> }>();
    const env = buildEdgeEnv(c.env);
    const result = await executeDynamicTool(tool, body.inputs ?? {}, env);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export { dynamicToolsRoutes };
