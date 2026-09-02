/**
 * git-tool.ts
 *
 * LLM-invokable git operations via ```git fence blocks.
 *
 * ── Fence format ─────────────────────────────────────────────────────────
 *
 *   ```git
 *   # Optional description
 *   action: <git action>
 *   args: <space-separated arguments>
 *   ```
 *
 * Supported actions:
 *   status, log, branch, branches, checkout, new-branch, add, unstage,
 *   stash, stash-pop, stash-list, diff, diff-staged, show, tag, tags,
 *   cherry-pick, reset-soft, blame, discard
 *
 * Safety:
 *   - Destructive ops (discard, reset-soft, cherry-pick) require user confirmation
 *   - No force push, no hard reset, no rebase — these are intentionally excluded
 *   - All operations are logged
 */

import chalk from 'chalk';
import readline from 'readline';
import {
  getGitStatus, getGitLog, getGitDiff, getGitBranch, getGitStaged,
  getGitAheadBehind, gitAdd, gitUnstage, gitCreateBranch, gitCheckout,
  gitListBranches, gitStash, gitStashPop, gitStashList, gitDiscardChanges,
  gitResetSoft, gitCherryPick, gitTag, gitListTags, gitDiffBetween,
  gitShow, gitBlame, commitChanges,
} from '../utils/git-utils.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface GitBlock {
  action: string;
  args: string[];
  reason?: string;
}

export interface GitResult {
  action: string;
  success: boolean;
  output: string;
}

// ─── Parser ───────────────────────────────────────────────────────────────

