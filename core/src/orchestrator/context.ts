import { getRelevantFiles } from '../memory/context-store.js';
import { findById } from '../memory/repositories/projects.js';
import { getMessages } from '../memory/repositories/tasks.js';
import { getSkillForAgent } from '../skills/skill-registry.js';
import { readJSON, readFileSafe } from '../utils/fs-utils.js';
import { getGitStatus, getGitDiff } from '../utils/git-utils.js';
import path from 'path';
import { SESSION_HISTORY_SIZE } from '../config.js';
import { getProjectIndexPath, getLegacyProjectIndexPath } from '../scanner/project-index.js';
import { logger } from '../utils/logger.js';
import type { AgentContext, AgentName, ProjectIndex, Message } from '../types.js';

/**
 * Assembles the full {@link AgentContext} for a single orchestrator turn.
 *
 * Retrieves and merges the following layers (in priority order):
 * 1. Project index — compact structural snapshot of the scanned repo
 * 2. Project memory — contents of `LAILA.md` / `BRAIN.md` at the project root
 * 3. Relevant files — top-N files scored against the user's query keywords
 * 4. Skill — the best-matching skill markdown for the active agent
 * 5. Available skills — full list of discovered skills for the system prompt
 * 6. History — last {@link SESSION_HISTORY_SIZE} messages from the previous task
 * 7. Git context — current `git status` and unstaged diff
 *
 * @param params.userMessage  - Raw text entered by the user
 * @param params.agent        - The agent role selected by intent detection
 * @param params.taskId       - ID of the newly created task record
 * @param params.projectId    - Active project ID, or `null` in global mode
 * @param params.previousTaskId - ID of the last completed task (for history)
 * @returns A fully populated {@link AgentContext} ready for prompt building
 */
export async function buildContext(params: {
  userMessage: string;
  agent: AgentName;
  taskId: number;
  projectId: number | null;
  previousTaskId?: number;
}): Promise<AgentContext> {
  const { userMessage, agent, taskId, projectId, previousTaskId } = params;

  // ── Project index ────────────────────────────────────────────────────────
  let projectIndex: ProjectIndex | null = null;
  let projectPath = '';

  if (projectId !== null) {
    const project = findById(projectId);
    if (project) {
      projectPath = project.path;
      projectIndex = await readJSON<ProjectIndex>(getProjectIndexPath(projectId))
        ?? await readJSON<ProjectIndex>(getLegacyProjectIndexPath(projectPath));
    }
  }

  // ── Project memory ───────────────────────────────────────────────────────
  let projectMemory: string | null = null;
  if (projectPath) {
    projectMemory = await readFileSafe(path.join(projectPath, 'LAILA.md'))
      ?? await readFileSafe(path.join(projectPath, '.laila', 'LAILA.md'))
      ?? await readFileSafe(path.join(projectPath, 'BRAIN.md'))
      ?? await readFileSafe(path.join(projectPath, 'Brain.md'));
  }

  // ── Relevant files ───────────────────────────────────────────────────────
  const relevantFiles = projectId !== null && projectPath
    ? await getRelevantFiles(projectId, projectPath, userMessage)
    : [];

  // ── Skill ────────────────────────────────────────────────────────────────
  // Pass detected framework + languages so the scorer can boost relevant skills
  const detectedFramework = projectIndex?.framework ?? null;
  const detectedLanguages = projectIndex?.languages ?? [];
  const skill = await getSkillForAgent(agent, userMessage, detectedFramework, detectedLanguages);

  // ── Available Skills ─────────────────────────────────────────────────────
  let availableSkills: string | undefined;
  try {
    const { rankSkillsForQuery } = await import('../skills/skill-loader.js');
    const rankedSkills = await rankSkillsForQuery(userMessage, agent, 3, detectedFramework, detectedLanguages);
    availableSkills = rankedSkills
      .map(s => `- ${s.name} (score: ${s.score})${s.description ? `: ${s.description}` : ''}`)
      .join('\n') || undefined;
  } catch (err) {
    logger.debug?.('Failed to discover skills: ' + String(err));
  }

  // ── History ──────────────────────────────────────────────────────────────
  let history: Message[] = [];
  if (previousTaskId !== undefined) {
    const all = getMessages(previousTaskId);
    history = all.slice(-SESSION_HISTORY_SIZE);
  }

  // ── Git Context ──────────────────────────────────────────────────────────
  let gitStatus: string | undefined;
  let gitDiff: string | undefined;
  if (projectPath) {
    const status = await getGitStatus(projectPath);
    if (status) gitStatus = status;

    const diff = await getGitDiff(projectPath);
    if (diff) {
      // Truncate diff to avoid eating the whole context budget.
      // Reserve ~3 000 chars for diff — enough for a meaningful change summary
      // without crowding out project index and relevant file contents.
      const MAX_DIFF_CHARS = 3_000;
      if (diff.length > MAX_DIFF_CHARS) {
        gitDiff = diff.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated — showing first 3 000 chars ...]';
      } else {
        gitDiff = diff;
      }
    }
  }

  return {
    userMessage,
    projectIndex,
    projectMemory,
    gitStatus,
    gitDiff,
    relevantFiles,
    skill: skill.content,
    availableSkills,
    history,
    taskId,
  };
}
