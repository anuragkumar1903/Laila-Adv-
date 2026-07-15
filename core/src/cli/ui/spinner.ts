import chalk from 'chalk';
import readline from 'readline';

let _rl: import('readline').Interface | null = null;

export function setRl(rl: import('readline').Interface): void {
  _rl = rl;
}

export function clearCurrentInput(): void {
  if (!process.stdout.isTTY || !_rl) return;
  const typed = (_rl as unknown as { line: string }).line ?? '';
  const prompt = (_rl as unknown as { _prompt: string })._prompt ?? '';
  const cols = process.stdout.columns || 80;
  // How many terminal lines does prompt+typed occupy?
  const totalLen = prompt.replace(/\x1B\[[0-9;]*m/g, '').length + typed.length;
  const lines = Math.floor(totalLen / cols);
  // Move cursor up to the first line of the prompt, then clear down
  if (lines > 0) readline.moveCursor(process.stdout, 0, -lines);
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
}

export function redrawPrompt(): void {
  if (!process.stdout.isTTY || !_rl) return;
  const typed = (_rl as unknown as { line: string }).line ?? '';
  const prompt = (_rl as unknown as { _prompt: string })._prompt ?? '';
  process.stdout.write(prompt + typed);
}

export const spinner = {
  start(text: string): void {
    clearCurrentInput();
    process.stdout.write(chalk.magenta(`  ⋯ ${text}\n`));
    redrawPrompt();
  },

  update(text: string): void {
    clearCurrentInput();
    process.stdout.write(chalk.magenta(`  ⋯ ${text}\n`));
    redrawPrompt();
  },

  succeed(text?: string): void {
    if (text) {
      clearCurrentInput();
      process.stdout.write(chalk.green(`  ✔ ${text}\n`));
      redrawPrompt();
    }
  },

  fail(text?: string): void {
    if (text) {
      clearCurrentInput();
      process.stdout.write(chalk.red(`  ✖ ${text}\n`));
      redrawPrompt();
    }
  },

  stop(): void {},
};
