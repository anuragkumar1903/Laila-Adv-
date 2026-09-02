import Database, { type Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';
import { DB_PATH } from '../config.js';

let _db: DB | null = null;

export function getDb(): DB {
  if (_db) return _db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  
  sqliteVec.load(_db);
  
  _db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING vec0(
      embedding float[768]
    );
    CREATE TABLE IF NOT EXISTS chunk_metadata (
      rowid INTEGER PRIMARY KEY,
      project_id TEXT,
      file_path TEXT,
      content TEXT
    );
  `);
  // WAL mode for concurrent reads + atomic writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');

  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
