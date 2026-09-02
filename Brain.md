# BRAIN.md

## Purpose

**laila** is a local‑first AI operating system for software engineering productivity. It is a single‑user, offline system that helps understand, modify, validate, and maintain codebases. This document is the single source of truth for the project: architecture, workflows, components, data flows, constraints, and operational guidance for developers and future AI agents.

---

## High Level Overview

**Goal**  
Provide a CLI‑first assistant that can scan a repository, build a compact project index, run agent workflows (coder, reviewer, researcher, writer, general), generate code changes, and validate them locally. No cloud dependencies. All LLM work is local via Ollama using the `qwen2.5-coder:3b` model.

**Core Principles**

- Offline first, single user, no cloud.
- Modular, extensible, production‑quality code.
- Keep memory and compute modest: target GTX 1650 (4GB VRAM) and 16GB RAM.
- Minimal external dependencies; no LangChain, Redis, Postgres, Kubernetes, or microservices.

**Primary Technologies**

- **Runtime**: Node.js + TypeScript
- **Local LLM Host**: Ollama and Lm Studio with ``
- **Storage**: SQLite
- **Automation**: N8N (optional local instance for notifications/workflows)
- **Containerization**: Docker (optional)
- **Skills**: Markdown files loaded dynamically

---

## Folder Structure

```
jarvis/
├── core/
│   ├── src/
│   │   ├── cli/
│   │   ├── orchestrator/
│   │   ├── agents/
│   │   ├── scanner/
│   │   ├── memory/
│   │   ├── skills/
│   │   └── utils/
├── data/
│   ├── projects/
│   └── laila.sqlite
├── infra/
│   ├── Dockerfile
│   └── ollama-config/
├── docs/
└── README.md
```

**Key directories**

- **core/src/cli** CLI entry and commands.
- **core/src/scanner** Repository analysis and `project-index.json` generation.
- **core/src/orchestrator** Intent detection, agent selection, context retrieval, LLM invocation.
- **core/src/agents** Agent implementations (Coder, Reviewer, Researcher, Writer, General).
- **core/src/skills** Markdown skill loader and skill files.
- **core/src/memory** SQLite access layer and migrations.
- **data/projects** Per‑project indexes and caches.
- **infra** Docker and Ollama configuration.

---

## Database Schema

SQLite schema (summary)

**projects**

- `id TEXT PRIMARY KEY`
- `path TEXT UNIQUE`
- `name TEXT`
- `git BOOLEAN`
- `framework TEXT`
- `package_manager TEXT`
- `created_at DATETIME`
- `last_scanned_at DATETIME`

**project_indexes**

- `id INTEGER PRIMARY KEY`
- `project_id TEXT`
- `index_path TEXT`
- `summary TEXT`
- `file_count INTEGER`
- `created_at DATETIME`

**files**

- `id INTEGER PRIMARY KEY`
- `project_id TEXT`
- `relative_path TEXT`
- `language TEXT`
- `role TEXT` (controller; service; model; route; test; util)
- `hash TEXT`
- `last_modified DATETIME`

**tasks**

- `id TEXT PRIMARY KEY`
- `project_id TEXT`
- `agent TEXT`
- `intent TEXT`
- `status TEXT` (pending, running, completed, failed)
- `created_at DATETIME`
- `completed_at DATETIME`
- `result_summary TEXT`

**sessions**

- `id TEXT PRIMARY KEY`
- `project_id TEXT`
- `started_at DATETIME`
- `ended_at DATETIME`
- `metadata TEXT`

**history**

- `id INTEGER PRIMARY KEY`
- `session_id TEXT`
- `task_id TEXT`
- `message_role TEXT` (user, system, agent)
- `content TEXT`
- `created_at DATETIME`

**Indexes**

- `projects.path`
- `files.project_id, files.role`
- `tasks.project_id, tasks.status`

---

## Project Index Format

