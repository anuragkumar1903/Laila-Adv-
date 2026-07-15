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

export function addMessage(taskId: number, role: Message['role'], content: string): Message {
  return getDb().prepare(
    'INSERT INTO messages (task_id, role, content) VALUES (?, ?, ?) RETURNING *'
  ).get(taskId, role, content) as Message;
}

export function getMessages(taskId: number): Message[] {
  return getDb().prepare(
    'SELECT * FROM messages WHERE task_id=? ORDER BY created_at ASC'
  ).all(taskId) as Message[];
}
