import chalk from 'chalk';
import readline from 'readline';

let _prompt = chalk.magenta('  laila> ');
let _current = '';

function clearLine(): void {
  if (!process.stdout.isTTY) return;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
}

function redraw(): void {
  if (!process.stdout.isTTY) return;
  clearLine();
  process.stdout.write(_prompt + _current);
}

/** Call before any console.log/print so output appears above the prompt */
export function beforePrint(): void {
  clearLine();
}

/** Call after any console.log/print to restore the bottom prompt */
export function afterPrint(): void {
  redraw();
}

/** Update the prompt label (e.g. laila[+2]> ) */
export function setPromptLabel(label: string): void {
  _prompt = label;
  redraw();
}

/** Update what the user has typed so far (feed from keypress events) */
export function setCurrentInput(input: string): void {
  _current = input;
}

/** Wrap console.log so every print auto-manages the bottom bar */
export function patchConsole(): void {
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    beforePrint();
    orig(...args);
    afterPrint();
  };
}
