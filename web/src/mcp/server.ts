import type { EdgeEnv } from '../kernel/dispatch.js';
import { TOOLS } from './tools.js';
import {
  toolAegisChat,
  toolAegisConversations,
  toolAegisConversationHistory,
  toolAegisAgenda,
  toolAegisHealth,
  toolAegisMemory,
  toolAegisRecordMemory,
  toolAegisForgetMemory,
  toolAegisAddAgenda,
  toolAegisResolveAgenda,
  toolAegisAddGoal,
  toolAegisUpdateGoal,
  toolAegisListGoals,
  toolAegisCcSessions,
  toolAegisCreateCcTask,
  toolAegisListCcTasks,
  toolAegisCancelCcTask,
  toolAegisApproveCcTask,
  toolAegisTaskSummary,
  toolAegisBatchApprove,
  toolAegisPublishTechPost,
  toolAegisGenerateDecisionDoc,
  toolAegisCreateDynamicTool,
  toolAegisInvokeDynamicTool,
  toolAegisListDynamicTools,
  type ToolResult,
} from './handlers.js';

// ─── MCP Protocol ───────────────────────────────────────────

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'aegis', version: '0.1.0' };

// ─── JSON-RPC Types ─────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool Dispatch ──────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>, env: EdgeEnv): Promise<ToolResult> {
  switch (name) {
    case 'aegis_chat': return toolAegisChat(args, env);
    case 'aegis_conversations': return toolAegisConversations(args, env);
    case 'aegis_conversation_history': return toolAegisConversationHistory(args, env);
    case 'aegis_agenda': return toolAegisAgenda(env);
    case 'aegis_health': return toolAegisHealth(env);
    case 'aegis_memory': return toolAegisMemory(args, env);
    case 'aegis_record_memory': return toolAegisRecordMemory(args, env);
    case 'aegis_forget_memory': return toolAegisForgetMemory(args, env);
    case 'aegis_add_agenda': return toolAegisAddAgenda(args, env);
    case 'aegis_resolve_agenda': return toolAegisResolveAgenda(args, env);
    case 'aegis_add_goal': return toolAegisAddGoal(args, env);
    case 'aegis_update_goal': return toolAegisUpdateGoal(args, env);
    case 'aegis_list_goals': return toolAegisListGoals(env);
    case 'aegis_cc_sessions': return toolAegisCcSessions(args, env);
    case 'aegis_create_cc_task': return toolAegisCreateCcTask(args, env);
    case 'aegis_list_cc_tasks': return toolAegisListCcTasks(args, env);
    case 'aegis_cancel_cc_task': return toolAegisCancelCcTask(args, env);
    case 'aegis_approve_cc_task': return toolAegisApproveCcTask(args, env);
    case 'aegis_task_summary': return toolAegisTaskSummary(env);
    case 'aegis_batch_approve': return toolAegisBatchApprove(args, env);
    case 'aegis_publish_tech_post': return toolAegisPublishTechPost(args, env);
    case 'aegis_generate_decision_doc': return toolAegisGenerateDecisionDoc(args, env);
    case 'aegis_create_dynamic_tool': return toolAegisCreateDynamicTool(args, env);
    case 'aegis_invoke_dynamic_tool': return toolAegisInvokeDynamicTool(args, env);
    case 'aegis_list_dynamic_tools': return toolAegisListDynamicTools(args, env);
    default: return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ─── JSON-RPC Routing ───────────────────────────────────────

async function handleMethod(req: JsonRpcRequest, env: EdgeEnv): Promise<JsonRpcResponse | null> {
  // Notifications (no id) — acknowledge silently
  if (req.id === undefined || req.id === null) return null;

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      };

    case 'ping':
      return { jsonrpc: '2.0', id: req.id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } };

    case 'tools/call': {
      const params = req.params ?? {};
      const name = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      if (!name) {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Missing tool name' } };
      }

      try {
        const result = await executeTool(name, args, env);
        return { jsonrpc: '2.0', id: req.id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        };
      }
    }

    default:
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

// ─── HTTP Entrypoint ────────────────────────────────────────

export async function handleMcpRequest(request: Request, edgeEnv: EdgeEnv): Promise<Response> {
  // Session termination
  if (request.method === 'DELETE') {
    return new Response(null, { status: 202 });
  }

  // SSE not supported in stateless mode
  if (request.method === 'GET') {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'SSE not supported (stateless server)' } },
      { status: 405 },
    );
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  // Batch request
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const req of body) {
      const resp = await handleMethod(req as JsonRpcRequest, edgeEnv);
      if (resp) responses.push(resp);
    }
    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(responses);
  }

  // Single request
  const response = await handleMethod(body as JsonRpcRequest, edgeEnv);
  if (!response) return new Response(null, { status: 202 });
  return Response.json(response);
}