**project-index.json** is the canonical, compact representation of a repository used to avoid sending entire repos to the model.

Minimal example:

```json
{
  "projectId": "uuid",
  "name": "my-app",
  "root": "/path/to/project",
  "packageManager": "npm",
  "framework": "express",
  "summary": "Express API with user and auth modules",
  "files": [
    {
      "path": "src/controllers/userController.ts",
      "role": "controller",
      "language": "ts",
      "hash": "sha256..."
    },
    {
      "path": "src/services/userService.ts",
      "role": "service",
      "language": "ts",
      "hash": "sha256..."
    }
  ],
  "routes": [
    {
      "method": "GET",
      "path": "/users",
      "handler": "src/controllers/userController.ts::getUsers"
    }
  ],
  "tests": ["test/user.test.ts"]
}
```

**Design rules**

- Keep snippets small. Store full file paths and hashes; only send snippets to LLM.
- Include roles and route mappings to enable targeted retrieval.
- Update index on scan and on file changes.

---

## Scanner Design

**Responsibilities**

- Recursively scan repository on first load and on demand.
- Detect package manager, languages, frameworks, controllers, services, routes, models, tests.
- Produce `project-index.json` and populate `files` table.

**Heuristics**

- Package managers: `package.json`, `yarn.lock`, `pnpm-lock.yaml`, `pyproject.toml`, `go.mod`.
- Framework detection: check dependencies and common files (`next.config.js`, `angular.json`, `nest-cli.json`).
- Role detection: pattern matching on filenames and directories (`controllers`, `services`, `routes`, `models`, `tests`).
- Route extraction: parse common router patterns (Express `router.get`, Next.js `pages` folder).
- Language detection: file extensions and shebangs.

**Performance**

- Use streaming file reads and parallel stat calls with a controlled concurrency (e.g., 8 workers).
- Compute content hashes for change detection.
- Cache results in `data/projects/<id>/project-index.json`.

---

## Orchestrator Design

**Responsibilities**

- Accept user intent from CLI.
- Run intent detection (rule‑based first; model‑assisted later).
- Select appropriate agent.
- Retrieve context from project index and files.
- Load relevant skills.
- Call Ollama with a compact prompt and tools.
- Collect agent output and run validation pipeline when needed.
- Persist task and session history to SQLite.

**Intent detection**

- Phase 1: rule‑based mapping of commands to agents (e.g., "refactor", "implement", "fix test" → Coder Agent).
- Phase 2: lightweight model call to classify intent when ambiguous.

**Context retrieval**

- Query `project-index.json` for roles and file paths.
- Use a relevance ranking: role match > filename match > recent modification.
- Limit total token budget by truncating file snippets and skill text.

**LLM invocation**

- Single Ollama model for all agents: `qwen2.5-coder:3b`.
- Use deterministic settings for code generation (low temperature).
- Provide system prompt, skill injection, few‑shot examples, and tools description.

---

## Agent System

**Agents**

- **Coder Agent**: generate patches, refactors, new code.
- **Reviewer Agent**: produce code reviews, security and style checks.
- **Researcher Agent**: summarize design, find references in docs and skills.
- **Writer Agent**: produce docs, PR descriptions, changelogs.
- **General Agent**: orchestrate multi‑step tasks and fallback.

**Agent interface**

```ts
interface Agent {
  name: string;
  skillNames: string[];
  promptTemplate: string;
  run(context: TaskContext): Promise<AgentResult>;
}
```

**Tool primitives available to agents**

- **File Retriever**: returns top‑N snippets for a query.
- **Patch Generator**: returns unified diff given original and modified snippets.
- **Executor**: runs shell commands in project root (used only for validation).
- **Indexer Query**: query project index for roles, routes, and file metadata.

**Skill injection**

- Skills are Markdown files loaded dynamically from `core/src/skills/skill-files`.
- Skills are included in the system prompt as behavioral constraints and examples.
- Prioritize skills by agent role; truncate to fit token budget.

