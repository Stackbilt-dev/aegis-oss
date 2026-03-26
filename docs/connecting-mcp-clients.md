# Connecting MCP Clients

AEGIS exposes its full capability set — memory, goals, agenda, chat, dynamic tools, and more — via a [Model Context Protocol](https://modelcontextprotocol.io/) server. Any MCP-compatible client can connect and start using AEGIS tools immediately.

This guide covers how to wire up your AEGIS instance to popular MCP clients. If your tool speaks MCP, it can talk to AEGIS. No SDK, no wrapper, no glue code.

## How AEGIS Serves MCP

Your deployed AEGIS worker exposes an MCP endpoint at:

```
https://your-worker.workers.dev/mcp
```

This is a remote MCP server using **SSE (Server-Sent Events) transport**. Authentication is via Bearer token — the same `AEGIS_TOKEN` you set during deployment.

> **Prerequisites**: You need a running AEGIS instance. If you don't have one yet, follow the [Getting Started](getting-started.md) guide first — it takes about 10 minutes and costs $0/month on Cloudflare's free tier.

## Available Tools

Once connected, your MCP client gets access to 20+ tools:

| Tool | What it does |
| --- | --- |
| `aegis_chat` | Send a message through the full cognitive kernel |
| `aegis_memory` | Search semantic memory by keyword or topic |
| `aegis_record_memory` | Store a durable fact to long-term memory |
| `aegis_agenda` | List active agenda items and pending actions |
| `aegis_add_agenda` | Add a new action item or follow-up |
| `aegis_resolve_agenda` | Mark an agenda item as done or dismissed |
| `aegis_add_goal` | Create a persistent autonomous goal |
| `aegis_update_goal` | Pause, complete, or fail a goal |
| `aegis_list_goals` | List all active goals with schedule and run count |
| `aegis_create_cc_task` | Queue an autonomous coding task |
| `aegis_list_cc_tasks` | List tasks in the queue |
| `aegis_approve_cc_task` | Approve a proposed task for execution |
| `aegis_create_dynamic_tool` | Create a reusable prompt-template tool at runtime |
| `aegis_invoke_dynamic_tool` | Execute a dynamic tool by name |
| `aegis_list_dynamic_tools` | List active dynamic tools |
| `aegis_publish_tech_post` | Create or update a technical blog post |
| `aegis_inbox_send` | Send a message to the inter-agent inbox |
| `aegis_inbox_read` | Read unread messages from the agent inbox |
| `aegis_generate_decision_doc` | Generate a decision document tracing memory for a topic |
| `aegis_health` | Get system health and procedural memory stats |

The full list depends on your AEGIS configuration — some tools (like social engagement or content pipeline tools) are only available if the corresponding integrations are enabled.

---

## OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an open-source personal AI assistant that runs locally and connects to 20+ messaging channels. It has native MCP server support, which means plugging AEGIS in is about 30 seconds of config editing.

### What You Get

Your OpenClaw agent gains persistent memory, goal tracking, and autonomous task execution — things that normally vanish when a chat session ends. AEGIS becomes the long-term brain; OpenClaw stays the conversational interface.

Think of it this way: OpenClaw handles the "talking to humans" part. AEGIS handles the "remembering what happened and doing things about it while you sleep" part.

### Setup

**1. Make sure both systems are running**

- AEGIS deployed and accessible (you should be able to hit `https://your-worker.workers.dev/health` and see a response)
- OpenClaw gateway running (`openclaw gateway` or installed as a daemon)

**2. Add AEGIS to your OpenClaw config**

Edit `~/.openclaw/openclaw.json` and add AEGIS under `mcpServers`:

```json
{
  "mcpServers": {
    "aegis": {
      "url": "https://your-aegis-worker.workers.dev/mcp",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer YOUR_AEGIS_TOKEN"
      }
    }
  }
}
```

Replace:
- `your-aegis-worker.workers.dev` with your actual AEGIS worker URL
- `YOUR_AEGIS_TOKEN` with the `AEGIS_TOKEN` you set during AEGIS deployment

**3. Restart the gateway**

```bash
openclaw gateway restart
```

**4. Verify**

Send a message to your OpenClaw agent:

> "Use the aegis_health tool to check the AEGIS system status."

If you see version info, memory stats, and procedure counts — you're wired up. Go break something.

### Helping Your Model Not Be Terrible

If your model keeps ignoring AEGIS tools or using them wrong, it probably needs a hint. The tool descriptions alone are sometimes not enough context for smaller models to understand *when* to reach for AEGIS vs. handling things locally.

Add something like this to your OpenClaw workspace prompt (`~/.openclaw/workspace/AGENTS.md`):

```markdown
## AEGIS Integration

AEGIS is a persistent cognitive kernel connected via MCP. Use it for:

- **Remembering things**: `aegis_record_memory` to save facts, `aegis_memory` to recall them
- **Tracking work**: `aegis_add_agenda` for action items, `aegis_add_goal` for ongoing objectives
- **Autonomous tasks**: `aegis_create_cc_task` to queue coding tasks for background execution
- **Deep context**: `aegis_chat` routes through the full kernel with memory + procedural context

Don't use AEGIS for ephemeral questions or quick lookups — those are fine to handle directly.
Use AEGIS when something needs to persist beyond this conversation.
```

**Model recommendations**: Stronger models (Claude Opus/Sonnet, GPT-4o) will figure out when to use AEGIS tools from the descriptions alone. Smaller models benefit significantly from the prompt guidance above. If you're using OpenClaw's per-agent routing, consider routing AEGIS-heavy workflows to an agent configured with a stronger model.

### Per-Agent Routing (Optional)

If you run multiple OpenClaw agents, you can restrict AEGIS tools to specific agents rather than exposing them globally. This keeps your casual-chat agent lean and your "get stuff done" agent loaded:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "mcp": {
          "servers": ["aegis"]
        }
      },
      {
        "id": "casual",
        "mcp": {
          "servers": []
        }
      }
    ]
  }
}
```

---

## Claude Code

Add AEGIS to your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "aegis": {
      "url": "https://your-aegis-worker.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AEGIS_TOKEN"
      }
    }
  }
}
```

