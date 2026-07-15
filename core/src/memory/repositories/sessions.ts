import { getDb } from '../db.js';
import type { Session } from '../../types.js';

/**
 * Create a new session record and return it.
 *
 * @param projectId - Associated project ID, or `null` for global-mode sessions
 * @returns The newly created {@link Session}
 */
export function createSession(projectId: number | null): Session {
  const stmt = getDb().prepare(
    'INSERT INTO sessions (project_id) VALUES (?) RETURNING *'
  );
  return stmt.get(projectId) as Session;
}

/** Return the most recently created session regardless of status. */
export function findLatestSession(): Session | null {
  return (getDb().prepare(
    'SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1'
  ).get() as Session | undefined) ?? null;
}

/**
 * Return the most recent session that has not yet been ended.
 * Used at startup to offer session resume.
 */
export function findLatestActiveSession(): Session | null {
  return (getDb().prepare(
    'SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
  ).get() as Session | undefined) ?? null;
}

/**
 * Mark a session as ended by setting `ended_at` to the current Unix epoch.
 *
 * @param id - Session primary key
 */
export function endSession(id: number): void {
  getDb().prepare('UPDATE sessions SET ended_at=unixepoch() WHERE id=?').run(id);
}
