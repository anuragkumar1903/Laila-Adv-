# Laila (Advanced AI Developer OS)

Laila is an elite, local-first AI developer assistant that runs entirely in your terminal. Originally architected for absolute privacy (via Ollama) and maximum speed, Laila has evolved into a complete Agentic Operating System.

## 🚀 Core Features

- **Hybrid Intelligence:** Runs `llama3` locally for free/private tasks, and gracefully scales to Anthropic/Gemini for heavy reasoning.
- **Multi-Agent Swarm (`/swarm`):** Spawn concurrent background sub-agents to solve complex, multi-step tasks in parallel.
- **Universal MCP Connectors (`/mcp`):** Natively plugs into your enterprise data (Postgres, GitHub, Slack, Jira, AWS, Google Drive) via the Model Context Protocol.
- **Visual QA & Computer Use (`/browse`):** Natively hooks into Playwright to navigate to your localhost, take UI screenshots, and visually QA your frontend code changes.
- **Semantic Project RAG (`/scan`):** Builds an instant, in-memory Knowledge Graph of your workspace using AST parsing—no heavy vector DBs required.
- **Self-Healing Build Loops:** If your code fails to compile, Laila intercepts the raw compiler `stderr` and automatically re-writes the fix.
- **Episodic Memory (`/remember`):** A global memory graph that remembers your precise architectural preferences across every project you touch.
- **Sandboxed Execution (`/sandbox`):** Writes and executes code natively, with dangerous commands automatically routed through disposable Docker containers for absolute host security.

## 📦 Installation

```bash
npm install -g laila
```

## 🎮 Quickstart

Just type `laila` inside any directory to launch the OS.

```bash
# Connect to your Postgres Database
laila> /mcp npx @modelcontextprotocol/server-postgres postgresql://localhost/mydb

# Trigger a Multi-Agent Swarm
laila> /swarm Build the frontend | Write the backend API | Setup Docker

# Visual UI Debugging
laila> /browse http://localhost:3000
```

## 🧠 The "Ponytail" Philosophy
Laila is built on the "Ponytail" architectural philosophy: zero bloat, maximum stdlib usage, and brutal efficiency. She doesn't rely on 500MB of heavy Python ML libraries; she is purely driven by modern TypeScript, raw CLI power, and extreme Agentic logic.

---
*Developed by Anurag Kumar*
