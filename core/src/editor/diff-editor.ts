import path from 'path';
import { readFile, writeFile, rename as fsRename, mkdir } from 'fs/promises';
import { pathExists } from '../utils/fs-utils.js';
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
      // FIX (Medium #21): Previous regex /^[\w./\-]+$/ rejected legitimate filenames
      // that contain: spaces, @ (npm scopes like @types/node), +, or non-ASCII chars.
      // New rules:
      //  - Must not be empty
      //  - Must not start with / or contain .. (absolute paths / traversal)
      //  - Must not contain null bytes or shell metacharacters (;|&`$<>)
      if (!fileName ||
          path.isAbsolute(fileName) ||
          fileName.includes('..') ||
          /[\0;|&`$<>]/.test(fileName)) {
        continue; // skip blocks with dangerous filenames
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
async function promptConfirm(message: string, rl?: RLInterface): Promise<boolean> {
  const { askYesNo } = await import('../utils/prompt-utils.js');
  if (rl) {
    return askYesNo(rl, chalk.magenta(`\n  ${message}`), false);
  }
  const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const result = await askYesNo(tempRl, chalk.magenta(`\n  ${message}`), false);
  tempRl.close();
  return result;
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
        await mkdir(path.dirname(absPath), { recursive: true });
        
        // Backup for rollback
        const backupPath = absPath + '.laila.bak';
        let existed = false;
        if (await pathExists(absPath)) {
          existed = true;
          await fsRename(absPath, backupPath);
        }

        const tmpPath = absPath + '.laila.tmp';
        await writeFile(tmpPath, block.content, 'utf8');
        await fsRename(tmpPath, absPath);
        
        // Ponytail validation loop
        const { validateProject } = await import('./validator.js');
        const spinner = (await import('../cli/ui/spinner.js')).spinner;
        spinner.start(`Validating ${block.file}...`);
        const { success, log } = await validateProject(projectPath);
        
        if (!success) {
          spinner.fail(`Validation failed! Auto-rolling back ${block.file}.`);
          console.log(chalk.red(log.slice(-500))); // only show tail of log
          
          // Rollback
          if (existed) {
            await fsRename(backupPath, absPath);
          } else {
            const { unlink } = await import('fs/promises');
            await unlink(absPath);
          }
        } else {
          spinner.succeed(`Validation passed.`);
          console.log(chalk.green(`  ✔ Saved ${block.file}`));
          filesWritten++;
          
          // Cleanup backup
          if (existed) {
            const { unlink } = await import('fs/promises');
            await unlink(backupPath).catch(() => {});
          }
        }
      } catch (err) {
        console.log(chalk.red(`  ✖ Failed to save ${block.file}: ${String(err)}`));
      }
    } else {
      console.log(chalk.yellow(`  Skipped ${block.file}`));
    }
  }

  return filesWritten;
}
