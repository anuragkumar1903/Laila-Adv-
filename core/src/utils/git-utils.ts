import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { pathExists } from './fs-utils.js';

// FIX (HIGH): Use execFile (not exec) so args are never shell-interpolated.
// promisify(execFile) passes each element in the args array directly to the
// OS without going through a shell, eliminating shell-injection risk.
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 5_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  if (await pathExists(path.join(dir, '.git'))) return true;
  return (await git(dir, 'rev-parse', '--git-dir')) !== null;
}

export async function getGitRemote(dir: string): Promise<string | null> {
  return git(dir, 'remote', 'get-url', 'origin');
}

export async function getGitBranch(dir: string): Promise<string | null> {
  return git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
}

export async function getGitRoot(dir: string): Promise<string | null> {
  return git(dir, 'rev-parse', '--show-toplevel');
}

export async function getGitStatus(dir: string): Promise<string | null> {
  return git(dir, 'status', '--short');
}

// FIX (MEDIUM): Cap diff output at 8 KB to prevent unbounded memory use.
const DIFF_SIZE_CAP = 8 * 1024; // 8 KB

export async function getGitDiff(dir: string, staged = false): Promise<string | null> {
  const args = ['diff'];
  if (staged) args.push('--cached');
  const result = await git(dir, ...args);
  if (result === null) return null;
  return result.length > DIFF_SIZE_CAP ? result.slice(0, DIFF_SIZE_CAP) : result;
}

// FIX (CRITICAL): Pass commit message as a discrete argument via execFile so it
// is never interpreted by the shell. Manual quote-escaping is not needed and the
// previous `replace(/"/g, '\\"')` workaround is removed entirely.
export async function commitChanges(dir: string, message: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['commit', '-m', message], { cwd: dir, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Get recent commits — returns array of { hash, message } */
export async function getGitLog(dir: string, limit = 5): Promise<Array<{ hash: string; message: string }>> {
  const raw = await git(dir, 'log', `--oneline`, `-${limit}`);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => ({
    hash:    line.slice(0, 7),
    message: line.slice(8),
  }));
}

/** Get staged files list */
export async function getGitStaged(dir: string): Promise<string | null> {
  return git(dir, 'diff', '--cached', '--name-status');
}

/** How many commits ahead/behind remote */
export async function getGitAheadBehind(dir: string): Promise<{ ahead: number; behind: number } | null> {
  const raw = await git(dir, 'rev-list', '--left-right', '--count', 'HEAD...@{u}');
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  return {
    ahead:  parseInt(parts[0] ?? '0', 10),
    behind: parseInt(parts[1] ?? '0', 10),
  };
}

// ─── Full Git Ops ─────────────────────────────────────────────────────────

/** Stage files — accepts specific paths or '.' for all */
export async function gitAdd(dir: string, ...paths: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', ['add', ...paths], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** Unstage files (git reset HEAD) */
export async function gitUnstage(dir: string, ...paths: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', ['reset', 'HEAD', ...paths], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** Create a new branch */
export async function gitCreateBranch(dir: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['checkout', '-b', branchName], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** Switch to an existing branch */
export async function gitCheckout(dir: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['checkout', branchName], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** List branches */
export async function gitListBranches(dir: string): Promise<string[]> {
  const raw = await git(dir, 'branch', '--list', '--no-color');
  if (!raw) return [];
  return raw.split('\n').map(b => b.replace(/^\*?\s*/, '').trim()).filter(Boolean);
}

/** Get current branch name (already exported above) */

/** Stash changes */
export async function gitStash(dir: string, message?: string): Promise<boolean> {
  try {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    await execFileAsync('git', args, { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** Pop latest stash */
export async function gitStashPop(dir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['stash', 'pop'], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** List stashes */
export async function gitStashList(dir: string): Promise<string[]> {
  const raw = await git(dir, 'stash', 'list');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean);
}

/** Discard unstaged changes to specific files */
export async function gitDiscardChanges(dir: string, ...paths: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', ['checkout', '--', ...paths], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** Soft reset (keep changes staged) */
export async function gitResetSoft(dir: string, ref = 'HEAD~1'): Promise<boolean> {
  try {
    await execFileAsync('git', ['reset', '--soft', ref], { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** Cherry-pick a commit */
export async function gitCherryPick(dir: string, commitHash: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['cherry-pick', commitHash], { cwd: dir, timeout: 15_000 });
    return true;
  } catch { return false; }
}

/** Create a tag */
export async function gitTag(dir: string, tagName: string, message?: string): Promise<boolean> {
  try {
    const args = ['tag'];
    if (message) {
      args.push('-a', tagName, '-m', message);
    } else {
      args.push(tagName);
    }
    await execFileAsync('git', args, { cwd: dir, timeout: 10_000 });
    return true;
  } catch { return false; }
}

/** List tags */
export async function gitListTags(dir: string): Promise<string[]> {
  const raw = await git(dir, 'tag', '--list');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean);
}

/** Diff between two refs (commits, branches, tags) */
export async function gitDiffBetween(dir: string, refA: string, refB: string): Promise<string | null> {
  const result = await git(dir, 'diff', refA, refB, '--stat');
  return result;
}

/** Show a single commit */
export async function gitShow(dir: string, ref = 'HEAD'): Promise<string | null> {
  const result = await git(dir, 'show', ref, '--stat', '--format=fuller');
  if (result === null) return null;
  return result.length > DIFF_SIZE_CAP ? result.slice(0, DIFF_SIZE_CAP) : result;
}

/** Get blame for a file (first 50 lines) */
export async function gitBlame(dir: string, filePath: string): Promise<string | null> {
  const result = await git(dir, 'blame', '--porcelain', '-L', '1,50', filePath);
  return result;
}

