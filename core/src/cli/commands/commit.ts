import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import { getGitDiff, commitChanges, getGitStatus } from '../../utils/git-utils.js';
import { chat } from '../../llm/provider-factory.js';
import { spinner } from '../ui/spinner.js';
import { printer } from '../ui/printer.js';
import { LAILA_IDENTITY } from '../../llm/identity.js';

export async function commitCommand(targetPath?: string): Promise<void> {
  const resolvedPath = path.resolve(targetPath || '.');
  
  spinner.start('Checking staged changes…');
  
  const status = await getGitStatus(resolvedPath);
  if (!status) {
    spinner.fail('Not a Git repository or Git is not installed.');
    return;
  }

  const diff = await getGitDiff(resolvedPath, true);
  if (!diff || diff.trim() === '') {
    spinner.fail('No staged changes found. Use `git add` to stage files first.');
    return;
  }
  
  spinner.update('Generating commit message…');
  
  const prompt = `
Generate a concise, conventional commit message for the following staged changes.
Format:
<type>(<scope>): <subject>

[optional body]

Return ONLY the commit message without any markdown formatting or extra text.

Diff:
${diff}
`;

  try {
    const result = await chat([
      { role: 'system', content: LAILA_IDENTITY },
      { role: 'user', content: prompt }
    ], { temperature: 0.1 });
    
    spinner.stop();
    const commitMsg = result.content.trim();
    
    printer.blank();
    console.log(chalk.cyan('Proposed Commit Message:'));
    console.log(chalk.white(commitMsg));
    printer.blank();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.magenta('  Accept and commit? [Y/n] '), (ans) => {
        rl.close();
        resolve(ans);
      });
    });

    if (answer.trim().toLowerCase() !== 'n') {
      spinner.start('Committing changes…');
      const success = await commitChanges(resolvedPath, commitMsg);
      if (success) {
        spinner.succeed('Successfully committed changes.');
      } else {
        spinner.fail('Failed to commit changes.');
      }
    } else {
      printer.warn('Commit aborted.');
    }
  } catch (err: unknown) {
    spinner.fail('Failed to generate commit message.');
    printer.error(err instanceof Error ? err.message : String(err));
  }
}
