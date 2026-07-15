import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

let currentLevel: LogLevel = 'info';

const WEIGHTS: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, silent: 99,
};

function shouldLog(level: LogLevel): boolean {
  return (WEIGHTS[level] ?? 1) >= (WEIGHTS[currentLevel] ?? 1);
}

export const logger = {
  setLevel(level: LogLevel): void {
    currentLevel = level;
  },

  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.debug(chalk.gray('[debug]'), ...args);
  },

  info(...args: unknown[]): void {
    if (shouldLog('info')) console.info(chalk.blue('[info]'), ...args);
  },

  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(chalk.yellow('[warn]'), ...args);
  },

  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error(chalk.red('[error]'), ...args);
  },
};
