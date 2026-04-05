import { operatorConfig } from '../operator/index.js';

// ─── MCP Tool Definitions (JSON Schema) ─────────────────────

export const TOOLS = [
  {
    name: 'aegis_chat',
    description:
      'Send a message through the full AEGIS cognitive kernel (Groq classify → procedural lookup → route to executor). Returns the response with classification, executor, cost, and latency metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send to AEGIS' },
        conversation_id: {
          type: 'string',
          description: 'Conversation ID for multi-turn context. Omit to start a new conversation.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'aegis_conversations',
    description: 'List recent AEGIS conversations ordered by last activity.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max conversations to return (default 20, max 50)' },
      },
    },
  },
  {
    name: 'aegis_conversation_history',
    description: 'Get the full message history for a specific AEGIS conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'The conversation ID' },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'aegis_agenda',
    description: 'List active AEGIS agenda items including proposed actions awaiting approval.',
    inputSchema: {
      type: 'object',
      properties: {
        business_unit: { type: 'string', description: 'Filter to a single business unit (e.g. "stackbilt", "foodfiles"). Omit for all.' },
      },
    },
  },
  {
    name: 'aegis_health',
    description: 'Get AEGIS service health and procedural memory statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'aegis_memory',
    description: 'Read AEGIS semantic memory entries. Use `query` for keyword search (preferred — returns only relevant entries). Use `topic` to filter by category. Omit both to get recent entries across all topics.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact fragment ID to look up (bypasses search).' },
        topic: { type: 'string', description: 'Filter by topic category.' },
        query: { type: 'string', description: 'Keyword search — returns entries matching these terms. Preferred over topic-dump for large memory stores.' },
        limit: { type: 'number', description: 'Max entries to return (default 25, max 100).' },
      },
    },
  },
  {
    name: 'aegis_record_memory',
    description: `Record a durable fact to AEGIS long-term semantic memory. Call whenever you learn something about ${operatorConfig.identity.name}, his businesses, projects, or preferences that should persist across sessions.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: `Category (e.g., ${operatorConfig.entities.memoryTopics.map(t => `"${t}"`).join(', ')})` },
        fact: { type: 'string', description: 'The specific durable fact to remember' },
        confidence: { type: 'number', description: 'Confidence 0-1 (default: 0.8)' },
        source: { type: 'string', description: 'Where this came from (default: "claude_code")' },
      },
      required: ['topic', 'fact'],
    },
  },
  {
    name: 'aegis_forget_memory',
    description: 'Delete one or more semantic memory entries by ID. Use for cleanup of incorrect, stale, or sensitive entries.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Single memory entry ID to delete' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Multiple memory entry IDs to delete (max 20)' },
      },
    },
  },
  {
    name: 'aegis_add_agenda',
    description: 'Add a pending action or follow-up to the AEGIS persistent agenda. Use when a conversation surfaces something that needs to happen.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The action item — concise and actionable' },
        context: { type: 'string', description: 'Brief context: why this was added' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level (default: medium)' },
        business_unit: { type: 'string', description: 'Business unit this item belongs to (e.g. "stackbilt", "foodfiles"). Default: "stackbilt".' },
      },
      required: ['item'],
    },
  },
  {
    name: 'aegis_resolve_agenda',
    description: 'Mark an AEGIS agenda item as done or dismissed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The agenda item ID' },
        status: { type: 'string', enum: ['done', 'dismissed'], description: 'How it resolved' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'aegis_add_goal',
    description: 'Create a persistent autonomous goal. AEGIS evaluates goals on schedule and creates proposed actions when action is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short goal title' },
        description: { type: 'string', description: 'What to check and what to do if action is needed' },
        schedule_hours: { type: 'number', description: 'How often to evaluate in hours (default: 6)' },
        business_unit: { type: 'string', description: 'Business unit this goal belongs to (e.g. "stackbilt", "foodfiles"). Default: "stackbilt".' },
      },
      required: ['title'],
    },
  },
  {
    name: 'aegis_update_goal',
    description: 'Pause, complete, or mark an AEGIS goal as failed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Goal ID' },
        status: { type: 'string', enum: ['paused', 'completed', 'failed'], description: 'New status' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'aegis_list_goals',
    description: 'List all active AEGIS autonomous goals with schedule and run count.',
    inputSchema: {
      type: 'object',
      properties: {
        business_unit: { type: 'string', description: 'Filter to a single business unit (e.g. "stackbilt", "foodfiles"). Omit for all.' },
      },
    },
  },
  {
    name: 'aegis_cc_sessions',
    description: 'Look up Claude Code session digests. Query by session ID or list recent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Specific session UUID to look up. Omit to list recent.' },
        days: { type: 'number', description: 'Days to look back when listing (default 7)' },
      },
    },
  },
  {
    name: 'aegis_create_cc_task',
    description: 'Queue a Claude Code task for autonomous execution. The task runner picks these up and executes them via `claude -p` in the target repo. Use for work that can run unattended — code generation, refactoring, test writing, documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title (e.g. "Add unit tests for quota service")' },
        repo: { type: 'string', description: 'Target repo directory name (e.g. "my-project", "demo-app-v2")' },
        prompt: { type: 'string', description: 'Detailed instructions for Claude Code. Be specific about what to change, where, and how to verify.' },
        completion_signal: { type: 'string', description: 'String to look for in output to confirm success (default: "TASK_COMPLETE")' },
        priority: { type: 'number', description: 'Priority 0-100 where 0 is highest (default: 50)' },
        depends_on: { type: 'string', description: 'Single task ID this depends on (legacy) — will not run until dependency completes' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Array of task IDs that must all complete before this task runs (DAG dependencies)' },
        max_turns: { type: 'number', description: 'Max agentic turns for safety (default: 25)' },
        category: { type: 'string', enum: ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy'], description: 'Task category for governance routing (default: feature)' },
        authority: { type: 'string', enum: ['proposed', 'auto_safe', 'operator'], description: 'Authority level: operator=run immediately, auto_safe=safe auto-execute, proposed=needs approval (default: operator)' },
        business_unit: { type: 'string', description: 'Business unit this task belongs to (e.g. "stackbilt", "foodfiles"). Default: "stackbilt".' },
      },
      required: ['title', 'repo', 'prompt'],
    },
  },
  {
    name: 'aegis_approve_cc_task',
    description: 'Approve a proposed Claude Code task, making it eligible for autonomous execution.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID to approve' },
      },
      required: ['id'],
    },
  },
  {
    name: 'aegis_list_cc_tasks',
    description: 'List Claude Code tasks in the queue. Filter by status to see pending, running, completed, or failed tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'], description: 'Filter by status. Omit for all.' },
        business_unit: { type: 'string', description: 'Filter to a single business unit (e.g. "stackbilt", "foodfiles"). Omit for all.' },
        limit: { type: 'number', description: 'Max tasks to return (default 20)' },
      },
    },
  },
  {
    name: 'aegis_cancel_cc_task',
    description: 'Cancel a pending or running Claude Code task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['id'],
    },
  },
  {
    name: 'aegis_task_summary',
    description: 'Get a concise summary of the Claude Code task queue: counts by status, proposed tasks awaiting approval, pending tasks ready to run, and recent failures.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'aegis_batch_approve',
    description: 'Approve multiple proposed Claude Code tasks at once, making them eligible for autonomous execution.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'string', description: 'Comma-separated task IDs to approve, or "all" to approve every proposed task' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'aegis_publish_tech_post',
    description: 'Create or update a technical blog post. Published posts go live at your-blog.example.com/post/{slug}; drafts are saved without a public URL until published.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Post title' },
        slug: { type: 'string', description: 'URL slug (e.g. "img-forge-quickstart")' },
        body: { type: 'string', description: 'Full markdown body' },
        description: { type: 'string', description: 'Short description for RSS/meta (1-2 sentences)' },
        tags: { type: 'string', description: 'Comma-separated tags (e.g. "ai,imagegeneration,cloudflare")' },
        status: { type: 'string', enum: ['draft', 'published'], description: 'Publish immediately or save as draft (default: draft)' },
        skip_devto: { type: 'boolean', description: 'Skip dev.to cross-posting even when publishing (default: false)' },
      },
      required: ['title', 'slug', 'body'],
    },
  },
  {
    name: 'aegis_generate_decision_doc',
    description: 'Generate a decision document tracing the full memory trail for a topic across all AEGIS data sources (semantic memory, episodic memory, procedural memory, goals, narratives, tasks, GitHub). Pure data assembly — no LLM synthesis.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The topic to trace (e.g. "taskrunner", "auth consolidation", "memory worker")' },
        days: { type: 'number', description: 'Lookback window in days (default: 90)' },
        include_raw: { type: 'boolean', description: 'Include raw episode evidence section (default: false)' },
        repo: { type: 'string', description: 'GitHub repo to search for issues/PRs (default: aegis)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'aegis_create_dynamic_tool',
    description: 'Create a runtime dynamic tool — a reusable prompt template stored in D1 and executed via LLM. Dynamic tools appear in the Claude tool loop with a dt_ prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name (snake_case, 2-49 chars, no aegis_/mcp_/bizops_ prefix)' },
        description: { type: 'string', description: 'What the tool does' },
        input_schema: { type: 'string', description: 'JSON Schema for inputs (default: empty object)' },
        prompt_template: { type: 'string', description: 'Prompt template with {{variable}} placeholders' },
        executor: { type: 'string', enum: ['gpt_oss', 'workers_ai', 'groq'], description: 'LLM executor (default: gpt_oss)' },
        ttl_days: { type: 'number', description: 'Auto-expire after N days (optional)' },
      },
      required: ['name', 'description', 'prompt_template'],
    },
  },
  {
    name: 'aegis_invoke_dynamic_tool',
    description: 'Execute a runtime dynamic tool by name. Pass inputs that match the tool\'s input_schema.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to invoke' },
        inputs: { type: 'object', description: 'Input values matching the tool\'s schema' },
      },
      required: ['name'],
    },
  },
  {
    name: 'aegis_list_dynamic_tools',
    description: 'List runtime dynamic tools with usage statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'promoted', 'retired', 'draft'], description: 'Filter by status (default: active + promoted)' },
        limit: { type: 'number', description: 'Max tools to return (default 50, max 100)' },
      },
    },
  },
];
