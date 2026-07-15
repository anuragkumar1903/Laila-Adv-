# Laila Developer Guide

## Overview
Laila is a local-first CLI assistant built to help developers understand, modify, validate, and maintain codebases without cloud dependencies.

It uses:
- Node.js + TypeScript
- Ollama for inference
- SQLite for local persistence
- repository scanning for compact context
- skill bundles for agent behavior

## Repository Layout
- `core/src/cli` - commands, prompts, UI helpers
- `core/src/orchestrator` - intent routing and context assembly
- `core/src/agents` - role-specific agent wrappers
- `core/src/scanner` - repository analysis and indexing
- `core/src/memory` - SQLite schema and repositories
- `core/src/skills` - skill discovery and mapping
- `core/src/validation` - build/lint/test execution
- `core/src/system` - environment checks and remediation helpers
- `core/src/llm` - Ollama client and prompt builder
- `skills/` - discovered skill bundles and profiles
- `data/` - SQLite DB, n8n state, and project storage

## Boot Sequence
1. `core/src/cli/index.ts` initializes the DB schema.
2. No-arg `laila-cli` enters the start command by default.
3. `startCommand()` runs a system preflight.
4. The current folder is used automatically if it looks like a project.
5. The project is scanned and indexed if no prior scan exists.
6. The REPL starts and hands input to the orchestrator.

## CLI Commands
- `start` - interactive assistant
- `ask <query>` - single-turn Q&A
- `scan [path]` - build or refresh the project index
- `status` - current session snapshot
- `history` - recent task log
- `skills` - discover skill bundles
- `doctor` - environment and project health checks

## Detection And Routing
Intent detection is keyword-based in `core/src/orchestrator/intent.ts`.

Mapped intents:
- code -> coder
- review -> reviewer
- research -> researcher
- write -> writer
- general -> general

If the intent is ambiguous, the system currently stays lightweight and rule-based rather than calling another model to classify intent.

## Agents
The agent classes are thin wrappers around prompt shaping and Ollama calls.

Current classes:
- `CoderAgent`
- `ReviewerAgent`
- `ResearchAgent`
- `WriterAgent`
- `GeneralAgent`

The `coder` role is paired with the backend-engineer skill profile by default.

## Scanning And Indexing
The scanner does three important things:
- detects file language, category, package manager, and framework
- computes file hashes for change tracking
- emits a compact project index with file roles and route hints

The prompt builder uses this index to avoid sending the full repository to the model.

## Persistence
SQLite schema tracks:
- projects
- project files
- sessions
- tasks
- messages

Task creation, completion, and message history all go through repository helpers rather than direct SQL from the CLI.

## Validation
Coding tasks can trigger validation in this order:
- build
- lint
- test

The validator prefers the project’s own scripts and stops on first failure.

## System Checks
`doctor` and `start` share environment checks for:
- Node.js
- Git
- Docker
- n8n
- Ollama

The repository also recognizes local n8n state under `data/n8n` and local Docker Compose configuration under `infra/docker-compose.yml`.

## Working With Skills
Skills are automatically discovered from `skills/` and support both flat and nested folder layouts.

If you want a custom skill to become the default for a role, update `core/src/skills/skill-registry.ts`.

Good conventions:
- keep skill markdown concise
- use frontmatter for metadata
- prefer one bundle per role or concern
- name bundles clearly so they are easy to discover

## Safe Extension Patterns
When adding features:
- keep the CLI local-first
- avoid full-repo context dumps
- keep optional integrations non-blocking
- add repository functions for persistence changes
- validate with `npm run lint` and the build pipeline

## Suggested Improvement Areas
If you continue evolving the project, the highest-value next steps are:
- add tests for scanner heuristics and intent routing
- add a `doctor --json` output mode for automation
- add structured output for `skills` and `doctor`
- improve local service startup checks for Docker/n8n
- add more granular agent bundle discovery and aliasing
