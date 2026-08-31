import ora from 'ora';
import readline from 'readline';
import chalk from 'chalk';

let _rl: import('readline').Interface | null = null;
const _oraSpinner = ora();

export function setRl(rl: import('readline').Interface): void {
  _rl = rl;
}

export function clearCurrentInput(): void {
  if (!process.stdout.isTTY || !_rl) return;
  const typed = (_rl as unknown as { line: string }).line ?? '';
  const prompt = (_rl as unknown as { _prompt: string })._prompt ?? '';
  const cols = process.stdout.columns || 80;
  const totalLen = prompt.replace(/\x1B\[[0-9;]*m/g, '').length + typed.length;
  const lines = Math.floor(totalLen / cols);
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
    _oraSpinner.start(chalk.magenta(text));
  },
  update(text: string): void {
    _oraSpinner.text = chalk.magenta(text);
  },
  succeed(text?: string): void {
    if (text) {
      _oraSpinner.succeed(chalk.green(text));
    } else {
      _oraSpinner.stop();
    }
    redrawPrompt();
  },
  fail(text?: string): void {
    if (text) {
      _oraSpinner.fail(chalk.red(text));
    } else {
      _oraSpinner.stop();
    }
    redrawPrompt();
  },
  stop(): void {
    _oraSpinner.stop();
    redrawPrompt();
  },
};
