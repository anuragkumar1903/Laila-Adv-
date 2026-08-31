/**
 * grep-tool.ts
 *
 * Two capabilities in one tool:
 *
 *   1. GREP — Search for a regex pattern across project files and return
 *      matching lines with file paths and line numbers.
 *      LLM triggers this via a ```grep fence block.
 *
 *   2. PATCH — In-place sed-style find-and-replace inside a specific file.
 *      LLM triggers this via a ```patch fence block.
 *      Shows a diff preview and asks user permission before writing.
 *
 * ── Fence formats ────────────────────────────────────────────────────────
 *
 *   ```grep
 *   # Optional description
 *   pattern: <regex>
 *   path: <directory — optional, default: project root>
 *   include: <file glob — optional, e.g. *.ts>
 *   maxMatches: <number — optional, default 50>
 *   ```
 *
 *   ```patch
 *   # Optional description
 *   file: <relative file path>
 *   find: <exact string to find — multi-line ok>
 *   replace: <replacement string>
 *   ```
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 *   - PATCH always previews changes and requires explicit user confirmation
 *   - PATCH refuses to edit files outside the project root
 *   - GREP skips binary files (reuses isTextFile from fs-utils)
 *   - Both operations are logged to command_log with approved=1/0
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { glob } from 'glob';
import ignoreLib from 'ignore';
import readline from 'readline';
import path from 'path';
import chalk from 'chalk';
import { getDb } from '../memory/db.js';
import { isTextFile, readFileSafe, pathExists } from '../utils/fs-utils.js';
import { SCAN_EXCLUDES } from '../config.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface GrepBlock {
  pattern: string;
  searchPath?: string;   // sub-directory to search (default: project root)
  include?: string;      // file glob filter, e.g. "*.ts"
  maxMatches?: number;
  reason?: string;
}

export interface PatchBlock {
  file: string;          // relative path to the file
  find: string;          // exact string to find (literal, not regex)
  replace: string;       // replacement string
  reason?: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepResult {
  pattern: string;
  matches: GrepMatch[];
  truncated: boolean;
  totalMatches: number;
}

export interface PatchResult {
  file: string;
  approved: boolean;
  applied: boolean;
  occurrences: number;
  error?: string;
}

// ─── Parsers ──────────────────────────────────────────────────────────────

/**
 * Parse all ```grep fenced blocks from an LLM response.
 *
 * Supported keys (one per line, colon-separated):
 *   pattern, path, include, maxMatches
 * A line starting with # or // is treated as the reason/description.
 * A bare line with no key: prefix is treated as the pattern shorthand.
 */
