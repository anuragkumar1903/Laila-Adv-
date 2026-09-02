/**
 * file-tool.ts
 *
 * Implements Phase 1 — File Tools: Read, Write, and Create capabilities.
 * LLMs trigger these via specific markdown fence blocks.
 *
 * ── Fence formats ────────────────────────────────────────────────────────
 *
 *   ```read
 *   file: <relative file path>
 *   startLine: <number - optional>
 *   endLine: <number - optional>
 *   ```
 *
 *   ```write
 *   file: <relative file path>
 *   content: |
 *     <multiline content to write or overwrite>
 *   ```
 *
 *   ```create
 *   file: <relative file path>
 *   content: |
 *     <multiline content for new file>
 *   ```
 */

import { readFile, writeFile, realpath } from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import { getDb } from '../memory/db.js';
import { readFileSafe, pathExists } from '../utils/fs-utils.js';

// ─── Execution ──────────────────────────────────────────────────────────────

export async function executeReadBlock(
  block: ReadBlock,
  projectRoot: string
): Promise<ReadResult> {
  const resolvedRoot = path.resolve(projectRoot);
  const fullPath = path.resolve(resolvedRoot, block.file);

  // FIX (High): Primary path-traversal check
  if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
    return { file: block.file, content: '', error: 'Cannot read outside project root.' };
  }

  if (!(await pathExists(fullPath))) {
    return { file: block.file, content: '', error: `File not found: ${block.file}` };
  }

  // FIX (High): Resolve symlinks AFTER the lexical check — prevents a symlink
  // inside the project that points outside (e.g. .laila/secrets -> /etc/passwd).
  let realFullPath: string;
  try {
    realFullPath = await realpath(fullPath);
  } catch {
    return { file: block.file, content: '', error: `Cannot resolve path: ${block.file}` };
  }

  // Resolve the real root too (the root itself might have a symlink component)
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  if (!realFullPath.startsWith(realRoot + path.sep) && realFullPath !== realRoot) {
    return { file: block.file, content: '', error: 'Cannot read outside project root (symlink escape detected).' };
  }

  const content = await readFileSafe(realFullPath);
  if (content === null) {
    return { file: block.file, content: '', error: `Failed to read file: ${block.file}` };
  }

  let finalContent = content;
  if (block.startLine !== undefined || block.endLine !== undefined) {
    const lines = content.split('\n');
    const start = Math.max(1, block.startLine || 1) - 1;
    const end = block.endLine ? Math.min(lines.length, block.endLine) : lines.length;
    finalContent = lines.slice(start, end).join('\n');
  }

  return { file: block.file, content: finalContent };
}

