import Database, { type Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { DB_PATH } from '../config.js';

let _db: DB | null = null;

export function getDb(): DB {
  if (_db) return _db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  // WAL mode for concurrent reads + atomic writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}
