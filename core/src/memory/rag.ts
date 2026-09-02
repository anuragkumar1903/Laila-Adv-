import { getDb } from './db.js';
import { OllamaProvider } from '../llm/providers/ollama.js';

// ponytail: minimal RAG table. No chunk overlap or hybrid search until needed.
export function initRagTable(): void {
  const db = getDb();
  // Create virtual table for sqlite-vec if it doesn't exist
  // sqlite-vec requires vss0 or vec0 syntax. v0.1.9 uses `vec0`
  db.exec(`
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
}

// ponytail: naive chunking by double newline
export async function indexFileContent(projectId: string, filePath: string, content: string): Promise<void> {
  const db = getDb();
  const ollama = new OllamaProvider();
  
  // Nomic embed text uses 768 dimensions usually. 
  // Let's chunk by paragraphs
  const chunks = content.split(/\n\s*\n/).filter(c => c.trim().length > 10);
  
  const insertVec = db.prepare('INSERT INTO document_chunks(rowid, embedding) VALUES (?, ?)');
  const insertMeta = db.prepare('INSERT INTO chunk_metadata(rowid, project_id, file_path, content) VALUES (?, ?, ?, ?)');
  
  // Delete old file chunks
  db.prepare('DELETE FROM document_chunks WHERE rowid IN (SELECT rowid FROM chunk_metadata WHERE file_path = ? AND project_id = ?)').run(filePath, projectId);
  db.prepare('DELETE FROM chunk_metadata WHERE file_path = ? AND project_id = ?').run(filePath, projectId);
  
  for (const chunk of chunks) {
    try {
      const vector = await ollama.embed(chunk);
      // sqlite-vec expects Float32Array
      const vecBuffer = new Float32Array(vector);
      
      db.transaction(() => {
        const info = insertMeta.run(null, projectId, filePath, chunk);
        insertVec.run(info.lastInsertRowid, vecBuffer);
      })();
    } catch (e) {
      console.error(`Failed to embed chunk in ${filePath}:`, e);
    }
  }
}

export async function retrieveContext(projectId: string, query: string, limit = 5): Promise<{ filePath: string, content: string }[]> {
  const db = getDb();
  const ollama = new OllamaProvider();
  
  const queryVector = await ollama.embed(query);
  const vecBuffer = new Float32Array(queryVector);
  
  // cosine distance is default when querying knn
  const stmt = db.prepare(`
    SELECT m.file_path, m.content
    FROM document_chunks v
    JOIN chunk_metadata m ON v.rowid = m.rowid
    WHERE m.project_id = ? 
      AND v.embedding MATCH ?
      AND k = ?
  `);
  
  return stmt.all(projectId, vecBuffer, limit) as { filePath: string, content: string }[];
}
