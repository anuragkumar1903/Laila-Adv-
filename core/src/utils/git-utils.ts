import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { pathExists } from './fs-utils.js';

const execAsync = promisify(exec);

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git ${args.join(' ')}`, { cwd, timeout: 5_000 });
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

export async function getGitDiff(dir: string, staged = false): Promise<string | null> {
  const args = ['diff'];
  if (staged) args.push('--cached');
  return git(dir, ...args);
}

export async function commitChanges(dir: string, message: string): Promise<boolean> {
  // Using execAsync directly to safely escape the message
  try {
    const safeMessage = message.replace(/"/g, '\\"');
    await execAsync(`git commit -m "${safeMessage}"`, { cwd: dir, timeout: 10_000 });
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