AEGIS tools will be available in your Claude Code sessions immediately.

---

## Claude Desktop

Claude Desktop supports MCP servers natively. Add AEGIS to your Claude Desktop config:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aegis": {
      "url": "https://your-aegis-worker.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AEGIS_TOKEN"
      }
    }
  }
}
```

Restart Claude Desktop. AEGIS tools will appear in the tool picker (the hammer icon).

---

## Cursor / VS Code

Cursor and VS Code with MCP extensions can connect to AEGIS as a remote server. The exact configuration depends on your extension, but the pattern is the same:

- **URL**: `https://your-aegis-worker.workers.dev/mcp`
- **Transport**: SSE
- **Auth**: Bearer token in the `Authorization` header

Check your editor's MCP documentation for the specific config file location and format.

---

## Any MCP Client

If your tool supports MCP and isn't listed above, the connection details are always the same:

| Setting | Value |
| --- | --- |
| **Endpoint** | `https://your-worker.workers.dev/mcp` |
| **Transport** | SSE (Server-Sent Events) |
| **Auth** | `Authorization: Bearer YOUR_AEGIS_TOKEN` |
| **Protocol** | MCP over JSON-RPC 2.0 |

AEGIS follows the MCP specification. If your client speaks MCP, it'll work. If it doesn't, something is misconfigured — not incompatible.

---

## Troubleshooting

**"Connection refused" or timeout**

Your AEGIS worker might be sleeping (Cloudflare Workers cold start is single-digit ms, but the first request after a long idle can occasionally hiccup). Hit the health endpoint directly first:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://your-worker.workers.dev/health
```

If that works, retry the MCP connection.

**"Unauthorized" or 401 errors**

Double-check your `AEGIS_TOKEN`. The token in your client config must exactly match what you set via `npx wrangler secret put AEGIS_TOKEN`. No trailing whitespace, no quotes around the value.

**Tools show up but calls fail**

Check that your AEGIS D1 database has the schema applied. If you deployed but skipped the `npx wrangler d1 execute my-agent --file=schema.sql` step, tools will register but queries will fail.

**Model doesn't use AEGIS tools**

This isn't an AEGIS problem — it's a prompting problem. See the "Helping Your Model Not Be Terrible" section under OpenClaw above. The same guidance applies to any client: give the model context about *when* to use AEGIS, not just *how*.

---

## Security Notes

- Your `AEGIS_TOKEN` is the only thing standing between the internet and your agent's memory. Treat it like a password.
- AEGIS runs on Cloudflare Workers with HTTPS by default. All MCP traffic is encrypted in transit.
- Each AEGIS instance is single-tenant. Your memory, goals, and agenda are yours alone.
- If you're connecting from a shared machine, be aware that MCP config files (which contain your token) are stored in plaintext. Restrict file permissions accordingly.

---

## What's Next

- [Architecture](architecture.md) — understand the cognitive kernel your client is now talking to
- [Memory System](memory-system.md) — how AEGIS remembers and learns
- [Configuration](configuration.md) — customize your agent's behavior
- [Discord](https://discord.gg/aJmE8wmQDS) — get help, share your setup, tell us what broke
