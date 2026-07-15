import path from 'path';
import { searchFiles, findByProject } from './repositories/indexes.js';
import { readFileLines } from '../utils/fs-utils.js';
import { MAX_FILE_LINES, MAX_RELEVANT_FILES } from '../config.js';
import type { RelevantFile } from '../types.js';

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','be','been','do','does','did',
  'have','has','had','will','would','can','could','should','may',
  'what','how','why','where','when','which','who','this','that',
  'it','its','in','on','at','to','for','of','from','by','with',
  'and','or','but','not','so','if','then','i','me','my','you',
  'please','help','want','need','make','add','create','write',
  'show','find','get','update','change','fix','implement',
]);

/**
 * Tokenise a natural-language query into meaningful keywords.
 *
 * Splits on whitespace and common punctuation, discards tokens shorter
 * than 3 characters, and filters out stop words so only semantically
 * significant terms remain.
 *
 * @param query - Raw user input string
 * @returns Array of lowercase keyword tokens
 */
function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,.\-_/\\()[\]{}:;"'!?=<>+*&|^~@#%]+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Return the most relevant file contents for a user query.
 *
 * Scores project files by matching extracted query keywords against the
 * indexed file metadata. Falls back to the most recently indexed files
 * when no keywords can be extracted.
 *
 * Files are read and truncated to {@link MAX_FILE_LINES} lines each.
 * Files deleted since the last scan are silently skipped.
 *
 * @param projectId   - Database ID of the active project
 * @param projectPath - Absolute filesystem path to the project root
 * @param query       - User's raw input message used for keyword extraction
 * @param maxFiles    - Maximum number of files to return (default: {@link MAX_RELEVANT_FILES})
 * @returns Array of file records with content, category, and truncation flag
 */
export async function getRelevantFiles(
  projectId: number,
  projectPath: string,
  query: string,
  maxFiles = MAX_RELEVANT_FILES,
): Promise<RelevantFile[]> {
  const keywords = extractKeywords(query);

  const candidates = keywords.length > 0
    ? searchFiles(projectId, keywords).slice(0, maxFiles)
    : findByProject(projectId).slice(0, maxFiles);

  const results: RelevantFile[] = [];

  for (const candidate of candidates) {
    const filePath = path.join(projectPath, candidate.rel_path);
    try {
      const { lines, truncated } = await readFileLines(filePath, MAX_FILE_LINES);
      results.push({
        relPath: candidate.rel_path,
        content: lines.join('\n'),
        category: candidate.category,
        truncated,
      });
    } catch {
      // File deleted since last scan — silently skip
    }
  }

  return results;
}