export function parseGitBlocks(response: string): GitBlock[] {
  const blocks: GitBlock[] = [];
  const regex = /```git\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const lines = (match[1] || '').split('\n');
    let action = '';
    let args: string[] = [];
    let reason: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
        reason = trimmed.replace(/^[#/]+\s*/, '');
        continue;
      }

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) {
        // Bare line — treat as shorthand action
        if (!action) {
          const parts = trimmed.split(/\s+/);
          action = parts[0] ?? '';
          args = parts.slice(1);
        }
        continue;
      }

      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const val = trimmed.slice(colonIdx + 1).trim();

      if (key === 'action' || key === 'op') action = val;
      if (key === 'args' || key === 'arguments') args = val.split(/\s+/).filter(Boolean);
      if (key === 'message' || key === 'msg') args = [val]; // For commit/tag messages
    }

    if (action) {
      blocks.push({ action: action.toLowerCase(), args, reason });
    }
  }

  return blocks;
}

// ─── Destructive actions that need user confirmation ──────────────────────

const DESTRUCTIVE_ACTIONS = new Set([
  'discard', 'reset-soft', 'cherry-pick', 'checkout', 'new-branch',
]);

async function confirmAction(action: string, detail: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const { askYesNo } = await import('../utils/prompt-utils.js');
  const result = await askYesNo(rl, chalk.yellow(`  ⚠ git ${action}: ${detail}\n`) + chalk.green('  Allow?'));
  rl.close();
  return result;
}

// ─── Executor ─────────────────────────────────────────────────────────────

export async function executeGitBlock(
  block: GitBlock,
  projectRoot: string,
): Promise<GitResult> {
  const { action, args } = block;

  if (block.reason) {
    console.log(chalk.dim(`  🔀 git: ${block.reason}`));
  }

  // Gate destructive actions
  if (DESTRUCTIVE_ACTIONS.has(action)) {
    const approved = await confirmAction(action, args.join(' ') || '(no args)');
    if (!approved) {
      console.log(chalk.red('  ✗ Blocked by user.'));
      return { action, success: false, output: 'Blocked by user.' };
    }
  }

  try {
    switch (action) {
      // ── Read-only ops ─────────────────────────────────────────────
      case 'status': {
        const out = await getGitStatus(projectRoot);
        return { action, success: true, output: out ?? 'Clean working tree.' };
      }
      case 'log': {
        const limit = parseInt(args[0] ?? '10', 10);
        const commits = await getGitLog(projectRoot, limit);
        const out = commits.map(c => `${c.hash} ${c.message}`).join('\n') || 'No commits.';
        return { action, success: true, output: out };
      }
      case 'branch': {
        const out = await getGitBranch(projectRoot);
        return { action, success: true, output: out ?? 'Detached HEAD' };
      }
      case 'branches': {
        const branches = await gitListBranches(projectRoot);
        return { action, success: true, output: branches.join('\n') || 'No branches.' };
      }
      case 'diff': {
        const out = await getGitDiff(projectRoot, false);
        return { action, success: true, output: out ?? 'No unstaged changes.' };
      }
      case 'diff-staged': {
        const out = await getGitDiff(projectRoot, true);
        return { action, success: true, output: out ?? 'Nothing staged.' };
      }
      case 'diff-between': {
        if (args.length < 2) return { action, success: false, output: 'Need two refs: diff-between <refA> <refB>' };
        const out = await gitDiffBetween(projectRoot, args[0]!, args[1]!);
        return { action, success: true, output: out ?? 'No differences.' };
      }
      case 'staged': {
        const out = await getGitStaged(projectRoot);
        return { action, success: true, output: out ?? 'Nothing staged.' };
      }
      case 'ahead-behind': {
        const ab = await getGitAheadBehind(projectRoot);
        return { action, success: true, output: ab ? `Ahead: ${ab.ahead}, Behind: ${ab.behind}` : 'No upstream tracking branch.' };
      }
      case 'show': {
        const ref = args[0] ?? 'HEAD';
        const out = await gitShow(projectRoot, ref);
        return { action, success: true, output: out ?? 'Commit not found.' };
      }
      case 'blame': {
        if (!args[0]) return { action, success: false, output: 'Need a file path: blame <file>' };
        const out = await gitBlame(projectRoot, args[0]);
        return { action, success: true, output: out ?? 'Could not blame file.' };
      }
      case 'tags': {
        const tags = await gitListTags(projectRoot);
        return { action, success: true, output: tags.join('\n') || 'No tags.' };
      }
      case 'stash-list': {
        const stashes = await gitStashList(projectRoot);
        return { action, success: true, output: stashes.join('\n') || 'No stashes.' };
      }

      // ── Mutating ops (safe) ───────────────────────────────────────
      case 'add': {
        const paths = args.length > 0 ? args : ['.'];
        const ok = await gitAdd(projectRoot, ...paths);
        return { action, success: ok, output: ok ? `Staged: ${paths.join(', ')}` : 'Failed to stage.' };
      }
      case 'unstage': {
        const paths = args.length > 0 ? args : ['.'];
        const ok = await gitUnstage(projectRoot, ...paths);
        return { action, success: ok, output: ok ? `Unstaged: ${paths.join(', ')}` : 'Failed to unstage.' };
      }
      case 'stash': {
        const msg = args.join(' ') || undefined;
        const ok = await gitStash(projectRoot, msg);
        return { action, success: ok, output: ok ? 'Changes stashed.' : 'Failed to stash.' };
      }
      case 'stash-pop': {
        const ok = await gitStashPop(projectRoot);
        return { action, success: ok, output: ok ? 'Stash popped.' : 'Failed to pop stash (conflict or empty).' };
      }
      case 'tag': {
        if (!args[0]) return { action, success: false, output: 'Need a tag name: tag <name> [message]' };
        const msg = args.slice(1).join(' ') || undefined;
        const ok = await gitTag(projectRoot, args[0], msg);
        return { action, success: ok, output: ok ? `Tag created: ${args[0]}` : 'Failed to create tag.' };
      }
      case 'commit': {
        const msg = args.join(' ');
        if (!msg) return { action, success: false, output: 'Need a commit message.' };
        const ok = await commitChanges(projectRoot, msg);
        return { action, success: ok, output: ok ? 'Committed.' : 'Failed to commit.' };
      }

      // ── Destructive ops (user-confirmed above) ────────────────────
      case 'new-branch': {
        if (!args[0]) return { action, success: false, output: 'Need a branch name.' };
        const ok = await gitCreateBranch(projectRoot, args[0]);
        return { action, success: ok, output: ok ? `Created and switched to: ${args[0]}` : 'Failed to create branch.' };
      }
      case 'checkout': {
        if (!args[0]) return { action, success: false, output: 'Need a branch name.' };
        const ok = await gitCheckout(projectRoot, args[0]);
        return { action, success: ok, output: ok ? `Switched to: ${args[0]}` : 'Failed to checkout.' };
      }
      case 'discard': {
        if (args.length === 0) return { action, success: false, output: 'Need file paths to discard.' };
        const ok = await gitDiscardChanges(projectRoot, ...args);
        return { action, success: ok, output: ok ? `Discarded changes: ${args.join(', ')}` : 'Failed to discard.' };
      }
      case 'reset-soft': {
        const ref = args[0] ?? 'HEAD~1';
        const ok = await gitResetSoft(projectRoot, ref);
        return { action, success: ok, output: ok ? `Soft reset to: ${ref}` : 'Failed to reset.' };
      }
      case 'cherry-pick': {
        if (!args[0]) return { action, success: false, output: 'Need a commit hash.' };
        const ok = await gitCherryPick(projectRoot, args[0]);
        return { action, success: ok, output: ok ? `Cherry-picked: ${args[0]}` : 'Failed to cherry-pick (conflict?).' };
      }

      default:
        return { action, success: false, output: `Unknown git action: ${action}` };
    }
  } catch (err: any) {
    return { action, success: false, output: err.message ?? String(err) };
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────

export function formatGitResultsForContext(results: GitResult[]): string {
  if (results.length === 0) return '';
  const parts: string[] = ['=== Git Results ==='];
  for (const r of results) {
    const icon = r.success ? '✔' : '✗';
    parts.push(`\n${icon} git ${r.action}:\n${r.output}`);
  }
  return parts.join('\n');
}

// ─── Public Runner ────────────────────────────────────────────────────────

export async function runGitBlocks(
  response: string,
  projectRoot: string,
): Promise<{ gitContext: string; hasResults: boolean }> {
  const blocks = parseGitBlocks(response);
  if (blocks.length === 0) return { gitContext: '', hasResults: false };

  const results: GitResult[] = [];
  for (const block of blocks) {
    const result = await executeGitBlock(block, projectRoot);
    results.push(result);

    // Print result inline
    const icon = result.success ? chalk.green('✔') : chalk.red('✗');
    console.log(`  ${icon} git ${result.action}: ${result.output.split('\n')[0]}`);
  }

  return {
    gitContext: formatGitResultsForContext(results),
    hasResults: true,
  };
}
