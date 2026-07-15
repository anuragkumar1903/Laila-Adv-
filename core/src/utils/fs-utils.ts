import { readFile, writeFile, mkdir, access, stat } from 'fs/promises';
import path from 'path';

/**
 * Check whether a filesystem path exists (file or directory).
 * Never throws — returns `false` on any error.
 */
export async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Recursively create a directory (equivalent to `mkdir -p`).
 * No-ops silently if the directory already exists.
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Read a text file and return up to `maxLines` lines.
 *
 * @param filePath - Absolute path to the file
 * @param maxLines - Maximum number of lines to return
 * @returns `{ lines, truncated }` where `truncated` is `true` when the file
 *          was cut short to stay within the line limit
 * @throws If the file cannot be read
 */
export async function readFileLines(
  filePath: string,
  maxLines: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lines.length <= maxLines) return { lines, truncated: false };
  return { lines: lines.slice(0, maxLines), truncated: true };
}

/**
 * Read a text file silently.
 *
 * @param filePath - Absolute path to the file
 * @returns File contents as a string, or `null` if the file does not exist
 *          or cannot be read for any reason
 */
export async function readFileSafe(filePath: string): Promise<string | null> {
  try { return await readFile(filePath, 'utf-8'); } catch { return null; }
}

/**
 * Read and JSON-parse a file silently.
 *
 * @template T - Expected shape of the parsed object
 * @param filePath - Absolute path to the JSON file
 * @returns Parsed object, or `null` on any read/parse error
 */
export async function readJSON<T = unknown>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch { return null; }
}

/**
 * Serialize `data` to JSON and write it to `filePath`.
 * Creates parent directories if they do not exist.
 *
 * @param filePath - Destination path
 * @param data     - Value to serialize (uses 2-space indentation)
 */
export async function writeJSON(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Return the size in bytes of a file, or `0` if the file cannot be stat'd.
 *
 * @param filePath - Absolute path to the file
 */
export async function getFileSizeBytes(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

import type { Stats } from 'fs';

/**
 * Return the `fs.Stats` for a file, or `null` if the stat call fails.
 * Used for mtime-based incremental scanning.
 *
 * @param filePath - Absolute path to the file
 */
export async function getFileStat(filePath: string): Promise<Stats | null> {
  try { return await stat(filePath); } catch { return null; }
}

/** File extensions considered binary — excluded from text scanning and context. */
const BINARY_EXTS = new Set([
  '.png','.jpg','.jpeg','.gif','.bmp','.ico','.webp',
  '.mp4','.mp3','.wav','.ogg','.flac',
  '.pdf','.zip','.tar','.gz','.7z','.rar',
  '.exe','.dll','.so','.dylib',
  '.ttf','.otf','.woff','.woff2',
  '.pyc','.class','.wasm',
]);

/**
 * Return `true` if a file path has a known text extension.
 * Binary files are excluded from project scanning to avoid context bloat.
 *
 * @param filePath - File path or name (only the extension is checked)
 */
export function isTextFile(filePath: string): boolean {
  return !BINARY_EXTS.has(path.extname(filePath).toLowerCase());
}