**Safety**

- Agents must never send entire files; only relevant snippets.
- Agents must not call external networks.
- Agents must log all generated patches and require validation before applying.

---

## Validation Pipeline

**Principle**
Never claim success without running real validation commands in the project environment.

**Steps for coding tasks**

1. Load Project Index.
2. Retrieve relevant files and generate changes.
3. Produce a unified diff and present to user.
4. Apply changes in a temporary branch or working copy.
5. Run:
   - `npm run build` (or project equivalent)
   - `npm run lint`
   - `npm run test`
6. Capture stdout/stderr and exit codes.
7. If any step fails, mark task as failed and attach logs.
8. If all pass, mark task as validated and optionally commit changes.

**Execution**

- Use child process execution with timeouts and resource limits.
- Capture logs and store in `data/projects/<id>/validation/<task-id>.log`.
- Do not auto‑commit without explicit user confirmation.

---

## CLI Behavior

**Entry command**
`laila`

**Primary flow**

- Prompt for project path.
- Validate path and permissions.
- Detect git repository (`.git`).
- Run scanner if first load or if user requests `scan`.
- Persist project metadata to SQLite.
- Accept commands mapped to agents:
  - `laila init` initialize project
  - `laila scan` rescan project
  - `laila run --agent coder --intent "refactor X"`
  - `laila status` show projects and last scan
  - `laila task status <task-id>`

**Design**

- Keep CLI synchronous and interactive.
- Provide non‑interactive flags for scripting.

---

## Deployment and Infra

**Local deployment**

- Install Node.js and Ollama locally.
- Ensure Ollama hosts `qwen2.5-coder:3b` model and is reachable via local API.
- Optional Dockerfile to containerize the core services for reproducible environments.

**Docker considerations**

- GPU passthrough for Ollama if using containerized model hosting.
- Keep core Node app outside heavy containers to avoid resource contention.

**Ollama**

- Configure Ollama to use local model only.
- Monitor VRAM usage; `qwen2.5-coder:3b` is chosen for modest footprint.

**N8N**

- Optional local N8N instance for notifications and scheduled jobs.
- N8N is not the brain; it only receives events (task completed, validation failed) and triggers notifications.

---

## Security and Privacy

**Offline guarantee**

- No network calls by default. All LLM calls are local to Ollama.
- Agents must not include secrets in prompts or logs.

**Secrets handling**

- Never store secrets in SQLite or project index.
- If executing commands that require environment variables, read them from the user environment at runtime and do not persist.

**Permissions**

- CLI runs with the invoking user privileges.
- When executing build/test commands, run in a sandboxed temporary branch or working copy.

---

## Operational Notes

**Resource constraints**

- Target GTX 1650 with 4GB VRAM and 16GB RAM.
- Limit concurrent LLM calls to 1.
- Limit file snippet size and number of files sent to model to stay within token and memory budgets.

**Logging**

- Structured logs in `data/projects/<id>/logs`.
- Task and validation logs persisted in SQLite and file system.

**Backups**

- Encourage users to back up `data/laila.sqlite` and `data/projects` directory.

---

## Conventions and Best Practices

- **Project Index** is authoritative for agent context.
- **Never** send full files to the model.
- Use deterministic LLM settings for code generation.
- Always run validation commands before accepting changes.
- Keep skill Markdown files concise and focused; prefer examples and rules over long prose.
- Prefer small, incremental patches over large rewrites.

---

## Edge Cases and Risks

**Edge cases**

- Monorepos with multiple package managers: scanner must detect and index per‑workspace.
- Binary files and generated artifacts: scanner should ignore `node_modules`, `dist`, and other large folders.
- Nonstandard project layouts: scanner may miss roles; provide manual overrides.

**Risks**

