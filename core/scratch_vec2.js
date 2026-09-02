import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
const db = new Database(':memory:');
sqliteVec.load(db);
db.exec(`
  CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[3]);
  INSERT INTO vec_items(rowid, embedding) VALUES (1, '[0.1, 0.2, 0.3]');
  INSERT INTO vec_items(rowid, embedding) VALUES (2, '[0.9, 0.1, 0.1]');
`);
const queryVec = new Float32Array([0.1, 0.2, 0.3]);
const result = db.prepare('SELECT rowid FROM vec_items WHERE embedding MATCH ? AND k = 1').all(queryVec);
console.log(result);
