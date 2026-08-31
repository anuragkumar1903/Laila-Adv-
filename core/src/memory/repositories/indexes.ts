import { getDb } from '../db.js';
import type { ProjectFile, FileCategory } from '../../types.js';

// ── Write ──────────────────────────────────────────────────────────────────

export function bulkUpsertFiles(
  projectId: number,
  files: Array<{
    relPath: string;
    category: FileCategory;
    language: string | null;
    sizeBytes: number;
    content?: string;
  }>,
): void {
  const db = getDb();
  
  // 1. Find and delete files that no longer exist on disk
  const existingPaths = db.prepare('SELECT rel_path FROM project_files WHERE project_id = ?').all(projectId) as { rel_path: string }[];
  const newPaths = new Set(files.map(f => f.relPath));
  
  const toDelete = existingPaths.map(r => r.rel_path).filter(p => !newPaths.has(p));
  
  const delStmt = db.prepare('DELETE FROM project_files WHERE project_id = ? AND rel_path = ?');
  const ftsDelStmt = db.prepare('DELETE FROM project_files_fts WHERE project_id = ? AND rel_path = ?');

  // 2. Prepare upsert statements
  const stmt = db.prepare(`
    INSERT INTO project_files (project_id, rel_path, category, language, size_bytes)
    VALUES (@project_id, @rel_path, @category, @language, @size_bytes)
    ON CONFLICT(project_id, rel_path) DO UPDATE SET
      category=excluded.category,
      language=excluded.language,
      size_bytes=excluded.size_bytes,
      last_indexed=unixepoch()
  `);

  const ftsStmt = db.prepare(`
    INSERT INTO project_files_fts (project_id, rel_path, category, content)
    VALUES (@project_id, @rel_path, @category, @content)
  `);

  const run = db.transaction(() => {
    // Clean up deleted files
    for (const relPath of toDelete) {
      delStmt.run(projectId, relPath);
      ftsDelStmt.run(projectId, relPath);
    }

    // Upsert existing files
    for (const f of files) {
      stmt.run({
        project_id: projectId,
        rel_path: f.relPath,
        category: f.category,
        language: f.language,
        size_bytes: f.sizeBytes,
      });

      // Only update FTS5 if we actually read the content (file changed or is new)
      if (f.content) {
        ftsDelStmt.run(projectId, f.relPath); // FTS5 doesn't support ON CONFLICT DO UPDATE cleanly with UNINDEXED columns
        ftsStmt.run({
          project_id: projectId,
          rel_path: f.relPath,
          category: f.category,
          content: f.content,
        });
      }
    }
  });
  run();
}

export function clearProject(projectId: number): void {
  getDb().prepare('DELETE FROM project_files WHERE project_id=?').run(projectId);
}

// ── Read ───────────────────────────────────────────────────────────────────

export function findByProject(projectId: number): ProjectFile[] {
  return getDb().prepare(
    'SELECT * FROM project_files WHERE project_id=? ORDER BY rel_path ASC'
  ).all(projectId) as ProjectFile[];
}

export function findByCategory(projectId: number, category: FileCategory): ProjectFile[] {
  return getDb().prepare(
    'SELECT * FROM project_files WHERE project_id=? AND category=? ORDER BY rel_path ASC'
  ).all(projectId, category) as ProjectFile[];
}

// ── Search ─────────────────────────────────────────────────────────────────

const CATEGORY_PRIORITY: FileCategory[] = [
  'controller', 'service', 'route', 'model', 'schema', 'middleware', 'util', 'config',
];

/**
 * Score project files by keyword relevance.
 * Higher score = more relevant to the query.
 */
export function searchFiles(projectId: number, keywords: string[]): ProjectFile[] {
  const all = findByProject(projectId);
  if (keywords.length === 0) return all;

  const scored = all.map(f => {
    let score = 0;
    const pl = f.rel_path.toLowerCase();
    const base = pl.split(/[/\\]/).pop()?.split('.')[0] || '';
    for (const kw of keywords) {
      const kwl = kw.toLowerCase();
      if (pl.includes(kwl)) score += 3;
      if (f.category === kwl) score += 2;
      if ((f.language ?? '').toLowerCase() === kwl) score += 1;
      
      // Symbol awareness (requires index to be passed or attached in a larger system)
      // Since ProjectFile is DB-driven, we can't easily access symbols here without joining.
      // But we can boost by filename exactly matching the keyword!
      if (base === kwl) score += 5;
    }
    // Boost important categories
    const catIdx = CATEGORY_PRIORITY.indexOf(f.category);
    if (catIdx !== -1) score += (CATEGORY_PRIORITY.length - catIdx) * 0.5;
    return { f, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.f);
}