- Model hallucination producing incorrect code. Mitigation: require validation and human review.
- Resource exhaustion when scanning very large repos. Mitigation: configurable depth and file size limits.
- Accidental secret exposure in logs. Mitigation: redact environment variables and known secret patterns.

---

## Maintenance and Technical Debt

**Areas likely to need attention**

- Scanner heuristics will need continuous improvement for new frameworks.
- Prompt templates and skill files will require tuning as agents evolve.
- Token budget management as models or tasks change.
- Migration from JSON DB to SQLite and schema migrations.

**Recommendations**

- Keep skill files under version control and review them periodically.
- Add unit tests for scanner heuristics and orchestrator intent mapping.
- Add integration tests that run validation pipeline on small sample projects.

---

## Implementation Notes and Commands

**Development**

- Build: `npm run build`
- Dev run: `npm run dev` (uses ts-node)
- CLI: `node dist/cli/index.js init`

**Scanner**

- Configurable concurrency and ignore patterns in `core/src/scanner/config.ts`.

**SQLite**

- Migrations via simple SQL files in `core/infra/migrations`.
- Use parameterized queries and transactions.

**Ollama client**

- Wrap HTTP calls with retry and backoff.
- Enforce single concurrent request and low temperature for code tasks.

**Temporary branches**

- Use `git worktree` or create a temporary branch for applying patches and running validation.

---

## Example Workflows

### Initialize Project

1. `laila init`
2. Enter project path.
3. Scanner runs and writes `project-index.json`.
4. Project metadata saved to SQLite.

### Refactor Function

1. `laila run --agent coder --intent "refactor user service to async/await"`
2. Orchestrator selects Coder Agent.
3. File Retriever returns relevant snippets.
4. Skill `backend-engineer.md` injected.
5. Ollama returns patch.
6. Present patch to user.
7. On approval, apply patch in temp branch and run `npm run build && npm run lint && npm run test`.
8. Persist results and logs.

---

## Diagrams and Maps

**ASCII architecture diagram**

```
[CLI] -> [Orchestrator] -> [Agents] -> [Ollama Model]
                       \-> [File Retriever] -> [Project Index JSON / files]
                       \-> [SQLite Memory]
                       \-> [Validation Executor] -> (build/lint/test)
                       \-> [N8N] (notifications)
```

**Dependency map**

- Node.js app depends on Ollama local API and SQLite.
- Scanner depends on file system and optional git CLI.
- Validation depends on project toolchain (npm, yarn, go, pip).

---

## Onboarding Checklist for New Developers

- Install Node.js LTS and Yarn/NPM.
- Install and configure Ollama with `qwen2.5-coder:3b`.
- Clone repo and run `npm install`.
- Run `npm run dev` and `laila init` against a small sample project.
- Review `core/src/skills/skill-files` and `core/src/agents` to understand prompts.

---

## Next Steps and Roadmap

> **Current Goal**: Evolve Laila into a fully agentic, Kiro-class local AI assistant — retaining local-first, offline principles while matching the tool-use depth and context intelligence of cloud-based assistants.

### Phase 1 — File Tools (Highest Impact) ✅ Done
- Implement dedicated `file-tool.ts` with read, write, create, and insert operations.
- Expose file tools to all agents so they can read/modify files directly without relying on shell commands.
- Safety: never overwrite files without showing a diff and requiring user confirmation.

### Phase 2 — Shell Tool: `laila` Binary Allowed ✅ Done
- Added `laila` to the `ALLOWED_PREFIXES` list in `shell-tool.ts` so Laila can invoke its own CLI sub-commands.

### Phase 3 — Auto Skill Selection (Context-Aware) ✅ Done
- Improve `skill-loader.ts` to score and rank skills based on task keywords, detected frameworks, and agent role.
- Auto-inject the top N most relevant skills rather than loading all or a fixed set.
- Add Redis, RAG, and remaining Kiro-parity skill files to `skills/` directory.

