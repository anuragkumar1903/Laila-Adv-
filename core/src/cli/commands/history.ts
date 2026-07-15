import { findRecent } from '../../memory/repositories/tasks.js';
import { printer } from '../ui/printer.js';
import chalk from 'chalk';

export async function historyCommand(): Promise<void> {
  const tasks = findRecent(15);
  if (tasks.length === 0) {
    printer.info('No task history found.');
    return;
  }

  printer.header('Laila CLI Task History');

  for (const task of tasks) {
    const timeStr = new Date(task.created_at * 1000).toLocaleString();
    const statusColor = task.status === 'done' ? chalk.green : (task.status === 'failed' ? chalk.red : chalk.yellow);
    
    console.log(`  ${chalk.bold(`[Task #${task.id}]`)}  ${timeStr}  -  Status: ${statusColor(task.status.toUpperCase())}`);
    console.log(`    ${chalk.dim('Intent:')} ${task.intent}  |  ${chalk.dim('Agent:')} ${task.agent}`);
    console.log(`    ${chalk.dim('Prompt:')} ${task.input}`);
    if (task.output) {
      const truncatedOutput = task.output.length > 120 ? task.output.substring(0, 120) + '...' : task.output;
      console.log(`    ${chalk.dim('Output:')} ${truncatedOutput.replace(/\n/g, ' ')}`);
    }
    console.log(chalk.gray('  ' + '─'.repeat(50)));
  }
}
