import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
const db = new Database(':memory:');
sqliteVec.load(db);
const result = db.prepare('select vec_version() as v').get();
console.log('Version:', result.v);
