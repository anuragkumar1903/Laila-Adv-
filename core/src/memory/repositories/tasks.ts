import { getDb } from '../db.js';
import type { Task, Message, TaskStatus, ValidationReport } from '../../types.js';

// ── Tasks ─────────────────────────────────────────────────────────────────

export function createTask(data: {
  sessionId: number;
  projectId: number | null;
  intent: Task['intent'];
  agent: Task['agent'];
  input: string;
}): Task {
  const stmt = getDb().prepare(`
    INSERT INTO tasks (session_id, project_id, intent, agent, input, status)
    VALUES (@session_id, @project_id, @intent, @agent, @input, 'running')
    RETURNING *
  `);
  return stmt.get({
    session_id: data.sessionId,
    project_id: data.projectId,
    intent: data.intent,
    agent: data.agent,
    input: data.input,
  }) as Task;
}

export function completeTask(
  id: number,
  output: string,
  status: TaskStatus = 'done',
  validation?: ValidationReport,
): void {
  getDb().prepare(`
    UPDATE tasks SET output=?, status=?, validation=?, completed_at=unixepoch()
    WHERE id=?
  `).run(
    output,
    status,
    validation ? JSON.stringify(validation) : null,
    id,
  );
}

export function findBySession(sessionId: number, limit = 20): Task[] {
  return getDb().prepare(
    'SELECT * FROM tasks WHERE session_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionId, limit) as Task[];
}

export function findRecent(limit = 15): Task[] {
  return getDb().prepare(
    'SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as Task[];
}

// ── Messages ──────────────────────────────────────────────────────────────

/** Maximum number of characters stored in a single message row.
 *  Prevents a runaway LLM response or enormous shell stdout from filling
 *  the database. Content exceeding this limit is truncated with a notice. */
const MAX_MESSAGE_CHARS = 100_000; // ~25k tokens — generous but bounded

export function addMessage(taskId: number, role: Message['role'], content: string): Message {
  const safe = content.length > MAX_MESSAGE_CHARS
    ? content.slice(0, MAX_MESSAGE_CHARS) + '\n\n[... message truncated — exceeded 100 000 char storage limit ...]'
    : content;

  return getDb().prepare(
    'INSERT INTO messages (task_id, role, content) VALUES (?, ?, ?) RETURNING *'
  ).get(taskId, role, safe) as Message;
}

export function getMessages(taskId: number, limit?: number): Message[] {
  const sql = limit
    ? 'SELECT * FROM messages WHERE task_id=? ORDER BY created_at ASC LIMIT ?'
    : 'SELECT * FROM messages WHERE task_id=? ORDER BY created_at ASC';
  const args = limit ? [taskId, limit] : [taskId];
  return getDb().prepare(sql).all(...args) as Message[];
}
