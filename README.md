# Laila(Adv)

Laila(Adv) (also known as Jarvis in its architecture) is a local-first AI developer assistant. It operates entirely on your machine, leveraging local models via Ollama to keep your codebase private, secure, and fast. Laila(Adv) provides a comprehensive CLI to help you write code, review changes, explore the codebase, and manage project metadata.

## Core Principles

- **Local-first**: All models and index data stay on your machine.
- **Context-aware**: Analyzes your project tree to build a targeted index without sending the whole repository to the LLM.
- **Auditable**: Keeps a SQLite history of tasks, commands, and generated code.
- **Extensible**: Uses a dynamic `skills/` directory to load system prompts and behaviours.

## Installation

```bash
cd core
npm install
npm run build
```

Link the CLI globally (optional):

```bash
npm link
```

_(You can then run `laila` from anywhere.)_

## Usage

If you don't link globally, you can run Laila(Adv) via Node from the `core` directory:

```bash
node dist/cli/index.js <command>
```

### Commands

- `laila start`: Start an interactive REPL session with Laila(Adv) (default command if no arguments are provided).
- `laila ask <query>`: Ask Laila(Adv) a single question about your project.
- `laila scan [path]`: Scan a project directory to index its files into the database.
- `laila status`: Show current session and loaded project status.
- `laila history`: Show recent task execution history.
- `laila skills`: List discovered skills and their agent mappings.
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
- `core/src/agents/` - Role-specific AI agents (`coder`, `reviewer`, `researcher`, `writer`, `general`).
- `core/src/scanner/` - Project indexing logic.
- `core/src/skills/` - Dynamic skill discovery for agent behaviour.
- `core/src/llm/` - LLM provider interface and prompt building.
- `core/src/memory/` - SQLite schema and local repositories for tasks and sessions.
