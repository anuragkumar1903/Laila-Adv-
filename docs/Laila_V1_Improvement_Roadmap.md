# Laila V1 Improvement Roadmap

## Overview

This document summarizes the recommended improvements for **Laila V1**, lessons learned from **Terax**, and a proposed roadmap towards **Laila V2**.

---

# 1. V1 Improvements

| Area | Current State | Proposed Improvement | Priority | Effort | Inspiration |
|------|---------------|----------------------|:--------:|:------:|-------------|
| **Project Memory** | Scanner + SQLite | Introduce `LAILA.md` containing architecture, coding standards, commands, conventions, and project-specific notes. | ⭐⭐⭐⭐⭐ | Medium | Terax (`TERAX.md`) |
| **Context Builder** | Keyword relevance | Hybrid retrieval using imports, routes, symbols, Git history, and semantic ranking. | ⭐⭐⭐⭐⭐ | High | Cursor, Claude Code |
| **Intent Detection** | Rule-based | Semantic intent classifier with rule-based fallback. | ⭐⭐⭐⭐ | Medium | Claude Code |
| **File Retrieval** | File snippets | Retrieve symbols, functions, classes instead of entire files. | ⭐⭐⭐⭐⭐ | High | Aider, Sourcegraph |
| **Editing** | Generates responses | Preview unified diffs before modifying files. | ⭐⭐⭐⭐⭐ | Medium | Terax |
| **Agent Collaboration** | Single-agent execution | Planner → Specialist → Reviewer workflow. | ⭐⭐⭐⭐⭐ | High | Claude Code |
| **Working Memory** | Task history only | Scratchpad, execution state, retries, temporary memory. | ⭐⭐⭐⭐ | Medium | OpenHands |
| **Scanner** | File indexing | Dependency graph, API graph, import graph. | ⭐⭐⭐⭐⭐ | High | Sourcegraph |
| **Skills** | Markdown bundles | Versioning, aliases, inheritance. | ⭐⭐⭐ | Medium | Terax |
| **Validation** | Build → Lint → Test | Auto-fix, re-run validation, summarize failures. | ⭐⭐⭐⭐ | Medium | Claude Code |
| **CLI UX** | Basic REPL | Rich TUI with progress bars, streaming output, panels, colors. | ⭐⭐⭐⭐ | Medium | Claude Code, Warp |
| **Session Resume** | Limited | Resume interrupted engineering sessions. | ⭐⭐⭐⭐ | Low | Claude Code |
| **Diagnostics** | `doctor` | JSON output, health score, actionable fixes. | ⭐⭐⭐⭐ | Low | Terraform CLI |
| **Model Support** | Ollama | Provider abstraction (LM Studio, OpenAI-compatible APIs, Ollama). | ⭐⭐⭐⭐ | Medium | Terax |
| **Search** | Scanner | ripgrep integration with AI-assisted reasoning. | ⭐⭐⭐⭐ | Medium | Terax |
| **Git Integration** | External | Native Git status, staged diff, blame, commit summaries. | ⭐⭐⭐⭐ | Medium | Terax |
| **Performance** | Full scan | Incremental indexing using hashes and watch mode. | ⭐⭐⭐⭐⭐ | Medium | VS Code |
| **Plugins** | Fixed runtime | Plugin SDK with lifecycle hooks. | ⭐⭐⭐ | High | VS Code |
| **Configuration** | Static | Per-project `.laila/config.yaml`. | ⭐⭐⭐⭐ | Low | Claude Code |
| **Observability** | SQLite history | Token usage, latency, context size, validation metrics. | ⭐⭐⭐ | Medium | LangSmith |

---

# 2. Best Takeaways from Terax

| Feature | Why It Matters | Recommendation | Suggested Implementation |
|---------|----------------|----------------|--------------------------|
| `TERAX.md` | Persistent project memory | ✅ Adopt | `LAILA.md` |
| AI Edit Diff | Safe review before changes | ✅ Adopt | Diff-first editing workflow |
| Skills | Reusable workflows | ✅ Expand | Versioning + aliases |
| Built-in Git | Faster workflow | ✅ Adopt | Git status, diff, blame, commit |
| Plans & Tasks | Transparent execution | ✅ Adopt | Planner before execution |
| Local-first Architecture | Privacy + performance | ✅ Continue | Preserve local-first philosophy |
| Provider Abstraction | Model flexibility | ✅ Adopt | Unified provider interface |
| Multi-tab UI | Desktop convenience | ❌ Skip | Keep CLI-first |
| Built-in Browser | GUI-focused | ❌ Skip | Out of scope |
| Built-in Editor | High maintenance | ❌ Skip | Integrate with existing editors |
| Themes | Cosmetic | ⚪ Later | Post V1 stabilization |
| Voice Input | Convenience | ⚪ Future | Optional module |

---

# 3. Features Not Worth Copying

| Feature | Why Not? |
|----------|----------|
| Built-in IDE | Competes with VS Code instead of complementing it. |
| Browser Preview | Outside the scope of a CLI engineering assistant. |
| Theme Engine | Cosmetic with limited engineering value. |
| Desktop Workspace | Adds maintenance overhead without improving the core product. |
| Window Management | Unnecessary for a CLI-first experience. |

---

# 4. Suggested V1.5 Roadmap

| Sprint | Deliverable | Impact |
|---------|-------------|:------:|
| Sprint 1 | `LAILA.md` project memory | ⭐⭐⭐⭐⭐ |
| Sprint 2 | Incremental scanner | ⭐⭐⭐⭐⭐ |
| Sprint 3 | Unified diff editor | ⭐⭐⭐⭐⭐ |
| Sprint 4 | Git integration | ⭐⭐⭐⭐ |
| Sprint 5 | Rich CLI / TUI | ⭐⭐⭐⭐ |
| Sprint 6 | Better retrieval (symbols, imports) | ⭐⭐⭐⭐⭐ |
| Sprint 7 | Session resume | ⭐⭐⭐⭐ |
| Sprint 8 | Structured diagnostics | ⭐⭐⭐ |

---

# 5. Long-Term Vision (V2)

```text
┌─────────────────────────────────────────────┐
│                 LAILA CLI                   │
├─────────────────────────────────────────────┤
│              Orchestrator                   │
├─────────────────────────────────────────────┤
│ Planner │ Research │ Coder │ Reviewer │ QA │
├─────────────────────────────────────────────┤
│ Context Engine │ Memory │ Retrieval │ Skills│
├─────────────────────────────────────────────┤
│ Git │ Scanner │ Validator │ Tools │ Search │
├─────────────────────────────────────────────┤
│ Ollama │ LM Studio │ OpenAI-Compatible APIs │
├─────────────────────────────────────────────┤
│ SQLite │ Project Index │ LAILA.md │ Cache   │
└─────────────────────────────────────────────┘
```

## Design Philosophy

- Stay **CLI-first**, not IDE-first.
- Keep the architecture **local-first**.
- Build **agent orchestration**, not just AI chat.
- Make every code change **reviewable**.
- Optimize for **software engineering workflows**, not general-purpose assistance.