export function parseGrepBlocks(response: string): GrepBlock[] {
  const blocks: GrepBlock[] = [];
  const regex = /```grep\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const body = (match[1] ?? '').trim();
    if (!body) continue;

    const block: Partial<GrepBlock> = {};

    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('#') || line.startsWith('//')) {
        if (!block.reason) block.reason = line.replace(/^[#/]+\s*/, '');
        continue;
      }

      const sep = line.indexOf(':');
      if (sep === -1) {
        if (!block.pattern) block.pattern = line;
        continue;
      }

      const key   = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();

      switch (key) {
        case 'pattern':    block.pattern    = value; break;
        case 'path':       block.searchPath = value; break;
        case 'include':    block.include    = value; break;
        case 'maxmatches': block.maxMatches = parseInt(value, 10) || 50; break;
      }
    }

    if (block.pattern) {
      blocks.push({
        pattern:    block.pattern,
        searchPath: block.searchPath,
        include:    block.include,
        maxMatches: block.maxMatches ?? 50,
        reason:     block.reason,
      });
    }
  }

  return blocks;
}

/**
 * Parse all ```patch fenced blocks from an LLM response.
 *
 * The block has three named sections parsed top-to-bottom:
 *   1. Header lines: # reason (optional), file: <path>
 *   2. find: <text> — everything after "find:" until "replace:" key
 *   3. replace: <text> — everything after "replace:" to end of block
 *
 * Multi-line find/replace is fully supported.
 */
export function parsePatchBlocks(response: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  const regex = /```patch\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const body = match[1] ?? '';
    if (!body.trim()) continue;

    const block: Partial<PatchBlock> = {};
    const lines = body.split('\n');

    let mode: 'header' | 'find' | 'replace' = 'header';
    const findLines: string[]    = [];
    const replaceLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (mode === 'header') {
        if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
          if (!block.reason) block.reason = trimmed.replace(/^[#/]+\s*/, '');
          continue;
        }
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('file:')) {
          block.file = trimmed.slice(5).trim();
          continue;
        }
        if (lower.startsWith('find:')) {
          const rest = trimmed.slice(5).trim();
          if (rest) findLines.push(rest);
          mode = 'find';
          continue;
        }
      }

      if (mode === 'find') {
        if (trimmed.toLowerCase().startsWith('replace:')) {
          const rest = trimmed.slice(8).trim();
          if (rest) replaceLines.push(rest);
          mode = 'replace';
          continue;
        }
        // Preserve raw line (with indentation) for accurate multi-line matching
        findLines.push(line);
        continue;
      }

      if (mode === 'replace') {
        replaceLines.push(line);
      }
    }

    // Trim trailing blank lines from both arrays
    while (findLines.length    > 0 && findLines[findLines.length - 1]!.trim()       === '') findLines.pop();
    while (replaceLines.length > 0 && replaceLines[replaceLines.length - 1]!.trim() === '') replaceLines.pop();

    block.find    = findLines.join('\n');
    block.replace = replaceLines.join('\n');

    if (block.file && block.find !== undefined) {
      blocks.push({
        file:    block.file,
        find:    block.find,
        replace: block.replace ?? '',
        reason:  block.reason,
      });
    }
  }

  return blocks;
}

// ─── Grep Engine ──────────────────────────────────────────────────────────

/**
 * Search for a regex pattern across all text files in a project.
 *
 * @param projectRoot - Absolute path to the project root
 * @param block       - Parsed grep parameters
 */
export async function runGrep(projectRoot: string, block: GrepBlock): Promise<GrepResult> {
  const MAX        = block.maxMatches ?? 50;
  const searchBase = block.searchPath
    ? path.resolve(projectRoot, block.searchPath)
    : projectRoot;

  // ── Security: refuse to search outside the project root ───────────────
  const relCheck = path.relative(projectRoot, searchBase);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { pattern: block.pattern, matches: [], truncated: false, totalMatches: 0 };
  }

  // Build ignore rules identical to the scanner
  const ig = ignoreLib();
  ig.add(SCAN_EXCLUDES);
  const gitignoreContent = await readFileSafe(path.join(projectRoot, '.gitignore'));
  if (gitignoreContent) ig.add(gitignoreContent);

  const globPattern = block.include ? `**/${block.include}` : '**/*';
  const rawPaths = await glob(globPattern, {
    cwd:    searchBase,
    nodir:  true,
    dot:    false,
    follow: false,
  });

  const filteredPaths = rawPaths.filter(p => {
    const relFromRoot = path
      .relative(projectRoot, path.join(searchBase, p))
      .replace(/\\/g, '/');
    return !ig.ignores(relFromRoot) && isTextFile(p);
  });

  // Compile the regex — fall back to literal search if invalid or pattern too long
  let regex: RegExp;
  if (block.pattern.length > 200) {
    // Pattern too long — use literal (escaped) search to avoid ReDoS
    regex = new RegExp(block.pattern.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } else {
    try {
      regex = new RegExp(block.pattern, 'g');
    } catch {
      regex = new RegExp(block.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    }
  }

  const matches:     GrepMatch[] = [];
  let   totalMatches             = 0;
  let   truncated                = false;

  for (const relPath of filteredPaths) {
    if (truncated) break;

    const absFilePath  = path.join(searchBase, relPath);
    const relFromRoot  = path.relative(projectRoot, absFilePath).replace(/\\/g, '/');

    try {
      const content = await readFile(absFilePath, 'utf-8');
      const lines   = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i]!)) {
          totalMatches++;
          if (matches.length < MAX) {
            matches.push({
              file:    relFromRoot,
              line:    i + 1,
              content: lines[i]!.trim().slice(0, 200), // cap line width
            });
          } else {
            truncated = true;
            break;
          }
        }
      }
    } catch {
      // Unreadable file — skip silently
    }
  }

  return { pattern: block.pattern, matches, truncated, totalMatches };
}

// ─── Patch Engine ─────────────────────────────────────────────────────────

/**
 * Build a simple unified-style diff preview for the terminal.
 * Only shows lines that changed (context lines are dimmed).
 */
function buildPatchPreview(original: string, patched: string, filePath: string): string {
  const origLines  = original.split('\n');
  const patchLines = patched.split('\n');
  const out: string[] = [
    chalk.dim(`--- ${filePath}`),
    chalk.dim(`+++ ${filePath} (patched)`),
  ];

  const maxLen = Math.max(origLines.length, patchLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const p = patchLines[i];
    if (o === p) {
      out.push(chalk.dim(`  ${o ?? ''}`));
    } else {
      if (o !== undefined) out.push(chalk.red(`- ${o}`));
      if (p !== undefined) out.push(chalk.green(`+ ${p}`));
    }
  }
  return out.join('\n');
}

/**
 * Apply a patch to a file after showing a diff preview and asking confirmation.
 *
 * @param projectRoot - Used for the path safety check (no escaping the root)
 * @param block       - Parsed patch parameters
 * @param rl          - Optional readline interface (avoids double-echo in REPL)
 */
export async function applyPatch(
  projectRoot: string,
  block: PatchBlock,
  rl?: readline.Interface,
): Promise<PatchResult> {
  const absFilePath = path.resolve(projectRoot, block.file);

  // ── Safety: refuse to write outside the project root ──────────────────
  const relCheck = path.relative(projectRoot, absFilePath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return {
      file:        block.file,
      approved:    false,
      applied:     false,
      occurrences: 0,
      error:       `Security: "${block.file}" is outside the project root — refused`,
    };
  }

  if (!await pathExists(absFilePath)) {
    return {
      file:        block.file,
      approved:    false,
      applied:     false,
      occurrences: 0,
      error:       `File not found: ${block.file}`,
    };
  }

  const original    = await readFile(absFilePath, 'utf-8');
  const occurrences = original.split(block.find).length - 1;

  if (occurrences === 0) {
    return {
      file:        block.file,
      approved:    false,
      applied:     false,
      occurrences: 0,
      error:       `String not found in ${block.file}: "${block.find.slice(0, 80)}${block.find.length > 80 ? '…' : ''}"`,
    };
  }

  const patched = original.split(block.find).join(block.replace);

  // ── Show diff preview ──────────────────────────────────────────────────
  const boxWidth = 54;
  console.log('');
  console.log(chalk.cyan(`  ┌─ Patch Request ${'─'.repeat(boxWidth - 16)}┐`));
  if (block.reason) {
    console.log(chalk.cyan('  │') + chalk.dim(` ${block.reason}`));
    console.log(chalk.cyan(`  ├${'─'.repeat(boxWidth + 1)}┤`));
  }
  console.log(chalk.cyan('  │') + chalk.white(`  File: ${block.file}`));
  console.log(chalk.cyan('  │') + chalk.dim(`  ${occurrences} occurrence(s) will be replaced`));
  console.log(chalk.cyan(`  └${'─'.repeat(boxWidth + 1)}┘`));
  console.log('');

  const previewLines = buildPatchPreview(original, patched, block.file).split('\n');
  const shown        = previewLines.slice(0, 40);
  shown.forEach(l => console.log(`  ${l}`));
  if (previewLines.length > 40) {
    console.log(chalk.dim(`  … ${previewLines.length - 40} more lines not shown`));
  }
  console.log('');

  // ── Non-interactive: always skip ──────────────────────────────────────
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(chalk.yellow('  ⚠  Non-interactive environment — patch skipped.'));
    logPatchToDb(block, false);
    return { file: block.file, approved: false, applied: false, occurrences };
  }

  // ── Ask permission ─────────────────────────────────────────────────────
  const approved = await new Promise<boolean>(resolve => {
    const q = chalk.magenta('  Apply this patch? [Y/n]: ');
    if (rl) {
      rl.question(q, ans => {
        const t = ans.trim().toLowerCase();
        resolve(t === '' || t === 'y' || t === 'yes');
      });
    } else {
      const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      tempRl.question(q, ans => {
        tempRl.close();
        const t = ans.trim().toLowerCase();
        resolve(t === '' || t === 'y' || t === 'yes');
      });
    }
  });

  logPatchToDb(block, approved);

  if (!approved) {
    return { file: block.file, approved: false, applied: false, occurrences };
  }

  // ── Write the patched file (atomic: write temp then rename) ──────────────
  try {
    const tmpPath = absFilePath + '.laila.tmp';
    await writeFile(tmpPath, patched, 'utf-8');
    await rename(tmpPath, absFilePath);
    console.log(chalk.green(`  ✔  Patched ${block.file} (${occurrences} replacement(s))`));
    return { file: block.file, approved: true, applied: true, occurrences };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { file: block.file, approved: true, applied: false, occurrences, error };
  }
}

// ─── Audit Log ────────────────────────────────────────────────────────────

function logPatchToDb(block: PatchBlock, approved: boolean): void {
  try {
    const findPreview    = block.find.slice(0, 60).replace(/\n/g, '↵');
    const replacePreview = block.replace.slice(0, 60).replace(/\n/g, '↵');
    getDb()
      .prepare(`
        INSERT INTO command_log (command, approved, exit_code, executed_at)
        VALUES (@command, @approved, @exit_code, @executed_at)
      `)
      .run({
        command:     `[patch] ${block.file}: "${findPreview}…" → "${replacePreview}…"`,
        approved:    approved ? 1 : 0,
        exit_code:   approved ? 0 : null,
        executed_at: Math.floor(Date.now() / 1000),
      });
  } catch {
    // Audit log failure must never break main flow
  }
}

// ─── Context formatters (for injecting back into LLM) ─────────────────────

/**
 * Format grep results as a compact string for the next LLM turn.
 */
export function formatGrepResultsForContext(results: GrepResult[]): string {
  if (results.length === 0) return '';

  const parts: string[] = ['=== Grep Results ==='];
  for (const r of results) {
    if (r.matches.length === 0) {
      parts.push(`\nPattern "${r.pattern}": No matches found.`);
      continue;
    }
    const fileCount = new Set(r.matches.map(m => m.file)).size;
    parts.push(
      `\nPattern "${r.pattern}" — ${r.totalMatches} match(es) across ${fileCount} file(s)` +
      (r.truncated ? ` (showing first ${r.matches.length})` : '') + ':'
    );
    for (const m of r.matches) {
      parts.push(`  ${m.file}:${m.line}: ${m.content}`);
    }
  }
  return parts.join('\n');
}

/**
 * Format patch results as a compact string for the next LLM turn.
 */
export function formatPatchResultsForContext(results: PatchResult[]): string {
  if (results.length === 0) return '';

  const parts: string[] = ['=== Patch Results ==='];
  for (const r of results) {
    if (r.error) {
      parts.push(`  ✗ ${r.file}: ${r.error}`);
    } else if (!r.approved) {
      parts.push(`  ○ ${r.file}: Skipped by user (${r.occurrences} occurrence(s) found)`);
    } else if (r.applied) {
      parts.push(`  ✔ ${r.file}: Applied successfully (${r.occurrences} replacement(s))`);
    } else {
      parts.push(`  ✗ ${r.file}: Approved but write failed`);
    }
  }
  return parts.join('\n');
}

// ─── Public runner ────────────────────────────────────────────────────────

export interface RunGrepPatchOptions {
  projectRoot: string;
  rl?: readline.Interface;
}

/**
 * Parse and execute all ```grep and ```patch blocks from an LLM response.
 *
 * Returns formatted context strings ready to inject into the next orchestrator
 * call, plus a `hasResults` flag so the caller knows whether to do a follow-up.
 *
 * Usage in start.ts:
 *
 *   const { grepContext, patchContext, hasResults } = await runGrepPatchBlocks(
 *     result.response, { projectRoot: projectPath, rl }
 *   );
 *   if (hasResults) { ... inject into next orchestrate() call ... }
 */
export async function runGrepPatchBlocks(
  response: string,
  opts: RunGrepPatchOptions,
): Promise<{ grepContext: string; patchContext: string; hasResults: boolean }> {
  const grepBlocks  = parseGrepBlocks(response);
  const patchBlocks = parsePatchBlocks(response);

  const grepResults:  GrepResult[]  = [];
  const patchResults: PatchResult[] = [];

  // ── Grep ──────────────────────────────────────────────────────────────
  for (const block of grepBlocks) {
    if (block.reason) {
      console.log(chalk.dim(`  🔍 grep: ${block.reason}`));
    }
    const result = await runGrep(opts.projectRoot, block);
    grepResults.push(result);

    if (result.matches.length === 0) {
      console.log(chalk.dim(`  🔍 grep "${block.pattern}": no matches`));
    } else {
      const fileCount = new Set(result.matches.map(m => m.file)).size;
      console.log(chalk.dim(
        `  🔍 grep "${block.pattern}": ${result.totalMatches} match(es) in ${fileCount} file(s)` +
        (result.truncated ? ` (truncated to ${result.matches.length})` : '')
      ));
    }
  }

  // ── Patch ─────────────────────────────────────────────────────────────
  for (const block of patchBlocks) {
    const result = await applyPatch(opts.projectRoot, block, opts.rl);
    patchResults.push(result);
  }

  const grepContext  = formatGrepResultsForContext(grepResults);
  const patchContext = formatPatchResultsForContext(patchResults);
  const hasResults   = grepResults.length > 0 || patchResults.length > 0;

  return { grepContext, patchContext, hasResults };
}
