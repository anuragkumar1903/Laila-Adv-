/**
 * checkpoint.ts
 *
 * In-process checkpoint store for write_file and patch_file operations.
 * Maps absPath -> original content so the user can /undo file changes.
 * Stores the last MAX_CHECKPOINTS entries (LRU eviction on the oldest).
 */

import { writeFile, readFile } from 'fs/promises';
import { pathExists } from '../utils/fs-utils.js';

const MAX_CHECKPOINTS = 20;

/** key: absPath, value: original content before the last write */
const store = new Map<string, string>();
/** Insertion-order tracking for LRU eviction */
const order: string[] = [];

/**
 * Save a checkpoint for absPath before overwriting it.
 * If a checkpoint for this path already exists it is refreshed (moved to end).
 * Evicts the oldest entry when the store exceeds MAX_CHECKPOINTS.
 */
export function saveCheckpoint(absPath: string, content: string): void {
  // Remove stale position in order array if already tracked
  const existing = order.indexOf(absPath);
  if (existing !== -1) order.splice(existing, 1);

  // LRU eviction — drop oldest entry when full
  if (store.size >= MAX_CHECKPOINTS && !store.has(absPath)) {
    const oldest = order.shift();
    if (oldest) store.delete(oldest);
  }

  store.set(absPath, content);
  order.push(absPath);
}

/**
 * Retrieve the saved original content for absPath, or null if none exists.
 */
export function getCheckpoint(absPath: string): string | null {
  return store.get(absPath) ?? null;
}

/**
 * Returns the list of absolute paths that have a saved checkpoint,
 * ordered from oldest to newest.
 */
export function listCheckpoints(): string[] {
  return [...order];
}

/**
 * Write the original content back to disk for absPath.
 * Returns true on success, false if no checkpoint exists or write fails.
 */
export async function restoreCheckpoint(absPath: string): Promise<boolean> {
  const content = store.get(absPath);
  if (content === undefined) return false;
  try {
    await writeFile(absPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear all saved checkpoints.
 */
export function clearCheckpoints(): void {
  store.clear();
  order.length = 0;
}
