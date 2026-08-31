import chalk from 'chalk';
import readline from 'readline';
import { clearCurrentInput, redrawPrompt } from './spinner.js';

const BRAND  = chalk.bold.hex('#7C3AED');
const ACCENT = chalk.hex('#7C3AED');
const DIM    = chalk.gray;

function print(fn: () => void): void {
  clearCurrentInput();
  fn();
  redrawPrompt();
}

export const printer = {
  /** Full-width branded header */
  header(text: string): void {
    const line = '─'.repeat(60);
    print(() => {
      console.log(`\n${BRAND(line)}`);
      console.log(`  ${BRAND('⬡')} ${chalk.bold.white(text)}`);
      console.log(`${BRAND(line)}\n`);
    });
  },

  success(text: string):  void { print(() => console.log(chalk.green('  ✔ ') + text)); },
  error(text: string):    void { print(() => console.log(chalk.red('  ✖ ') + text)); },
  warn(text: string):     void { print(() => console.log(chalk.yellow('  ⚠ ') + text)); },
  info(text: string):     void { print(() => console.log(chalk.cyan('  ℹ ') + text)); },
  dim(text: string):      void { print(() => console.log(DIM('  ' + text))); },
  blank():                void { print(() => console.log()); },

  /** Render key-value pairs as an aligned table */
  table(rows: Array<[string, string]>): void {
    print(() => {
      const maxKey = Math.max(...rows.map(([k]) => k.length));
      for (const [k, v] of rows) {
        console.log(`  ${chalk.bold(k.padEnd(maxKey))}  ${chalk.white(v)}`);
      }
    });
  },

  /** Print an LLM response with a subtle left border */
  response(text: string): void {
    print(() => {
      console.log();
      const lines = text.split('\n');
      for (const line of lines) {
        console.log(chalk.hex('#7C3AED')('│ ') + line);
      }
      console.log();
    });
  },

  /** Validation report summary */
  validationReport(results: Array<{ step: string; success: boolean; durationMs: number }>): void {
    print(() => {
      console.log(`\n  ${chalk.bold('Validation')}`);
      for (const r of results) {
        const icon  = r.success ? chalk.green('✔') : chalk.red('✖');
        const label = r.success ? chalk.green(r.step) : chalk.red(r.step);
        const time  = DIM(`${r.durationMs}ms`);
        console.log(`    ${icon} ${label}  ${time}`);
      }
      console.log();
    });
  },

  /** Render a boxed panel with optional title */
  panel(title: string, body: string): void {
    print(() => {
      const width = 60;
      const top = `╭${'─'.repeat(width - 2)}╮`;
      const bot = `╰${'─'.repeat(width - 2)}╯`;
      console.log(ACCENT(top));
      console.log(ACCENT('│') + ` ${chalk.bold.white(title)}`.padEnd(width - 1) + ACCENT('│'));
      console.log(ACCENT('├' + '─'.repeat(width - 2) + '┤'));
      for (const line of body.split('\n')) {
        const padded = `  ${line}`.padEnd(width - 2);
        console.log(ACCENT('│') + padded + ACCENT('│'));
      }
      console.log(ACCENT(bot));
    });
  },

  /** Section header for REPL output grouping */
  section(title: string): void {
    print(() => {
      console.log(`\n  ${ACCENT('▸')} ${chalk.bold.white(title)}`);
      console.log(`  ${ACCENT('─'.repeat(title.length + 2))}`);
    });
  },

  /** Token usage display */
  tokenUsage(tokens: number, durationMs: number): void {
    const tps = durationMs > 0 ? ((tokens / durationMs) * 1000).toFixed(1) : '?';
    print(() => console.log(DIM(`  ⏱ ${(durationMs / 1000).toFixed(1)}s  •  ${tokens} tokens  •  ${tps} tok/s`)));
  },

  /** Git status summary */
  gitSummary(status: string): void {
    print(() => {
      const lines = status.split('\n').filter(Boolean);
      const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
      const added = lines.filter(l => l.startsWith('A ') || l.startsWith('??')).length;
      const deleted = lines.filter(l => l.startsWith('D ') || l.startsWith(' D')).length;
      const parts: string[] = [];
      if (modified) parts.push(chalk.yellow(`${modified} modified`));
      if (added) parts.push(chalk.green(`${added} added`));
      if (deleted) parts.push(chalk.red(`${deleted} deleted`));
      if (parts.length > 0) {
        console.log(`  ${chalk.bold('Git:')} ${parts.join('  •  ')}`);
      } else {
        console.log(`  ${chalk.bold('Git:')} ${chalk.green('Clean working tree')}`);
      }
    });
  },

  /** Format elapsed time */
  elapsed(startMs: number): string {
    const ms = Date.now() - startMs;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  },

  /** Help command listing */
  helpMenu(): void {
    console.log();
    console.log(BRAND('  Available Commands:'));
    console.log();

    const groups: Array<[string, Array<[string, string]>]> = [
      ['Session', [
        ['/status',    'Show session, project, and provider info'],
        ['/history',   'Show recent tasks in this session'],
        ['/clear',     'Clear the screen'],
        ['/exit',      'End the session'],
      ]],
      ['Queue & Planning', [
        ['/plan <goal>', 'Ask Laila to break a task into steps and queue them'],
        ['/pipeline <task>', 'Run a fixed Researcher -> Coder -> Reviewer pipeline'],
        ['/queue',     'List all pending queued prompts'],
        ['/skip [n]',  'Remove prompt #n from the queue (default: next)'],
        ['/interrupt <text>', 'Push a prompt to the front — runs before anything else'],
      ]],
      ['Provider & Model', [
        ['/provider', 'Switch LLM provider mid-session (Ollama → OpenAI etc.)'],
        ['/model',    'Switch model within current provider'],
      ]],
      ['Project', [
        ['/git',      'Show git status, staged files, and recent commits'],
        ['/commit',   'Commit staged changes with a message'],
        ['/scan',     'Re-scan and re-index project files'],
        ['/skills',   'List all discovered skills'],
        ['/memory',   'Show LAILA.md project memory contents'],
      ]],
    ];

    for (const [group, commands] of groups) {
      console.log(`  ${ACCENT('▸')} ${chalk.bold.white(group)}`);
      const maxCmd = Math.max(...commands.map(([c]) => c.length));
      for (const [cmd, desc] of commands) {
        console.log(`    ${chalk.cyan(cmd.padEnd(maxCmd + 2))} ${DIM(desc)}`);
      }
      console.log();
    }
  },

  /** History table — shows recent tasks with index, agent, status, and truncated input */
  historyTable(tasks: Array<{ id: number; agent: string; status: string; input: string; created_at: number }>): void {
    if (tasks.length === 0) {
      console.log(DIM('  No tasks in this session yet.'));
      return;
    }
    const COL = { id: 5, agent: 12, status: 9, time: 10 };
    const maxInput = 45;
    console.log();
    console.log(
      chalk.bold(
        `  ${'#'.padEnd(COL.id)}${'Agent'.padEnd(COL.agent)}${'Status'.padEnd(COL.status)}${'Time'.padEnd(COL.time)}Request`,
      ),
    );
    console.log(DIM('  ' + '─'.repeat(COL.id + COL.agent + COL.status + COL.time + maxInput)));
    for (const t of tasks) {
      const timeStr = new Date(t.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const statusColor =
        t.status === 'done'    ? chalk.green(t.status.padEnd(COL.status)) :
        t.status === 'failed'  ? chalk.red(t.status.padEnd(COL.status))   :
        t.status === 'running' ? chalk.yellow(t.status.padEnd(COL.status)) :
        DIM(t.status.padEnd(COL.status));
      const input = t.input.length > maxInput ? t.input.slice(0, maxInput - 1) + '…' : t.input;
      console.log(
        `  ${chalk.dim(String(t.id).padEnd(COL.id))}` +
        `${chalk.cyan(t.agent.padEnd(COL.agent))}` +
        `${statusColor}` +
        `${DIM(timeStr.padEnd(COL.time))}` +
        `${chalk.white(input)}`,
      );
    }
    console.log();
  },

  /** Skills list — shows all discovered skills with their agent mapping */
  skillsList(skills: Array<{ name: string; agent: string; description?: string }>): void {
    if (skills.length === 0) {
      console.log(DIM('  No skills discovered.'));
      return;
    }
    // Group by agent
    const grouped = new Map<string, typeof skills>();
    for (const s of skills) {
      const group = grouped.get(s.agent) ?? [];
      group.push(s);
      grouped.set(s.agent, group);
    }
    console.log();
    for (const [agent, agentSkills] of grouped) {
      console.log(`  ${ACCENT('▸')} ${chalk.bold.white(agent)}`);
      const maxName = Math.max(...agentSkills.map(s => s.name.length));
      for (const s of agentSkills) {
        const desc = s.description ? DIM(` — ${s.description}`) : '';
        console.log(`    ${chalk.cyan(s.name.padEnd(maxName))}${desc}`);
      }
      console.log();
    }
  },

  /** Memory display — shows project memory file contents with a header */
  memoryDisplay(source: string, content: string): void {
    console.log();
    console.log(`  ${ACCENT('▸')} ${chalk.bold.white('Project Memory')} ${DIM(`(${source})`)}`);
    console.log(`  ${ACCENT('─'.repeat(58))}`);
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('## ')) {
        console.log(`\n  ${chalk.bold.white(line)}`);
      } else if (line.startsWith('### ')) {
        console.log(`  ${chalk.bold(line)}`);
      } else if (line.startsWith('# ')) {
        console.log(`\n  ${ACCENT(line)}`);
      } else {
        console.log(`  ${line}`);
      }
    }
    console.log();
  },

  /** Provider info — shows current provider and model after a switch */
  providerInfo(provider: string, model: string): void {
    console.log();
    console.log(`  ${chalk.green('✔')} Provider: ${chalk.cyan(provider)}  │  Model: ${chalk.cyan(model)}`);
    console.log();
  },

  banner(): void {
    console.log();
    console.log(BRAND('  ██╗      █████╗ ██╗██╗      █████╗ '));
    console.log(BRAND('  ██║     ██╔══██╗██║██║     ██╔══██╗'));
    console.log(BRAND('  ██║     ███████║██║██║     ███████║'));
    console.log(BRAND('  ██║     ██╔══██║██║██║     ██╔══██║'));
    console.log(BRAND('  ███████╗██║  ██║██║███████╗██║  ██║'));
    console.log(BRAND('  ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═╝'));
    console.log(DIM('  Local-first AI developer assistant  •  v1.0'));
    console.log();
  },
};