### Phase 4 — Multi-Step Task Planning ✅ Done
- Add a `planner` module in `orchestrator/` that breaks complex tasks into ordered sub-steps.
- Each sub-step runs as an independent agent call with its own context and skill injection.
- Present the plan to the user before execution; allow approval or edit.

### Phase 5 — RAG / Semantic Context Retrieval
- Replace keyword-based file retrieval with embedding-based semantic search.
- Use a lightweight local embedding model (e.g., `nomic-embed-text` via Ollama).
- Store embeddings in SQLite (via `sqlite-vec` extension) to keep local-first guarantee.
- Retrieve top-K semantically relevant file snippets per task.

### Phase 6 — Sub-Agent / Pipeline System ✅ Done
- Allow the orchestrator to spawn and coordinate multiple agents in a DAG pipeline.
- Example: Researcher → Coder → Reviewer → Writer in a single task run.
- Persist inter-agent messages and results in SQLite for full auditability.

### Phase 7 — Validation & Test Hardening ✅ Done
- Add unit tests for scanner heuristics, intent detection, and skill loader.
- Add integration tests that run the full validation pipeline on small sample projects.
- Enforce validation before any file write is accepted.

### Phase 8 — Optional N8N Integration ✅ Done
- N8N integration for notifications and scheduled scans (task completed, validation failed).
- N8N is not the brain; it only receives events and triggers external notifications.

### Phase 9 — Multi-Modal Vision, AST Repo Mapping & MCP ✅ Done
- Implement Multi-Modal Vision capabilities.
- Enhance scanner with AST-like signature repo mapping for better context.
- Implement Model Context Protocol (MCP) client and Named Servers with auto-triggering.

### Phase 10 — Episodic Memory & Docker Sandbox ✅ Done
- Implement long-term Episodic Memory for the agent to remember facts across sessions.
- Self-healing build loops and Docker sandbox execution capabilities.

### Phase 11 — Surgical Regex Search (Ripgrep) ✅ Done
- Provide Laila with a dedicated fast-regex search tool for exact variable/reference lookups.
- Ponytail approach: Leverage `git grep` natively since it's already installed, avoiding `ripgrep` binary bloat.

### Phase 12 — Git-Ops & Auto-Commits ✅ Done
- Add a `/commit` slash command.
- Laila reads the `git diff`, writes a concise semantic commit message, and commits the work automatically.

### Phase 13 — Autonomous Self-Healing Loop ✅ Done
- When validation (`npm run build`) fails, instead of just rolling back, automatically feed the error log back to the Coder.
- Allow Laila up to 3 automatic retry attempts to fix her own syntax/type errors before giving up.

### Phase 14 — Zero-Bloat File Watcher (Real-time Indexing) ✅ Done
- Run a native Node.js `fs.watch` loop in the background.
- Update SQLite and RAG embeddings the millisecond a file is saved in the IDE.

### Phase 16 — Native Clipboard Ingestion & Browser Agent ✅ Done
- Implement `/paste` to instantly read text and images from the OS clipboard without heavy dependencies, feeding them into Laila's context.
- Equip Laila with Playwright via `browser-tool.ts` so she can load URLs, scrape DOM, intercept console logs, and take full-page screenshots for visual UI debugging.

---

## Contact Points and Troubleshooting

**Common issues**

- Ollama not reachable: verify local Ollama service and model availability.
- Validation failures: inspect `data/projects/<id>/validation/<task-id>.log`.
- Scanner misses files: adjust ignore patterns and run `laila scan --depth N`.

**Helpful commands**

- Show projects: `laila status`
- Rescan project: `laila scan --project <id>`
- Task status: `laila task status <task-id>`

---

## Final Notes

This BRAIN.md is intentionally pragmatic and focused on enabling deterministic, auditable, and safe automation for developer workflows. Keep it updated as the system evolves. When in doubt, prefer explicit validation and human confirmation over automated changes.
