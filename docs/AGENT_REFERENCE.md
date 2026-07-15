# Agent Reference

## Agent Model
Laila uses a small set of focused agents rather than one generic assistant.

Each agent is a combination of:
- an agent class in `core/src/agents`
- a skill bundle in `skills/`
- an intent route in `core/src/orchestrator/intent.ts`

## Available Agents

### Coder
- File: `core/src/agents/coder-agent.ts`
- Default skill: `backend-engineer`
- Purpose: implementations, refactors, bug fixes, new features
- Style: low temperature, code-focused, minimal explanation

### Reviewer
- File: `core/src/agents/reviewer-agent.ts`
- Default skill: `senior-code-reviewer`
- Purpose: code review, bugs, security, performance, maintainability
- Style: structured checklist and severity-based findings

### Researcher
- File: `core/src/agents/research-agent.ts`
- Default skill: `researcher`
- Purpose: explain code paths, compare options, answer design questions
- Style: accurate, concise, and grounded in repository evidence

### Writer
- File: `core/src/agents/writer-agent.ts`
- Default skill: `technical-writer`
- Purpose: docs, guides, changelogs, markdown output
- Style: professional Markdown and clear structure

### General
- File: `core/src/agents/general-agent.ts`
- Default skill: `general-assistant`
- Purpose: fallback and mixed tasks
- Style: uses the base agent behavior with minimal specialization

## Prompt Shaping
The agent class enriches the user message with role-specific instructions before calling the shared Ollama client.

That means the same model can behave differently by role without changing the runtime model host.

## Skill Bundles
Skills are discovered from the `skills/` directory.

Supported file layouts:
- `skills/name.md`
- `skills/name/skill.md`
- `skills/name/index.md`

Useful conventions:
- use frontmatter for `name`, `version`, and `agent`
- keep each bundle focused on one role or concern
- keep the content concise and practical

## Adding A New Skill Bundle
1. Create a folder or markdown file under `skills/`.
2. Add frontmatter metadata.
3. Run `laila-cli skills` to confirm discovery.
4. Map it in `core/src/skills/skill-registry.ts` if you want it to become the default for an agent role.

## Extending The Agent Set
If you want a new role such as `security-reviewer` or `frontend-engineer`, the clean path is:
- add a new agent class
- add or map a skill bundle
- extend intent routing if it should be selected automatically
- update docs so the role is visible to other developers and AI readers
