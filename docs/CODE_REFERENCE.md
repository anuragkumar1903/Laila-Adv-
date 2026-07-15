# Laila Code Reference

This document is the inline API reference for all core modules. It covers function signatures, parameters, return types, and behaviour notes for every public export.

---

## Table of Contents

- [Orchestrator](#orchestrator)
  - [context.ts — buildContext](#contexttsbuildcontext)
  - [intent.ts — detectIntent](#intenttsdetectintent)
  - [orchestrator.ts — run](#orchestratortSrun)
- [Agents](#agents)
  - [BaseAgent](#baseagent)
  - [CoderAgent](#coderagent)
  - [ReviewerAgent](#revieweragent)
  - [ResearchAgent](#researchagent)
  - [WriterAgent](#writeragent)
  - [GeneralAgent](#generalagent)
- [Scanner](#scanner)
  - [scanner.ts — scanProject](#scannertsscanproject)
  - [project-index.ts](#project-indexts)
- [Memory](#memory)
  - [context-store.ts — getRelevantFiles](#context-storetsgetrelevantfiles)
  - [repositories/projects.ts](#repositoriesprojectsts)
  - [repositories/sessions.ts](#repositoriessessionsts)
  - [repositories/tasks.ts](#repositoriestasksts)
- [LLM](#llm)
  - [prompt-builder.ts — buildMessages](#prompt-buildertsbuildmessages)
  - [provider-factory.ts](#provider-factoryts)
  - [providers/base.ts — LLMProvider interface](#providersbasts--llmprovider-interface)
- [Editor](#editor)
  - [diff-editor.ts](#diff-editorts)
- [Tools](#tools)
  - [shell-tool.ts](#shell-toolts)
- [Skills](#skills)
  - [skill-loader.ts](#skill-loaderts)
  - [skill-registry.ts — getSkillForAgent](#skill-registrytsgetskillforagent)
- [Utils](#utils)
  - [fs-utils.ts](#fs-utilsts)
  - [git-utils.ts](#git-utilsts)
  - [logger.ts](#loggerts)
- [Config](#config)

---

## Orchestrator

### context.ts — buildContext

Assembles the full `AgentContext` for a single orchestrator turn. This is the most important function in the system — it determines what the LLM sees.

```typescript
buildContext(params: {
  userMessage: string;
  agent: AgentName;
  taskId: number;
  projectId: number | null;
  previousTaskId?: number;
}): Promise<AgentContext>
```

**Layers assembled (in priority order):**

| Layer | Source | Notes |
|---|---|---|
| Project index | `data/projects/<id>/project-index.json` | Falls back to legacy root `project-index.json` |
| Project memory | `LAILA.md` / `.laila/LAILA.md` / `BRAIN.md` | First file found wins |
| Relevant files | SQLite keyword search → file reads | Capped at `MAX_RELEVANT_FILES`, truncated to `MAX_FILE_LINES` |
| Skill | `skills/` discovery → `skill-registry` | Best match for agent + query |
| Available skills | `discoverSkills()` | Injected as a system message list |
| History | `getMessages(previousTaskId)` | Last `SESSION_HISTORY_SIZE` messages only |
| Git context | `git status --short` + `git diff` | Silently omitted if not a git repo |

**Returns:** `AgentContext` — passed directly to the agent's `run()` method.

---

### intent.ts — detectIntent

Fast keyword-scoring classifier. No LLM call — runs synchronously.

```typescript
detectIntent(input: string): { intent: TaskIntent; agent: AgentName }
```

**Scoring:** Each keyword list is checked against the lowercased input. The intent with the highest match count wins. Ties favour the first in score order. Falls back to `general` when all scores are zero.

**Intent → Agent mapping:**

| Intent | Agent |
|---|---|
| `code` | `coder` |
| `review` | `reviewer` |
| `research` | `researcher` |
| `write` | `writer` |
| `general` | `general` |

**Keyword lists:**

- `CODE_KEYWORDS` — implement, create, add, build, fix bug, refactor, optimize, scaffold …
- `REVIEW_KEYWORDS` — review, check, audit, analyse, feedback, code quality …
- `RESEARCH_KEYWORDS` — explain, how does, what is, why, best practice, compare …
- `WRITE_KEYWORDS` — write docs, document, readme, changelog, jsdoc …

---

### orchestrator.ts — run

Top-level turn handler. Called once per user message.

```typescript
run(input: OrchestratorInput): Promise<OrchestratorResult>

interface OrchestratorInput {
  userMessage: string;
  sessionId: number;
  projectId: number | null;
  previousTaskId?: number;
}

interface OrchestratorResult {
  taskId: number;
  intent: string;
  agent: AgentName;
  response: string;
  tokensUsed?: number;
}
```

**Steps:**
1. `detectIntent` — classify and select agent
2. `createTask` — persist task record in SQLite with status `running`
3. `addMessage` — store user message
4. `buildContext` — assemble context
5. `agent.run(ctx)` — call LLM via selected agent
6. `addMessage` — store assistant response
7. `completeTask` — mark task `done`
8. N8N notify (fire-and-forget, non-blocking)

> Validation is **not** triggered here. It is triggered by `start.ts` after the user accepts a diff, gated on `filesWritten > 0`.

---

## Agents

All agents extend `BaseAgent` and live in `core/src/agents/`.

### BaseAgent

```typescript
abstract class BaseAgent {
  abstract readonly name: string;
  run(ctx: AgentContext): Promise<AgentResponse>;
}
```

`run()` calls `buildMessages(ctx)` then `chat(messages)`. Subclasses override `run()` to enrich `ctx.userMessage` with role-specific instructions before calling `super.run()` or calling the LLM directly.

---

### CoderAgent

Name: `coder`  
Temperature: `0.1` (highly deterministic)

Enriches the user message with:
- Full file output instruction: `// FILE: <path>` as the first line inside every code block
- Shell command block format: ` ```cmd ` fences with a reason comment
- Allowlist of safe CLI tools the model may propose
- Safety rules: no deletes, no privilege escalation, one command at a time

---

### ReviewerAgent

Name: `reviewer`  
Temperature: `0.3`

Appends a 6-point review checklist:
1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Clarity and maintainability
5. Edge case handling
6. Test coverage gaps

Output format: each issue with severity label (`Critical / High / Medium / Low`), file location, and a suggested fix.

---

### ResearchAgent

Name: `researcher`  
Temperature: `0.4`

Instructs the model to:
- Provide a clear, accurate explanation
- Use examples where helpful
- Stay concise — no padding
- Cite specific project files when referencing the codebase

---

### WriterAgent

Name: `writer`  
Temperature: `0.5`

Instructs the model to:
- Write in professional Markdown with headings, bullets, and code blocks
- Target developers familiar with the stack
- Never include placeholder text — every section must be real content

---

### GeneralAgent

Name: `general`  
Temperature: default (`0.2`)

No prompt enrichment. Behaviour is governed entirely by the `general-assistant` skill. Used as fallback when intent detection scores are all zero.

---

## Scanner

### scanner.ts — scanProject

```typescript
scanProject(
  projectPath: string,
  previousIndex?: ProjectIndex | null
): Promise<ScanResult>
```

**Steps:**
1. Build ignore rules from `SCAN_EXCLUDES` config + `.gitignore`
2. `glob('**/*')` — collect all non-directory paths
3. Filter binary extensions via `isTextFile()`
4. Categorise each file: `controller / service / route / model / test / config / schema / middleware / util / other`
5. Detect framework, languages, package manager, git remote
6. Extract Express router patterns + Next.js page routes

**Incremental mode:** If `previousIndex` is passed, files whose `mtime ≤ previousIndex.scannedAt` are reused without re-reading. The `reusedFiles` count in the result reflects this.

**Returns:** `ScanResult` containing `files[]`, `routes[]`, `totalFiles`, `reusedFiles`, `framework`, `languages`, `pkgManager`, `summary`.

---

### project-index.ts

```typescript
buildProjectIndex(projectId: number, projectPath: string, scan: ScanResult): ProjectIndex
writeProjectIndex(projectPath: string, index: ProjectIndex): Promise<void>
getProjectIndexPath(projectId: number): string      // data/projects/<id>/project-index.json
getLegacyProjectIndexPath(projectPath: string): string  // <projectPath>/project-index.json
```

`buildProjectIndex` groups scanned files by category into the `files` map and computes the `filesMeta` array for the prompt builder.

`writeProjectIndex` writes to both the canonical path (`data/projects/<id>/`) and the legacy root path for backwards compatibility.

---

## Memory

### context-store.ts — getRelevantFiles

```typescript
getRelevantFiles(
  projectId: number,
  projectPath: string,
  query: string,
  maxFiles?: number   // default: MAX_RELEVANT_FILES (5)
): Promise<RelevantFile[]>
```

**Algorithm:**
1. `extractKeywords(query)` — tokenise query, strip stop words and short tokens
2. `searchFiles(projectId, keywords)` — SQLite LIKE match on `rel_path`
3. Fall back to `findByProject(projectId)` when no keywords are found
4. Read up to `MAX_FILE_LINES` (300) lines per file
5. Return `{ relPath, content, category, truncated }[]`

Files deleted since last scan are silently skipped.

---

### repositories/projects.ts

```typescript
upsertProject(data: NewProject): Project
findByPath(p: string): Project | null
findById(id: number): Project | null
findAll(): Project[]
updateLastScanned(id: number): void
deleteProject(id: number): void   // cascades to project_files, sessions, tasks
```

`upsertProject` checks for an existing record by `path` before inserting. On conflict it updates all mutable fields (`name`, `git_remote`, `framework`, `languages`, `pkg_manager`).

---

### repositories/sessions.ts

```typescript
createSession(projectId: number | null): Session
findLatestSession(): Session | null
findLatestActiveSession(): Session | null   // ended_at IS NULL
endSession(id: number): void
```

`findLatestActiveSession` is called at startup to offer resume. Pass `null` as `projectId` for global (no-project) sessions.

---

### repositories/tasks.ts

```typescript
createTask(data: { sessionId, projectId, intent, agent, input }): Task
completeTask(id, output, status?, validation?): void
findBySession(sessionId, limit?): Task[]
findRecent(limit?): Task[]
addMessage(taskId, role, content): Message
getMessages(taskId): Message[]
```

`createTask` sets status to `running`. `completeTask` sets `output`, `status` (`done` or `failed`), optional serialised `validation`, and `completed_at`.

Message roles: `user | assistant | system`.

---

## LLM

### prompt-builder.ts — buildMessages

```typescript
buildMessages(ctx: AgentContext): OllamaMessage[]
```

Assembles the ordered message array sent to the LLM. Budget-aware — trims the files block if adding it would exceed `MAX_CONTEXT_CHARS`.

**Message order:**
1. `system` — Laila identity (`LAILA_IDENTITY`)
2. `system` — skill content
3. `system` — available skills list (if any)
4. `system` — project memory (`LAILA.md` / `BRAIN.md`)
5. `system` — project index summary
6. `system` — git status + diff
7. `user/assistant` — conversation history (skip `system` messages)
8. `user` — current user message + relevant file blocks

---

### provider-factory.ts

```typescript
getProvider(projectPath?: string): Promise<LLMProvider>
setProvider(provider: LLMProvider): void
resetProvider(): void
buildProvider(config: ProviderConfig): LLMProvider
chat(messages, options?): Promise<{ content: string; tokensUsed: number }>
```

`getProvider` loads config from disk/env on first call and caches the result for the process lifetime. Call `resetProvider()` before `setProvider()` when switching mid-session.

`chat` is a convenience wrapper — agents call this rather than importing a concrete provider.

**Config priority:** env vars → project `.laila/config.yaml` → global `~/.laila/config.yaml`.

---

### providers/base.ts — LLMProvider interface

```typescript
interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  healthCheck(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  modelExists(model: string): Promise<boolean>;
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<ChatResponse>;
}
```

Concrete implementations: `OllamaProvider`, `AnthropicProvider`, `GeminiProvider`, `OpenAICompatProvider` (covers OpenAI, DeepSeek, Groq, Mistral, LM Studio, custom).

`ChatOptions`:
```typescript
{ temperature?: number; top_p?: number; maxTokens?: number; stream?: boolean }
```

`ChatResponse`:
```typescript
{ content: string; tokensUsed: number; model: string; provider: string }
```

---

## Editor

### diff-editor.ts

```typescript
parseCodeBlocks(response: string): ParsedBlock[]
generateAndPromptDiff(
  projectPath: string,
  blocks: ParsedBlock[],
  rl?: readline.Interface   // pass REPL rl to avoid double-echo
): Promise<number>           // returns count of files actually written
```

`parseCodeBlocks` extracts fenced code blocks whose first line matches `// FILE: <path>`.

`generateAndPromptDiff` for each block:
1. Reads existing file content (empty string if new file)
2. Computes a unified diff via `createTwoFilesPatch`
3. Prints the coloured diff to stdout
4. Prompts the user to accept or skip
5. On accept: `mkdir -p` parent directories, then `writeFile`

Returns the number of files actually written — used to gate validation.

---

## Tools

### shell-tool.ts

```typescript
parseCommandBlocks(response: string): CommandBlock[]
validateCommand(command: string): SafetyVerdict
runCommandBlocks(blocks: CommandBlock[], opts: RunCommandOptions): Promise<CommandResult[]>
formatCommandResultsForContext(results: CommandResult[]): string
```

```typescript
interface RunCommandOptions {
  cwd: string;
  sessionId: number | null;
  taskId: number | null;
  rl?: readline.Interface;   // pass REPL rl to avoid double-echo
}
```

**Safety pipeline (per command):**
1. `validateCommand` — check blocklist (rm -rf, sudo, invoke-expression, …) then allowlist (npm, git, tsc, …)
2. `askPermission` — show boxed command preview, prompt user (default: yes)
3. `executeCommand` — spawn with `shell: true`, stream stdout/stderr, 2-minute timeout
4. `logToDb` — write to `command_log` table regardless of approval

`formatCommandResultsForContext` produces a compact string injected back into the conversation so the LLM can continue from actual command output.

---

## Skills

### skill-loader.ts

```typescript
discoverSkills(): Promise<SkillEntry[]>
loadSkill(fileName: string): Promise<Skill>     // accepts name, relative path, or absolute path
loadSkillSafe(fileName: string): Promise<Skill | null>
findSkillEntry(fileName: string): Promise<SkillEntry | null>
findBestSkillForQuery(query: string, currentAgent: AgentName): Promise<Skill | null>
```

**Discovery:** recursively scans `SKILLS_DIR` for `.md` files. Supported layouts:
- `skills/name.md`
- `skills/name/skill.md`
- `skills/name/index.md`

Frontmatter keys: `name`, `version`, `agent`, `description`, `triggers`.

`loadSkill` detects absolute paths and reads them directly — avoids path doubling when called with a full path from `discoverSkills`.

`findBestSkillForQuery` scores each skill by name match (+10), trigger match (+5), description match (+2), agent match (+1). Requires a minimum score of 5 to return a result.

---

### skill-registry.ts — getSkillForAgent

```typescript
getSkillForAgent(agent: AgentName, query?: string): Promise<Skill>
```

Resolution order:
1. `findBestSkillForQuery(query, agent)` — dynamic match when query is provided
2. `loadSkillSafe(AGENT_SKILL_MAP[agent])` — hardcoded default per agent role
3. `loadDiscoveredSkill(agent)` — any skill matching agent name/alias
4. Built-in fallback string — always succeeds, never throws

**Default skill map:**

| Agent | Default skill file |
|---|---|
| `coder` | `backend-engineer` |
| `reviewer` | `senior-code-reviewer` |
| `researcher` | `researcher` |
| `writer` | `technical-writer` |
| `general` | `general-assistant` |

---

## Utils

### fs-utils.ts

```typescript
pathExists(p: string): Promise<boolean>
ensureDir(dir: string): Promise<void>                          // mkdir -p
readFileLines(filePath, maxLines): Promise<{ lines, truncated }>
readFileSafe(filePath: string): Promise<string | null>         // null on any error
readJSON<T>(filePath: string): Promise<T | null>
writeJSON(filePath: string, data: unknown): Promise<void>      // creates parent dirs
getFileSizeBytes(filePath: string): Promise<number>            // 0 on error
getFileStat(filePath: string): Promise<Stats | null>           // null on error
isTextFile(filePath: string): boolean                          // checks extension against binary list
```

Binary extensions excluded from scanning: `.png .jpg .gif .pdf .zip .exe .dll .wasm .ttf .woff` and others — see `BINARY_EXTS` in the source.

---

### git-utils.ts

```typescript
isGitRepo(dir: string): Promise<boolean>
getGitRemote(dir: string): Promise<string | null>
getGitBranch(dir: string): Promise<string | null>
getGitRoot(dir: string): Promise<string | null>
getGitStatus(dir: string): Promise<string | null>              // git status --short
getGitDiff(dir: string, staged?: boolean): Promise<string | null>
getGitLog(dir: string, limit?: number): Promise<Array<{ hash, message }>>
getGitStaged(dir: string): Promise<string | null>              // diff --cached --name-status
getGitAheadBehind(dir: string): Promise<{ ahead, behind } | null>
commitChanges(dir: string, message: string): Promise<boolean>
```

All functions return `null` (or `false` for booleans) on any git error — callers never need to handle exceptions.

---

### logger.ts

```typescript
logger.debug(msg: string): void
logger.info(msg: string): void
logger.warn(msg: string): void
logger.error(msg: string): void
```

Writes to stdout. Debug output is suppressed unless `DEBUG=laila` is set in the environment.

---

## Config

Constants from `core/src/config.ts`:

| Constant | Default | Purpose |
|---|---|---|
| `REPO_ROOT` | resolved at runtime | Absolute path to the monorepo root |
| `SKILLS_DIR` | `<root>/skills` | Where skill bundles are discovered |
| `DATA_DIR` | `<root>/data` | SQLite DB and project storage |
| `DB_PATH` | `<root>/data/laila.db` | SQLite database file |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API base URL (legacy) |
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | Default model (legacy) |
| `MAX_FILE_LINES` | `300` | Lines per file before truncation |
| `MAX_RELEVANT_FILES` | `5` | Files sent to LLM per request |
| `MAX_CONTEXT_CHARS` | `14000` | Total character budget for the prompt |
| `SESSION_HISTORY_SIZE` | `8` | Previous messages kept in context |
| `SCAN_EXCLUDES` | `node_modules, .git, dist, …` | Directories/patterns excluded from scanning |

Environment variable overrides: `LAILA_PROVIDER`, `LAILA_MODEL`, `LAILA_API_KEY`, `LAILA_BASE_URL`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `N8N_WEBHOOK_URL`, `N8N_ENABLED`.
