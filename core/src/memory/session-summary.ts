/**
 * session-summary.ts
 *
 * Generates a persistent LAILA.md memory entry at the end of each session.
 * Called from the REPL close handler so the model's work is never lost.
 *
 * Writes to:
 *   - <projectPath>/LAILA.md   when a project is active
 *   - ~/.laila/global-memory.md  when running in global mode (no project)
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getDb } from './db.js';
import { chat } from '../llm/provider-factory.js';
import type { Message } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface TaskRow {
  id: number;
  input: string;
  output: string | null;
  agent: string;
  status: string;
  created_at: number;
}

interface MessageRow {
  task_id: number;
  role: string;
  content: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract file paths that were written or patched during the session by
 * scanning assistant messages for common tool-call patterns emitted by the
 * native tool loop (write_file / patch_file JSON calls) and legacy markdown
 * fences (```typescript filename=... etc).
 */
function extractChangedFiles(messages: MessageRow[]): string[] {
  const files = new Set<string>();

  // Patterns covering both native JSON tool calls and legacy markdown fences
  const patterns: RegExp[] = [
    // Native JSON tool: "file": "path/to/file.ts"
    /"file"\s*:\s*"([^"]+)"/g,
    // Native JSON tool: "files": ["path/to/file.ts", ...]
    /"files"\s*:\s*\[([^\]]+)\]/g,
    // Legacy markdown fence: ```typescript filename=path/to/file.ts
    /```\w+\s+filename=([^\s\n]+)/g,
    // Legacy markdown fence: // FILE: path/to/file.ts
    /\/\/\s*FILE:\s*([^\s\n]+)/g,
    // Patch header: --- a/path/to/file.ts
    /^---\s+a\/(.+)$/gm,
    // write_file / patch_file tool display line: ⚙ write_file(path/to/file.ts)
    /⚙\s+(?:write_file|patch_file)\(([^)]+)\)/g,
  ];

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(msg.content)) !== null) {
        const raw = m[1]!;
        // Handle the array pattern: extract individual quoted strings
        if (raw.includes('"')) {
          const inner = raw.match(/"([^"]+)"/g) ?? [];
          inner.forEach(s => files.add(s.replace(/"/g, '')));
        } else {
          files.add(raw.trim());
        }
      }
    }
  }

  return [...files].sort();
}

/**
 * Format a Unix epoch timestamp as "YYYY-MM-DD HH:MM" in local time.
 */
function formatDateTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generate a session summary and append it to LAILA.md (or global-memory.md).
 *
 * Steps:
 * 1. Query all tasks + messages for the session from SQLite.
 * 2. Extract metadata: task count, user messages, changed files.
 * 3. Ask the LLM to write a concise structured summary.
 * 4. Append the result under a `## Session YYYY-MM-DD HH:MM` heading.
 *
 * Never throws — all errors are swallowed so the exit path is never blocked.
 */
export async function generateSessionSummary(params: {
  sessionId: number;
  projectPath: string;
  projectId: number | null;
}): Promise<void> {
  const { sessionId, projectPath, projectId } = params;

  const db = getDb();

  // ── 1. Fetch tasks ───────────────────────────────────────────────────────
  const tasks = db
    .prepare('SELECT id, input, output, agent, status, created_at FROM tasks WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as TaskRow[];

  if (tasks.length === 0) return; // Nothing happened this session

  // ── 2. Fetch messages for all tasks ────────────────────────────────────
  const taskIds = tasks.map(t => t.id);
  const placeholders = taskIds.map(() => '?').join(', ');
  const allMessages = db
    .prepare(`SELECT task_id, role, content FROM messages WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...taskIds) as MessageRow[];

  // ── 3. Collect metadata ──────────────────────────────────────────────────
  const userMessages = allMessages
    .filter(m => m.role === 'user')
    .map(m => m.content.slice(0, 200)); // truncate for the prompt

  const changedFiles = extractChangedFiles(allMessages);
  const taskCount = tasks.length;
  const sessionStart = tasks[0]!.created_at;
  const heading = `## Session ${formatDateTime(sessionStart)}`;

  // ── 4. Build LLM prompt ──────────────────────────────────────────────────
  const summaryPrompt = `You are writing a persistent memory entry for an AI coding assistant named Laila.
Summarise the following session concisely. Focus on:
- What was built or changed (list file names if available)
- Key patterns or architectural decisions observed
- Any user preferences expressed (e.g. "prefers functional style", "uses tabs")
- Anything Laila should remember for future sessions

Format the response as plain markdown suitable for appending to a LAILA.md memory file.
Keep the total response under 400 words. Do NOT include a heading — it will be added automatically.

--- SESSION DATA ---
Task count: ${taskCount}
Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none detected'}

User messages (truncated):
${userMessages.slice(0, 10).map((m, i) => `${i + 1}. ${m}`).join('\n')}

Task summaries:
${tasks.slice(0, 10).map(t => `- [${t.agent}] ${t.input.slice(0, 120)} → status: ${t.status}`).join('\n')}
`;

  let summaryContent: string;
  try {
    const result = await chat(
      [
        { role: 'system', content: 'You write concise, factual memory entries for a coding assistant. No markdown headings. No fluff.' },
        { role: 'user', content: summaryPrompt },
      ],
      { temperature: 0.3 },
    );
    summaryContent = result.content.trim();
  } catch {
    // LLM unavailable — write a minimal fallback entry so we still record something
    summaryContent = [
      `Tasks completed: ${taskCount}`,
      changedFiles.length > 0 ? `Files changed: ${changedFiles.join(', ')}` : '',
      `User requests: ${userMessages.slice(0, 3).join(' | ')}`,
    ].filter(Boolean).join('\n');
  }

  // ── 5. Determine output path ─────────────────────────────────────────────
  let outputPath: string;
  if (projectPath) {
    outputPath = path.join(projectPath, 'LAILA.md');
  } else {
    const globalDir = path.join(os.homedir(), '.laila');
    await fs.mkdir(globalDir, { recursive: true });
    outputPath = path.join(globalDir, 'global-memory.md');
  }

  // ── 6. Append to file ────────────────────────────────────────────────────
  const entry = `\n${heading}\n\n${summaryContent}\n`;

  try {
    await fs.appendFile(outputPath, entry, 'utf8');
  } catch (writeErr) {
    // If the file's parent directory doesn't exist yet, create it and retry
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.appendFile(outputPath, entry, 'utf8');
  }
}
