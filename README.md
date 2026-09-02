# Laila(Adv)

Laila(Adv) is a highly advanced, extensible AI developer assistant designed for your terminal. While it retains its roots as a local-first architecture (via Ollama), it now fully supports **Cloud LLMs** (like Google Gemini 2.5/3.1) and features a built-in **MCP (Model Context Protocol) App Store** that lets you connect Laila to the entire internet, your databases, and external SaaS tools.

## 🚀 Quick Start

Get up and running in seconds:

```bash
cd core
npm install
npm run build
npm link
laila start
```
*Laila will guide you through the rest via its interactive terminal!*

## Core Principles

- **Hybrid Intelligence**: Use local models (Ollama) for privacy, or connect powerful cloud models (Gemini 2.5 Pro / 3.1 Preview) via API keys for heavy lifting.
- **MCP Native**: Out-of-the-box Model Context Protocol integration. Search, install, and authenticate with 9000+ MCP servers globally from the CLI.
- **Auto-Discovery**: Laila dynamically injects relevant skills into its context based on your task—no manual tagging required.
- **Auditable**: Keeps a SQLite history of tasks, commands, and generated code.

## Installation

```bash
cd core
npm install
npm run build
```

Link the CLI globally (optional, but recommended):

```bash
npm link
```

_(You can then run `laila` from anywhere.)_

## Usage

Start Laila by simply running:

```bash
laila start
```

### ⚡ Interactive Slash Commands (Inside Laila)
Once inside the Laila terminal, you have access to powerful slash commands:

- `/mcp list` - View available official MCP add-ons.
- `/mcp search <query>` - Search the global NPM registry for community MCP servers.
- `/mcp add <server>` - Install an MCP server into your local workspace.
- `/mcp auth <server>` - Interactively setup API keys for your MCP servers.
- `/provider` - Interactive setup wizard to switch between LLM providers (e.g., Gemini).
- `/model` - Interactively list and switch the active LLM model.
- `/plan` / `/research` - Bypass auto-detection to explicitly invoke specialized agents.

### 🛠️ Global CLI Commands

- `laila start`: Start an interactive REPL session with Laila(Adv).
- `laila ask <query>`: Ask Laila(Adv) a single question about your project.
- `laila scan [path]`: Scan a project directory to index its files into the database.
- `laila status`: Show current session and loaded project status.
- `laila history`: Show recent task execution history.
- `laila doctor`: Inspect system readiness and suggest fixes.
- `laila commit [path]`: Generate a commit message based on staged changes and commit them.

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - System design and data flow.
- [CODE_REFERENCE.md](docs/CODE_REFERENCE.md) - Inline API reference for all core modules.
- [DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) - How to extend and modify Laila(Adv).
- [AGENT_REFERENCE.md](docs/AGENT_REFERENCE.md) - Deep dive into agent roles and prompt enrichment.

## Project Structure

- `core/src/cli/` - The entry point commands and CLI framework.
- `core/src/orchestrator/` - Task routing, context assembly, and intent detection.
- `core/src/mcp/` - Model Context Protocol client manager and dynamic registry.
- `core/src/agents/` - Role-specific AI agents (`coder`, `reviewer`, `researcher`, `writer`, `general`).
- `core/src/skills/` - Dynamic skill auto-discovery for agent behaviour.
- `core/src/llm/` - LLM provider interface, interactive setup wizards, and prompt building.
- `core/src/memory/` - SQLite schema and local repositories for tasks and sessions.
