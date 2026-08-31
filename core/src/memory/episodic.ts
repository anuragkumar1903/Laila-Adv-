import { readFile, appendFile } from 'fs/promises';
import { ensureDir } from '../utils/fs-utils.js';
import path from 'path';
import os from 'os';

function getGlobalMemoryPath() {
  return path.join(os.homedir(), '.laila', 'episodic_memory.md');
}

export async function readGlobalMemory(): Promise<string> {
  try {
    const content = await readFile(getGlobalMemoryPath(), 'utf8');
    return content;
  } catch {
    return '';
  }
}

export async function rememberFact(fact: string): Promise<void> {
  const memPath = getGlobalMemoryPath();
  await ensureDir(path.dirname(memPath));
  const date = new Date().toISOString().split('T')[0];
  await appendFile(memPath, `- [${date}]: ${fact}\n`, 'utf8');
}
