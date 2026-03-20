// Thin MCP HTTP client — supports multiple MCP servers via prefix
// Supports Streamable HTTP transport with session management

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface McpConfig {
  url: string;
  token: string;
  prefix: string;      // e.g. 'bizops', 'cf_obs'
  fetcher?: Fetcher;   // Service Binding for Worker-to-Worker calls
  rpcPath?: string;    // Stateless RPC path for service binding (bypasses DO/SSE)
}

export class McpClient {
  private url: string;
  private token: string;
  private prefix: string;
  private fetcher: Fetcher | null;
  private rpcUrl: string | null;  // Stateless RPC URL for service binding
  private tools: McpToolDefinition[] | null = null;
  private sessionId: string | null = null;

  constructor(config: McpConfig) {
    this.url = config.url;
    this.token = config.token;
    this.prefix = config.prefix;
    this.fetcher = config.fetcher ?? null;
    // When service binding + rpcPath provided, use stateless RPC (no DO/SSE)
    this.rpcUrl = (config.fetcher && config.rpcPath)
      ? new URL(config.rpcPath, config.url).href
      : null;
  }

  getPrefix(): string {
    return this.prefix;
  }

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    // Stateless RPC path — plain JSON, no sessions, no SSE
    if (this.rpcUrl && this.fetcher) {
      return this.rpcStateless(method, params);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.token}`,
    };

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const request = new Request(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });

    // Use Service Binding fetch if available (avoids Worker-to-Worker 1042 error)
    const response = this.fetcher
      ? await this.fetcher.fetch(request)
      : await fetch(request);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`MCP error ${response.status}: ${errText}`);
    }

    // Capture session ID from response headers
    const newSessionId = response.headers.get('Mcp-Session-Id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    const contentType = response.headers.get('Content-Type') ?? '';

    // Handle SSE responses (Streamable HTTP transport)
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      if (!text) throw new Error('Empty SSE response');
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.result !== undefined) return parsed.result;
            if (parsed.error) throw new Error(`MCP RPC error: ${parsed.error?.message ?? 'unknown'}`);
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('MCP')) throw e;
          }
        }
      }
      throw new Error('No result in SSE response');
    }

    // Standard JSON response
    const data = await response.json<{
      result?: unknown;
      error?: { code: number; message: string };
    }>();

    if (data.error) {
      throw new Error(`MCP RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  /** Stateless JSON-RPC — for service binding calls to /rpc endpoints (no DO/SSE overhead) */
  private async rpcStateless(method: string, params: Record<string, unknown>): Promise<unknown> {
    const request = new Request(this.rpcUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });

    const response = await this.fetcher!.fetch(request);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`MCP error ${response.status}: ${errText}`);
    }

    const data = await response.json<{
      result?: unknown;
      error?: { code: number; message: string };
    }>();

    if (data.error) {
      throw new Error(`MCP RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  async initialize(): Promise<void> {
    // Stateless RPC path skips MCP handshake entirely
    if (this.rpcUrl) {
      this.sessionId = 'stateless';
      return;
    }

    if (this.sessionId) return;

    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'aegis-web', version: '0.1.0' },
    });

    // Send initialized notification (no id = notification)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${this.token}`,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const notifyRequest = new Request(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    if (this.fetcher) {
      await this.fetcher.fetch(notifyRequest);
    } else {
      await fetch(notifyRequest);
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (this.tools) return this.tools;

    await this.initialize();
    const result = await this.rpc('tools/list') as { tools: McpToolDefinition[] };
    this.tools = result.tools;
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const result = await this.rpc('tools/call', {
      name,
      arguments: args,
    }) as { content?: { type: string; text?: string }[] } | undefined;

    if (!result || !Array.isArray(result.content)) {
      return '(no output)';
    }

    return result.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n') || '(no output)';
  }

  toAnthropicTools(): AnthropicToolDef[] {
    if (!this.tools) return [];

    return this.tools.map(t => ({
      name: `mcp__${this.prefix}__${t.name}`,
      description: t.description ?? t.name,
      input_schema: t.inputSchema,
    }));
  }

  toMcpToolName(anthropicName: string): string | null {
    const pfx = `mcp__${this.prefix}__`;
    if (!anthropicName.startsWith(pfx)) return null;
    return anthropicName.slice(pfx.length);
  }
}

// ─── McpRegistry — multi-client tool resolution ──────────────

export class McpRegistry {
  private clients: McpClient[] = [];

  register(client: McpClient): void {
    this.clients.push(client);
  }

  async listAllTools(): Promise<AnthropicToolDef[]> {
    const toolSets = await Promise.all(
      this.clients.map(async (c) => {
        try {
          await c.listTools();
          return c.toAnthropicTools();
        } catch (err) {
          console.warn(`[mcp-registry] Failed to list tools for ${c.getPrefix()}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }),
    );
    return toolSets.flat();
  }

  resolveClient(anthropicToolName: string): { client: McpClient; mcpName: string } | null {
    for (const client of this.clients) {
      const mcpName = client.toMcpToolName(anthropicToolName);
      if (mcpName) return { client, mcpName };
    }
    return null;
  }
}
