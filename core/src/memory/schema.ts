import { getDb } from './db.js';

export function initSchema(): void {
  const db = getDb();

  db.exec(`
    -- ── Projects ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      path         TEXT    NOT NULL UNIQUE,
      git_remote   TEXT,
      framework    TEXT,
      languages    TEXT    NOT NULL DEFAULT '[]',
      pkg_manager  TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_scanned INTEGER
    );

    -- ── File index (never load the full repo into LLM) ────────────────────
    CREATE TABLE IF NOT EXISTS project_files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      rel_path     TEXT    NOT NULL,
      category     TEXT    NOT NULL DEFAULT 'other',
      language     TEXT,
      size_bytes   INTEGER,
      summary      TEXT,
      last_indexed INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(project_id, rel_path)
    );

    -- ── FTS5 Semantic Search Index (Phase 5) ──────────────────────────────
    CREATE VIRTUAL TABLE IF NOT EXISTS project_files_fts USING fts5(
      project_id UNINDEXED, 
      rel_path, 
      category, 
      content,
      tokenize='unicode61 remove_diacritics 2'
    );


    -- ── Sessions ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at    INTEGER
    );

    -- ── Tasks ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      intent       TEXT    NOT NULL DEFAULT 'general',
      agent        TEXT    NOT NULL DEFAULT 'general',
      status       TEXT    NOT NULL DEFAULT 'pending',
      input        TEXT    NOT NULL,
      output       TEXT,
      validation   TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );

    -- ── Messages ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Command log (audit trail for all shell executions) ───────────────
    CREATE TABLE IF NOT EXISTS command_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      session_id   INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
      command      TEXT    NOT NULL,
      approved     INTEGER NOT NULL DEFAULT 0,  -- 0 = denied, 1 = approved
      exit_code    INTEGER,
      stdout       TEXT,
      stderr       TEXT,
      duration_ms  INTEGER,
      executed_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ── Indexes ───────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_files_category ON project_files(category);
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_command_log_session ON command_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_command_log_task ON command_log(task_id);
  `);
}
