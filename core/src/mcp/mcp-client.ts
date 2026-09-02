import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from 'fs/promises';
import path from 'path';

export interface MCPTool {
  serverName: string;
  name: string;
  description: string;
  inputSchema: any;
}

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoTriggerPatterns?: string[];
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Allowlist of executables that MCP servers may use.
 * These are the only commands that can be specified as `command` in mcp.json.
 * Keeping this tight prevents a compromised mcp.json from running arbitrary binaries.
 */
const MCP_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // Node / Bun runtimes — most MCP servers are JS/TS
  'node', 'bun', 'npx', 'tsx', 'ts-node',
  // Python runtimes
  'python', 'python3', 'uv', 'uvx',
  // Other common MCP server runtimes
  'deno',
  'go',
  'java',
]);

/**
 * Validate that a command from mcp.json is in the allowed set.
 * Strips any path prefix (e.g. /usr/bin/node → node) before checking.
 */
function isMcpCommandAllowed(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  // Strip directory prefix — only the basename is checked
  const base = path.basename(command).replace(/\.exe$/i, '').toLowerCase();
  return MCP_ALLOWED_COMMANDS.has(base);
}

export class MCPClientManager {
  private clients = new Map<string, { client: Client, transport: StdioClientTransport }>();
  public tools: MCPTool[] = [];
  public config: MCPConfig | null = null;

  async loadConfig(configPath: string) {
    try {
      const content = await readFile(configPath, 'utf8');
      // FIX (Low): Surface JSON parse errors so the user knows their config is broken
      try {
        this.config = JSON.parse(content) as MCPConfig;
      } catch (parseErr) {
        console.error(`[MCP] Invalid JSON in ${configPath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        this.config = null;
      }
    } catch {
      this.config = null;
    }
  }

  async connect(serverName: string, command: string, args: string[], env?: Record<string, string>) {
    if (this.clients.has(serverName)) return; // Already connected

    // FIX (Critical): Validate command against allowlist before spawning.
    // mcp.json is user-writable and could be tampered or socially-engineered.
    if (!isMcpCommandAllowed(command)) {
      throw new Error(
        `MCP server '${serverName}' uses a disallowed command: "${command}". ` +
        `Only the following commands are permitted: ${[...MCP_ALLOWED_COMMANDS].join(', ')}.`
      );
    }

    // FIX (Critical): Only pass the server-specific env overrides merged with a
    // minimal base env, NOT the full process.env (which may contain LAILA_API_KEY,
    // AWS credentials, DB passwords, etc.).
    const safeBaseEnv: Record<string, string> = {
      PATH:        process.env['PATH']        ?? '',
      HOME:        process.env['HOME']        ?? '',
      USERPROFILE: process.env['USERPROFILE'] ?? '',
      TEMP:        process.env['TEMP']        ?? '',
      TMP:         process.env['TMP']         ?? '',
      TMPDIR:      process.env['TMPDIR']      ?? '',
      SYSTEMROOT:  process.env['SYSTEMROOT']  ?? '',
      NODE_ENV:    process.env['NODE_ENV']    ?? '',
    };
    const mergedEnv = env ? { ...safeBaseEnv, ...env } : safeBaseEnv;

    const transport = new StdioClientTransport({
      command,
      args,
      env: mergedEnv as any,
    });

    const client = new Client({
      name: "laila-client",
      version: "1.0.0",
    }, {
      capabilities: {}
    });

    await client.connect(transport);
    
    // Fetch tools
    const response = await client.listTools();
    const serverTools = response.tools as any[];
    
    // Add to global tools array
    for (const t of serverTools) {
      this.tools.push({
        serverName,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      });
    }

    this.clients.set(serverName, { client, transport });
  }

  async connectAllFromConfig() {
    if (!this.config || !this.config.mcpServers) return;
    for (const [serverName, srv] of Object.entries(this.config.mcpServers)) {
      try {
        await this.connect(serverName, srv.command, srv.args, srv.env);
      } catch (err) {
        console.error(`Failed to autoconnect MCP server '${serverName}':`, err);
      }
    }
  }

  /** Auto-connect if the prompt matches a trigger pattern */
  async checkAutoTriggers(prompt: string) {
    if (!this.config || !this.config.mcpServers) return;
    for (const [serverName, srv] of Object.entries(this.config.mcpServers)) {
      if (this.clients.has(serverName)) continue; // already connected
      if (srv.autoTriggerPatterns && srv.autoTriggerPatterns.length > 0) {
        const matches = srv.autoTriggerPatterns.some(p => prompt.includes(p));
        if (matches) {
          console.log(`\n  [MCP] Auto-trigger matched for '${serverName}'. Connecting...`);
          try {
            await this.connect(serverName, srv.command, srv.args, srv.env);
          } catch (err) {
            console.error(`  [MCP] Failed to auto-connect '${serverName}':`, err);
          }
        }
      }
    }
  }

  async callTool(serverName: string, name: string, args: any) {
    const conn = this.clients.get(serverName);
    if (!conn) throw new Error(`MCP Server '${serverName}' not connected`);
    return await conn.client.callTool({
      name,
      arguments: args
    });
  }

  async disconnect(serverName: string) {
    const conn = this.clients.get(serverName);
    if (conn) {
      await conn.transport.close();
      this.clients.delete(serverName);
      this.tools = this.tools.filter(t => t.serverName !== serverName);
    }
  }

  async disconnectAll() {
    // FIX (High): Snapshot keys before iteration — disconnect() calls
    // this.clients.delete() which mutates the Map mid-loop and skips entries.
    for (const serverName of [...this.clients.keys()]) {
      await this.disconnect(serverName);
    }
  }
}
