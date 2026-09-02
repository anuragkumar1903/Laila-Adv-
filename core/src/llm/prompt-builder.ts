import type { AgentContext, ProjectIndex, RelevantFile } from '../types.js';
import type { LLMMessage } from '../llm/providers/base.js';
import { getContextLimit } from './provider-factory.js';
import { LAILA_IDENTITY } from './identity.js';

// Approximate chars-per-message overhead for role labels in the API payload
const MESSAGE_OVERHEAD = 20;

/**
 * Render a compact, human-readable summary of a {@link ProjectIndex}.
 * Includes metadata, file-role counts (controllers, services, etc.),
 * detected routes, and a sample of indexed file records.
 * Used as the "project context" system message in every prompt.
 *
 * @param index - Project index to format
 * @returns Multi-line string suitable for embedding in a system message
 */
function formatProjectSummary(index: ProjectIndex): string {
  const lines: string[] = [
    `Project: ${index.projectName}`,
    `Path: ${index.projectPath}`,
    `Framework: ${index.framework ?? 'unknown'}`,
    `Languages: ${index.languages.join(', ') || 'unknown'}`,
    `Package manager: ${index.pkgManager ?? 'unknown'}`,
    `Summary: ${index.summary ?? 'n/a'}`,
    '',
    'File structure:',
  ];
  const { files } = index;
  if (files.controllers.length)  lines.push(`  Controllers (${files.controllers.length}): ${files.controllers.slice(0, 5).join(', ')}`);
  if (files.services.length)     lines.push(`  Services (${files.services.length}): ${files.services.slice(0, 5).join(', ')}`);
  if (files.routes.length)       lines.push(`  Routes (${files.routes.length}): ${files.routes.slice(0, 5).join(', ')}`);
  if (files.models.length)       lines.push(`  Models (${files.models.length}): ${files.models.slice(0, 5).join(', ')}`);
  if (files.schemas.length)      lines.push(`  Schemas (${files.schemas.length}): ${files.schemas.slice(0, 3).join(', ')}`);
  if (files.middleware.length)   lines.push(`  Middleware (${files.middleware.length}): ${files.middleware.slice(0, 3).join(', ')}`);
  if (files.tests.length)        lines.push(`  Tests: ${files.tests.length} files`);

  if (index.routes && index.routes.length) {
    lines.push('');
    lines.push('Routes:');
    for (const route of index.routes.slice(0, 8)) {
      lines.push(`  ${route.method} ${route.path} -> ${route.handler}`);
    }
  }

  if (index.filesMeta && index.filesMeta.length) {
    lines.push('');
    lines.push(`Indexed files: ${index.filesMeta.length}`);
    for (const file of index.filesMeta.slice(0, 8)) {
      const lang = file.language ?? 'unknown';
      lines.push(`  ${file.role}: ${file.path} [${lang}] ${file.hash.slice(0, 12)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render relevant project files as fenced code blocks for injection into
 * the user message. Truncated files are annotated so the model knows the
 * content is partial.
 *
 * @param files - Array of relevant files from {@link getRelevantFiles}
 * @returns Formatted string, or empty string when no files are provided
 */
function formatRelevantFiles(files: RelevantFile[]): string {
  if (files.length === 0) return '';
  const parts = files.map(f => {
    const header = `\n\`\`\`\n// File: ${f.relPath}${f.truncated ? ' (truncated to 300 lines)' : ''}\n`;
    return `${header}${f.content}\n\`\`\``;
  });
  return `\nRelevant project files:\n${parts.join('\n')}`;
}

/**
 * Build the full message array for the LLM from an agent context.
 *
 * - Uses the active provider's context window limit (via getContextLimit())
 *   instead of a hardcoded constant, so cloud models with large windows are
 *   not artificially capped to the local-model budget.
 * - Applies a per-message history budget: history messages are included
 *   newest-first until they would consume more than 30% of the total budget.
 * - Files block is trimmed last — it fills whatever remains after all other
 *   sections have been accounted for.
 */
export async function buildMessages(ctx: AgentContext): Promise<LLMMessage[]> {
  const MAX_CONTEXT_CHARS = await getContextLimit();
  // History may consume at most 30% of the total budget
  const MAX_HISTORY_CHARS = Math.floor(MAX_CONTEXT_CHARS * 0.30);

  const messages: LLMMessage[] = [];

  // Identity + skill merged into one system message.
  messages.push({
    role: 'system',
    content: `${LAILA_IDENTITY}\n\n---\n\n${ctx.skill}`,
  });

  // System: available custom skills list
  if (ctx.availableSkills) {
    messages.push({
      role: 'system',
      content: `[AVAILABLE SKILLS]\nYou have access to the following custom skills. Automatically adopt their guidelines if they apply to the user's task, even if not explicitly requested:\n\n${ctx.availableSkills}`,
    });
  }

  // System: project memory (if available)
  if (ctx.projectMemory) {
    messages.push({
      role: 'system',
      content: `[PROJECT MEMORY - strictly adhere to these rules]\n\n${ctx.projectMemory}`,
    });
  }

  // System: project context (if available)
  if (ctx.projectIndex) {
    messages.push({
      role: 'system',
      content: `You are working on the following project:\n\n${formatProjectSummary(ctx.projectIndex)}`,
    });
  }

  // System: Git context (if available)
  if (ctx.gitStatus || ctx.gitDiff) {
    let gitContext = '[CURRENT GIT STATE]\n';
    if (ctx.gitStatus) {
      gitContext += `Git Status:\n${ctx.gitStatus}\n\n`;
    }
    if (ctx.gitDiff) {
      gitContext += `Unstaged Changes (Diff):\n${ctx.gitDiff}\n\n`;
    }
    messages.push({
      role: 'system',
      content: gitContext,
    });
  }

  // ── History budget check ────────────────────────────────────────────────
  // Include history messages (oldest first) only up to MAX_HISTORY_CHARS.
  // This prevents 8 long conversation turns from crowding out project context.
  let historyCharsUsed = 0;
  const historyToInject: LLMMessage[] = [];
  for (const msg of ctx.history) {
    if (msg.role === 'system') continue; // system messages already injected above
    const msgLen = msg.content.length + MESSAGE_OVERHEAD;
    if (historyCharsUsed + msgLen > MAX_HISTORY_CHARS) break;
    historyToInject.push({ role: msg.role, content: msg.content });
    historyCharsUsed += msgLen;
  }
  messages.push(...historyToInject);

  // ── User message + relevant files (budget-aware) ────────────────────────
  let userContent = ctx.userMessage;
  const filesBlock = formatRelevantFiles(ctx.relevantFiles);

  const systemChars = messages.reduce((n, m) => n + m.content.length + MESSAGE_OVERHEAD, 0);
  const budget = MAX_CONTEXT_CHARS - systemChars - ctx.userMessage.length - MESSAGE_OVERHEAD;

  if (filesBlock && budget > 500) {
    let trimmedBlock = filesBlock;
    if (filesBlock.length > budget) {
      const raw = filesBlock.slice(0, budget);
      const lastNl = raw.lastIndexOf('\n');
      trimmedBlock = (lastNl > 0 ? raw.slice(0, lastNl) : raw) + '\n[... context truncated ...]';
    }
    userContent = `${ctx.userMessage}\n${trimmedBlock}`;
  }

  messages.push({ role: 'user', content: userContent });

  return messages;
}
