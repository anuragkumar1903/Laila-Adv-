import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from 'fs/promises';

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

export class MCPClientManager {
  private clients = new Map<string, { client: Client, transport: StdioClientTransport }>();
  public tools: MCPTool[] = [];
  public config: MCPConfig | null = null;

  async loadConfig(configPath: string) {
    try {
      const content = await readFile(configPath, 'utf8');
      this.config = JSON.parse(content) as MCPConfig;
    } catch {
      this.config = null;
    }
  }

  async connect(serverName: string, command: string, args: string[], env?: Record<string, string>) {
    if (this.clients.has(serverName)) return; // Already connected

    const mergedEnv = env ? { ...process.env, ...env } : process.env;

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
    for (const serverName of this.clients.keys()) {
      await this.disconnect(serverName);
    }
  }
}