export async function executeWriteBlock(
  block: WriteBlock,
  projectRoot: string
): Promise<WriteResult> {
  const resolvedRoot = path.resolve(projectRoot);
  const fullPath = path.resolve(resolvedRoot, block.file);

  // FIX (High): Primary lexical path-traversal check
  if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
    return { file: block.file, approved: false, applied: false, error: 'Cannot write outside project root.' };
  }

  // Ask for user permission
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  console.log(`\n${chalk.cyan('LAILA WANTS TO ' + (block.isCreate ? 'CREATE' : 'WRITE TO') + ' FILE:')} ${chalk.yellow(block.file)}`);
  
  // Show a preview
  console.log(chalk.gray('--- PREVIEW ---'));
  const previewLines = block.content.split('\n').slice(0, 10);
  console.log(chalk.gray(previewLines.join('\n')));
  if (previewLines.length < block.content.split('\n').length) {
    console.log(chalk.gray('... (truncated)'));
  }
  console.log(chalk.gray('---------------'));

  const { askYesNo } = await import('../utils/prompt-utils.js');
  const approved = await askYesNo(rl, chalk.green('Allow write? '));
  rl.close();

  if (!approved) {
    console.log(chalk.red('Write blocked by user.'));
    return { file: block.file, approved: false, applied: false };
  }

  try {
    await writeFile(fullPath, block.content, 'utf-8');
    console.log(chalk.green(`✓ Wrote to ${block.file}`));
    return { file: block.file, approved: true, applied: true };
  } catch (err: any) {
    console.error(chalk.red(`✗ Failed to write to ${block.file}: ${err.message}`));
    return { file: block.file, approved: true, applied: false, error: err.message };
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface ReadBlock {
  file: string;
  startLine?: number;
  endLine?: number;
}

export interface WriteBlock {
  file: string;
  content: string;
  isCreate?: boolean;
}

export interface ReadResult {
  file: string;
  content: string;
  error?: string;
}

export interface WriteResult {
  file: string;
  approved: boolean;
  applied: boolean;
  error?: string;
}

// ─── Parsers ──────────────────────────────────────────────────────────────

export function parseReadBlocks(response: string): ReadBlock[] {
  const blocks: ReadBlock[] = [];
  const regex = /^[ \t]*```read[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gim;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const lines = (match[1] ?? '').split('\n');
    let file = '';
    let startLine: number | undefined;
    let endLine: number | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) {
        if (!file) file = trimmed; // Fallback: first uncommented line is file path
        continue;
      }
      
      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const val = trimmed.slice(colonIdx + 1).trim();

      if (key === 'file' || key === 'path') file = val;
      if (key === 'startline') startLine = parseInt(val, 10);
      if (key === 'endline') endLine = parseInt(val, 10);
    }

    if (file) {
      blocks.push({ file, startLine, endLine });
    }
  }

  return blocks;
}

export function parseWriteBlocks(response: string): WriteBlock[] {
  const blocks: WriteBlock[] = [];
  const writeRegex = /^[ \t]*```(write|create)[ \t]*\r?\n([\s\S]*?)^[ \t]*```/gim;
  let match: RegExpExecArray | null;

  while ((match = writeRegex.exec(response)) !== null) {
    const isCreate = (match[1] ?? '').toLowerCase() === 'create';
    const lines = (match[2] ?? '').split('\n');
    let file = '';
    let content = '';
    let readingContent = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (readingContent) {
        content += line + (i === lines.length - 1 ? '' : '\n');
        continue;
      }
      
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      
      if (trimmed.toLowerCase().startsWith('file:')) {
        file = trimmed.slice(5).trim();
      } else if (trimmed.toLowerCase().startsWith('path:')) {
        file = trimmed.slice(5).trim();
      } else if (trimmed.toLowerCase().startsWith('content:')) {
        readingContent = true;
        const inlineContent = trimmed.slice(8).trim();
        // FIX (Medium #17): If there's an inline value (e.g. `content: some code`)
        // AND it's not the YAML block scalar indicator `|`, treat the inline value
        // as the COMPLETE content — do NOT continue appending subsequent lines,
        // which would double-capture the content.
        if (inlineContent && inlineContent !== '|') {
          content = inlineContent;
          readingContent = false; // inline value is the whole content — stop here
        }
        // If inlineContent is '|' or empty, fall through to line-by-line reading
      }
    }

    if (file && content) {
      // Remove trailing newline if it was added just for tracking
      content = content.replace(/\n$/, '');
      blocks.push({ file, content, isCreate });
    }
  }

  return blocks;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatReadResultsForContext(results: ReadResult[]): string {
  if (results.length === 0) return '';
  const parts: string[] = ['=== File Read Results ==='];
  for (const r of results) {
    if (r.error) {
      parts.push(`\nError reading ${r.file}: ${r.error}`);
    } else {
      parts.push(`\nFile: ${r.file}\n\`\`\`\n${r.content}\n\`\`\``);
    }
  }
  return parts.join('\n');
}

export function formatWriteResultsForContext(results: WriteResult[]): string {
  if (results.length === 0) return '';
  const parts: string[] = ['=== File Write Results ==='];
  for (const r of results) {
    if (r.error) {
      parts.push(`  ✗ ${r.file}: ${r.error}`);
    } else if (!r.approved) {
      parts.push(`  ○ ${r.file}: Skipped by user`);
    } else if (r.applied) {
      parts.push(`  ✔ ${r.file}: Applied successfully`);
    } else {
      parts.push(`  ✗ ${r.file}: Approved but write failed`);
    }
  }
  return parts.join('\n');
}

// ─── Public runner ────────────────────────────────────────────────────────

export interface RunFileOptions {
  projectRoot: string;
}

export async function runFileBlocks(
  response: string,
  opts: RunFileOptions,
): Promise<{ readContext: string; writeContext: string; hasResults: boolean }> {
  // Use the parsers we defined
  const readBlocks  = parseReadBlocks(response);
  const writeBlocks = parseWriteBlocks(response);

  const readResults:  ReadResult[]  = [];
  const writeResults: WriteResult[] = [];

  for (const block of readBlocks) {
    console.log(chalk.dim(`  📖 read: ${block.file}`));
    const result = await executeReadBlock(block, opts.projectRoot);
    readResults.push(result);
  }

  for (const block of writeBlocks) {
    const result = await executeWriteBlock(block, opts.projectRoot);
    writeResults.push(result);
  }

  const readContext  = formatReadResultsForContext(readResults);
  const writeContext = formatWriteResultsForContext(writeResults);
  const hasResults   = readResults.length > 0 || writeResults.length > 0;

  return { readContext, writeContext, hasResults };
}
