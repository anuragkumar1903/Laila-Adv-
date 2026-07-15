#!/usr/bin/env node
import { program } from 'commander';
import { startCommand } from './commands/start.js';
import { askCommand } from './commands/ask.js';
import { scanCommand } from './commands/scan.js';
import { statusCommand } from './commands/status.js';
import { historyCommand } from './commands/history.js';
import { skillsCommand } from './commands/skills.js';
import { doctorCommand } from './commands/doctor.js';
import { commitCommand } from './commands/commit.js';
import { initSchema } from '../memory/schema.js';

// Initialize the database schema on startup to ensure tables exist
try {
  initSchema();
} catch (err) {
  console.error('Failed to initialize database schema:', err);
  process.exit(1);
}

if (process.argv.length <= 2) {
  await startCommand();
} else {
  program
    .name('laila-cli')
    .description('Laila: Local-first AI developer assistant')
    .version('1.0.0');

  program
    .command('start')
    .description('Start an interactive REPL session with Laila')
    .action(async () => {
      await startCommand();
    });

  program
    .command('ask <query>')
    .description('Ask Laila a single question about your project')
    .action(async (query: string) => {
      await askCommand(query);
    });

  program
    .command('scan [path]')
    .description('Scan a project directory to index its files')
    .action(async (path?: string) => {
      await scanCommand(path);
    });

  program
    .command('status')
    .description('Show current session and loaded project status')
    .action(async () => {
      await statusCommand();
    });

  program
    .command('history')
    .description('Show recent task execution history')
    .action(async () => {
      await historyCommand();
    });

  program
    .command('skills')
    .description('List discovered skills and their agent mappings')
    .action(async () => {
      await skillsCommand();
    });

  program
    .command('doctor')
    .description('Inspect system readiness and suggest fixes')
    .option('--fix', 'Create missing local directories and apply safe remediations')
    .option('--json', 'Structured JSON output')
    .action(async (options) => {
      const args: string[] = [];
      if (options?.fix) args.push('--fix');
      if (options?.json) args.push('--json');
      await doctorCommand(...args);
    });

  program
    .command('commit [path]')
    .description('Generate a commit message based on staged changes and commit them')
    .action(async (path?: string) => {
      await commitCommand(path);
    });

  // Handle SIGINT gracefully
  process.on('SIGINT', () => {
    console.log('\nGracefully shutting down...');
    process.exit(0);
  });

  program.parse();
}
