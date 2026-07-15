import { getDb } from '../db.js';
import type { Project } from '../../types.js';

type NewProject = Omit<Project, 'id' | 'created_at' | 'last_scanned'>;

/**
 * Insert a new project or update all mutable fields if the path already exists.
 *
 * @param data - Project fields excluding auto-generated `id`, `created_at`, and `last_scanned`
 * @returns The persisted {@link Project} record (fresh read-after-write)
 */
export function upsertProject(data: NewProject): Project {
  const db = getDb();
  const existing = findByPath(data.path);
  if (existing) {
    db.prepare(`
      UPDATE projects
      SET name=@name, git_remote=@git_remote, framework=@framework,
          languages=@languages, pkg_manager=@pkg_manager
      WHERE path=@path
    `).run(data);
    return findByPath(data.path) as Project;
  }
  const stmt = db.prepare(`
    INSERT INTO projects (name, path, git_remote, framework, languages, pkg_manager)
    VALUES (@name, @path, @git_remote, @framework, @languages, @pkg_manager)
    RETURNING *
  `);
  return stmt.get(data) as Project;
}

/** Find a project by its absolute filesystem path. Returns `null` if not found. */
export function findByPath(p: string): Project | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM projects WHERE path=?').get(p) as Project | undefined) ?? null;
}

/** Find a project by its numeric primary key. Returns `null` if not found. */
export function findById(id: number): Project | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Project | undefined) ?? null;
}

/** Return all projects ordered by most recently scanned, then by creation date. */
export function findAll(): Project[] {
  return getDb().prepare(
    'SELECT * FROM projects ORDER BY last_scanned DESC NULLS LAST, created_at DESC'
  ).all() as Project[];
}

/** Set `last_scanned` to the current Unix epoch for the given project ID. */
export function updateLastScanned(id: number): void {
  getDb().prepare('UPDATE projects SET last_scanned=unixepoch() WHERE id=?').run(id);
}

/**
 * Permanently delete a project and all its associated records
 * (cascades to `project_files`, `sessions`, and `tasks`).
 *
 * @param id - Project primary key
 */
export function deleteProject(id: number): void {
  getDb().prepare('DELETE FROM projects WHERE id=?').run(id);
}
