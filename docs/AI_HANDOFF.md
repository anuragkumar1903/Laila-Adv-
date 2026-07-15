# Laila AI Handoff

## What This Project Is
Laila is a local-first AI CLI assistant for software engineering work. It runs entirely on the user's machine, uses Ollama for model inference, SQLite for persistence, and a scanned project index to keep context small and relevant.

The CLI is centered around `laila-cli`, which now launches the interactive assistant directly when invoked with no subcommand.

## Core Runtime Model
- Entry point: `core/src/cli/index.ts`
- Main interactive flow: `core/src/cli/commands/start.ts`
- One-off question flow: `core/src/cli/commands/ask.ts`
- Project scanning: `core/src/scanner/scanner.ts`
- Index generation: `core/src/scanner/project-index.ts`
- Orchestration: `core/src/orchestrator/orchestrator.ts`
- Context assembly: `core/src/orchestrator/context.ts`
- LLM access: `core/src/llm/ollama-client.ts`
- Persistence: `core/src/memory/*`
- Skills: `core/src/skills/*`

## High-Level Execution Flow
1. The CLI starts and initializes the SQLite schema.
2. `laila-cli` with no subcommand enters the interactive start flow.
3. The system runs a preflight check for Node, Git, Docker, n8n, Ollama, and the model.
4. The CLI resolves the current folder as the project path when it looks like a repo or package root.
5. If needed, the project is scanned and indexed into SQLite and `project-index.json`.
6. The REPL accepts user input and routes it through intent detection.
7. The orchestrator chooses an agent, builds context, calls Ollama, and records task history.
8. Validation runs for coding tasks, and optional n8n notifications are emitted.

## Agent Model
Laila uses agent roles rather than a single generic prompt.

Available roles today:
- `coder` - implementation and refactoring
- `reviewer` - code review and issue detection
- `researcher` - explanation and investigation
- `writer` - documentation and markdown writing
- `general` - fallback / general assistance

Each agent is layered with a skill profile from `skills/` and then enriched by the agent class itself.

## Skills And Agent Bundles
The `skills/` folder is automatically discovered.

Supported shapes:
- `skills/name.md`
- `skills/name/skill.md`
- `skills/name/index.md`

Skills can be tagged with frontmatter such as `name`, `version`, and `agent`.

If you add a new skill bundle, it will be discovered automatically. If you want it to become the default for an agent role, map it in `core/src/skills/skill-registry.ts`.

## Context Strategy
Laila avoids loading full repositories into the model.

It uses:
- a compact project index
- role-based file retrieval
- relevance scoring by query keywords
- line-limited file snippets
- a token budget cap in the prompt builder

Relevant files are formatted with truncation markers so the model knows the content is partial.

## Storage Model
Primary persistence is SQLite in `data/laila.db`.

Important tables:
- `projects`
- `project_files`
- `sessions`
- `tasks`
- `messages`

Task history is stored locally and the latest project index is written to both the canonical project storage path and the legacy root `project-index.json` during migration.

## Practical Commands
- `laila-cli` - start the interactive assistant
- `laila-cli ask "..."` - one-off question
- `laila-cli scan [path]` - index a project
- `laila-cli status` - show the latest session and project
- `laila-cli history` - show recent tasks
- `laila-cli skills` - list discovered skills
- `laila-cli doctor` - inspect readiness and suggestions
- `laila-cli doctor --fix` - create safe local folders when missing

## What To Check First When It Fails
1. Ollama availability and the `qwen2.5-coder:3b` model.
2. Node, Git, and Docker availability.
3. Whether the current directory is a repo or package root.
4. Whether `data/`, `data/projects/`, and `skills/` exist.
5. Whether the project has been scanned.

## Important Design Rules
- Keep everything local-first.
- Never send whole files to the model.
- Prefer small prompts and small file slices.
- Validate code changes before claiming success.
- Keep optional integrations like n8n non-blocking.

## If You Need To Extend It
Best extension points:
- Add a new agent class in `core/src/agents/`
- Add or update skill bundles in `skills/`
- Expand intent detection in `core/src/orchestrator/intent.ts`
- Improve scan heuristics in `core/src/scanner/detectors/`
- Add persistence shape in `core/src/memory/schema.ts`
