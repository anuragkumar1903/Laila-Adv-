import { readFile, appendFile } from 'fs/promises';
import { ensureDir } from '../utils/fs-utils.js';
import path from 'path';
import os from 'os';

function getGlobalMemoryPath() {
  return path.join(os.homedir(), '.laila', 'episodic_memory.md');
}

// FIX (Medium #24): Add a TTL to the in-process cache so that if the user
// edits ~/.laila/episodic_memory.md externally (or another Laila instance
// writes to it), stale data is not served for the entire process lifetime.
// 60 seconds is short enough to be responsive without hammering the disk.
const CACHE_TTL_MS = 60_000;
let _memCache: string | null = null;
let _memCacheTs = 0;

export async function readGlobalMemory(): Promise<string> {
  const now = Date.now();
  if (_memCache !== null && (now - _memCacheTs) < CACHE_TTL_MS) {
    return _memCache;
  }
  try {
    const content = await readFile(getGlobalMemoryPath(), 'utf8');
    _memCache   = content;
    _memCacheTs = now;
    return content;
  } catch {
    // File doesn't exist yet — cache the empty result with a timestamp so
    // we don't attempt a read on every single prompt.
    _memCache   = '';
    _memCacheTs = now;
    return '';
  }
}

export async function rememberFact(fact: string): Promise<void> {
  const memPath = getGlobalMemoryPath();
  await ensureDir(path.dirname(memPath));
  const date = new Date().toISOString().split('T')[0];
  await appendFile(memPath, `- [${date}]: ${fact}\n`, 'utf8');
  _memCache = null; // Invalidate cache immediately after write
  _memCacheTs = 0;
}
