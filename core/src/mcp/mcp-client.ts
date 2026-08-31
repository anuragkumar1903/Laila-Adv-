import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from 'child_process';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

export class MCPClientManager {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  public tools: MCPTool[] = [];

  async connect(command: string, args: string[]) {
    this.transport = new StdioClientTransport({
      command,
      args,
    });

    this.client = new Client({
      name: "laila-client",
      version: "1.0.0",
    }, {
      capabilities: {}
    });

    await this.client.connect(this.transport);
    
    // Fetch available tools from the server
    const response = await this.client.listTools();
    this.tools = response.tools as unknown as MCPTool[];
  }

  async callTool(name: string, args: any) {
    if (!this.client) throw new Error("MCP Client not connected");
    const result = await this.client.callTool({
      name,
      arguments: args
    });
    return result;
  }

  async disconnect() {
    if (this.transport) {
      await this.transport.close();
    }
  }
}
