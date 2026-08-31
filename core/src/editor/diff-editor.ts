import path from 'path';
import { readFile, writeFile, mkdir, rename as fsRename } from 'fs/promises';
import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import readline from 'readline';
import type { Interface as RLInterface } from 'readline';

export interface ParsedBlock {
  file: string;
  content: string;
}

export function parseCodeBlocks(response: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const regex = /```[\w]*\n\/\/\s*FILE:\s*([^\n]+)\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(response)) !== null) {
    if (match[1] && match[2]) {
      const fileName = match[1].trim();
      if (!/^[\w./\-]+$/.test(fileName)) {
        continue; // skip blocks with suspicious filenames
      }
      blocks.push({
        file: fileName,
        content: match[2],
      });
    }
  }

  return blocks;
}

/**
 * Ask a yes/no question.
 * If `rl` is provided (REPL context) use it directly to avoid double-echo.
 * Otherwise open a temporary interface (standalone use).
 */
function promptConfirm(message: string, rl?: RLInterface): Promise<boolean> {
  // Require explicit 'y' or 'yes'; blank/enter defaults to NO
  const isYes = (answer: string) => ['y', 'yes'].includes(answer.trim().toLowerCase());

  if (rl) {
    return new Promise(resolve => {
      rl.question(chalk.magenta(`\n  ${message} [y/N] `), answer => {
        resolve(isYes(answer));
      });
    });
  }

  const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    tempRl.question(chalk.magenta(`\n  ${message} [y/N] `), answer => {
      tempRl.close();
      resolve(isYes(answer));
    });
  });
}

export async function generateAndPromptDiff(projectPath: string, blocks: ParsedBlock[], rl?: RLInterface): Promise<number> {
  let filesWritten = 0;

  for (const block of blocks) {
    const absPath = path.resolve(projectPath, block.file);

    // ── Path traversal guard ─────────────────────────────────────────────
    const relCheck = path.relative(projectPath, absPath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      console.log(chalk.red(`  ✖ Skipping ${block.file} — path escapes project root`));
      continue;
    }

    let oldContent = '';
    
    try {
      oldContent = await readFile(absPath, 'utf8');
    } catch {
      // File doesn't exist, it's a new file
    }

    const diff = createTwoFilesPatch(
      block.file,
      block.file,
      oldContent,
      block.content,
      'Old',
      'New'
    );

    // Skip if there are no changes
    if (oldContent === block.content) {
      console.log(chalk.dim(`  No changes to ${block.file}`));
      continue;
    }

    // Print diff
    console.log(`\n  ${chalk.bold(`Proposed changes for ${block.file}`)}`);
    const diffLines = diff.split('\n').slice(4); // Skip the diff header
    for (const line of diffLines) {
      if (line.startsWith('+')) {
        console.log(chalk.green(`  ${line}`));
      } else if (line.startsWith('-')) {
        console.log(chalk.red(`  ${line}`));
      } else {
        console.log(chalk.gray(`  ${line}`));
      }
    }

    const apply = await promptConfirm(`Apply changes to ${block.file}?`, rl);
    if (apply) {
      try {
        // Ensure parent directory exists (handles new files in new subdirectories)
        await mkdir(path.dirname(absPath), { recursive: true });
        // Atomic write: write to temp file then rename — prevents partial writes on crash
        const tmpPath = absPath + '.laila.tmp';
        await writeFile(tmpPath, block.content, 'utf8');
        await fsRename(tmpPath, absPath);
        console.log(chalk.green(`  ✔ Saved ${block.file}`));
        filesWritten++;
      } catch (err) {
        console.log(chalk.red(`  ✖ Failed to save ${block.file}: ${String(err)}`));
      }
    } else {
      console.log(chalk.yellow(`  Skipped ${block.file}`));
    }
  }

  return filesWritten;
}
