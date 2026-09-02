/**
 * shell-tool.ts
 *
 * Permission-gated shell command execution for Laila.
 *
 * Flow:
 *   1. Parse ```cmd / ```shell blocks from LLM response
 *   2. Validate the command against allowlist / blocklist
 *   3. Show a clear permission prompt to the user
 *   4. On approval — execute with streaming output, timeout, and audit log
 *   5. Return CommandResult so the caller can inject output back into context
 *
 * Safety design (from cli-developer skill):
 *   - Only allowed command prefixes can run
 *   - Dangerous patterns are always blocked regardless of allowlist
 *   - TTY detection: never auto-prompts in CI / non-interactive environments
 *   - All executions (approved and denied) are written to command_log in SQLite
 *   - Commands run in the project directory only, never system paths
 *   - 2-minute hard timeout on every command
 */

import { spawn }    from 'child_process';
import readline     from 'readline';
import chalk        from 'chalk';
import { getDb }    from '../memory/db.js';
import type { CommandBlock, CommandResult } from '../types.js';

// ─── Constants ────────────────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Allowed command prefixes.
 * Only commands that start with one of these will pass the safety check.
 *
 * Covers:
 *   - Package managers (npm, pnpm, yarn, bun, pip, cargo, etc.)
 *   - Runtimes (node, python, go, dotnet, java, ruby, php)
 *   - Build tools (tsc, make, mvn, gradle, cmake, msbuild)
 *   - VCS (git)
 *   - Windows CMD built-ins (dir, type, echo, copy, move, mkdir, ren, cls, set, ver)
 *   - PowerShell cmdlets (Get-*, Set-*, New-*, Remove-*, Copy-*, Move-*, Test-*, Write-*, etc.)
 *   - Unix utilities (ls, cat, pwd, which, grep, find, curl, wget — without pipe-to-shell)
 *
 * NOTE: Shell launchers (bash, sh, zsh, powershell, pwsh, cmd) are intentionally
 * NOT listed here. Allowing them as prefixes defeats the entire allowlist because
 * any command can be run via e.g. `bash -c "rm -rf /"`. They are explicitly blocked
 * by BLOCKED_PATTERNS instead.
 */
// Ponytail: wrap in Set to eliminate duplicates (ls, dir, cat, copy, move, etc.
// appear in both the Windows CMD and Unix sections above).
const ALLOWED_PREFIXES: ReadonlySet<string> = new Set([
  // ── Package managers ────────────────────────────────────────────────
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'pip', 'pip3', 'pipenv', 'poetry', 'uv',
  'cargo', 'rustc', 'rustup',
  'go',
  'dotnet',
  'mvn', 'gradle', 'gradlew',
  'composer',
  'gem', 'bundle',

  // ── Runtimes ────────────────────────────────────────────────────────
  'node', 'tsx', 'ts-node', 'deno',
  'python', 'python3', 'python3.11', 'python3.12',
  'java', 'javac', 'kotlin',
  'ruby', 'rake',
  'php',
  'lua',
  'perl',
  'swift', 'swiftc',

  // ── Build / compile tools ────────────────────────────────────────────
  'tsc',
  'make', 'cmake', 'ninja',
  'msbuild',
  'xcodebuild',
  'ant',

  // ── Version control ──────────────────────────────────────────────────
  'git',

  // ── Laila CLI & Containers ───────────────────────────────────────────
  'laila',
  'docker', 'docker-compose', 'podman',

  // ── Windows CMD + PowerShell cmdlet aliases ──────────────────────────
  'dir', 'echo', 'type', 'copy', 'move', 'mkdir', 'md', 'ren', 'rename',
  'cls', 'set', 'ver', 'where', 'whoami', 'hostname', 'ipconfig', 'ping',
  'tasklist', 'fc', 'findstr', 'tree',
  // PowerShell Get-*
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi',
  'get-location', 'gl', 'get-process', 'gps', 'ps', 'get-service',
  'get-command', 'gcm', 'get-help', 'get-variable', 'gv', 'get-env',
  'get-date', 'get-host', 'get-module', 'get-installedmodule',
  // PowerShell Write-*
  'write-host', 'write-output', 'write-verbose',
  // PowerShell Set-*
  'set-location', 'sl', 'cd', 'set-variable', 'sv',
  // PowerShell New-*
  'new-item', 'ni', 'new-object', 'new-module',
  // PowerShell Copy/Move
  'copy-item', 'cp', 'move-item', 'mv',
  // PowerShell Test-*
  'test-path', 'test-connection', 'test-json',
  // PowerShell Invoke-* (NOT Invoke-Expression — that's in BLOCKED_PATTERNS)
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
  // PowerShell pipeline helpers
  'select-object', 'select', 'sort-object', 'sort',
  'where-object', 'measure-object', 'measure',
  'format-list', 'fl', 'format-table', 'ft',

  // ── Unix/bash utilities ─────────────────────────────────────────────
  // NOTE: bash, sh, zsh are intentionally excluded — blocked by BLOCKED_PATTERNS
  // NOTE: source, export excluded — run arbitrary shell files / set env vars
  'ls', 'll', 'cat', 'pwd', 'which',
  'grep', 'rg',
  'find',
  'curl', 'wget',
  'tar', 'unzip', 'zip',
  'chmod', 'chown', 'ln', 'touch',
  'wc', 'head', 'tail',
  'diff', 'patch',
  'sed', 'awk',
  'uniq', 'xargs',
  // NOTE: 'env' excluded — `env CMD args` defeats the allowlist
  'open', 'xdg-open',
]);

/**
 * Dangerous patterns — always blocked even if the prefix is allowed.
 * Matches against the full lowercased command string.
 */
const BLOCKED_PATTERNS: readonly RegExp[] = [
  // ── Destructive file operations ────────────────────────────────────
  /rm\s+-rf/i,
  /rm\s+--recursive/i,               // rm --recursive (long flag bypass)
  /rm\s+--force/i,
  /rm\s+-[a-z]*r[a-z]*f/i,       // rm -fr, rm -Rf etc.
  /del\s+\/[fFsS]/i,              // del /f, del /s
  /del\s+\/q/i,                   // del /q (quiet delete)
  /erase\s+\/[fFsS]/i,
  /rd\s+\/s/i,                    // rd /s (Windows rmdir recursive)
  /rmdir\s+\/s/i,
  /remove-item\s+-recurse\s+-force/i,  // PowerShell rm -rf equivalent
  /remove-item\s+-force\s+-recurse/i,

  // ── env prefix bypass ───────────────────────────────────────────────
  // `env VARNAME=val dangerous-cmd` passes `env` as the base command but
  // executes `dangerous-cmd` directly. Block env at the start of a segment.
  /^env\s+/i,

  // ── Disk / system destructive ops ─────────────────────────────────
  /format\s+[a-z]:/i,             // format C:
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/(sd|hd|nv)/i,       // writing to block devices

  // ── System shutdown / restart ──────────────────────────────────────
  /shutdown/i,
  /reboot/i,
  /halt/i,
  /poweroff/i,
  /restart-computer/i,            // PowerShell
  /stop-computer/i,               // PowerShell

  // ── Privilege escalation ───────────────────────────────────────────
  /sudo\s/i,
  /runas\s/i,
  /start-process\s+.*-verb\s+runas/i,  // PowerShell runas

  // ── Code injection / remote execution ─────────────────────────────
  /curl\s.*\|\s*(bash|sh|zsh|powershell|pwsh)/i,
  /wget\s.*\|\s*(bash|sh|zsh|powershell|pwsh)/i,
  /iwr\s.*\|\s*(iex|invoke-expression)/i,
  /invoke-expression/i,           // PowerShell eval — always dangerous
  /iex\s/i,                       // PowerShell iex shorthand
  /eval\s*\(/i,
  /exec\s*\(/i,
  /base64\s.*\|\s*(bash|sh|pwsh)/i,

  // ── Database destructive ops ────────────────────────────────────────
  /drop\s+table/i,
  /drop\s+database/i,
  /truncate\s+table/i,

  // ── Dangerous permission changes ───────────────────────────────────
  /chmod\s+[0-7]*7[0-7][0-7]/i,   // chmod 777 style
  /icacls\s.*\/grant\s+everyone/i, // Windows everyone full access

  // ── Registry edits ────────────────────────────────────────────────
  /reg\s+(delete|add)\s/i,
  /remove-itemproperty\s.*hklm/i,
  /set-itemproperty\s.*hklm/i,

  // ── Network exfiltration patterns ──────────────────────────────────
  /curl\s+.*\s+-d\s+.*\$env/i,     // sending env vars via curl
  /curl\s+.*\s+-d\s+.*\$home/i,
];

// ─── Parser ───────────────────────────────────────────────────────────────

/**
 * Extract ```cmd and ```shell fenced blocks from an LLM response.
 * Supports an optional first-line comment as the "reason":
 *
 *   ```cmd
 *   # Install dependencies
 *   npm install express
 *   ```
 *
 * Each non-comment line is treated as a separate command block so that
 * validation runs against every individual command rather than a joined
 * string. This prevents bypass via `npm run build && rm -rf /`.
 */
export function parseCommandBlocks(response: string): CommandBlock[] {
  const blocks: CommandBlock[] = [];

  // Match ```cmd or ```shell (case-insensitive), capture body
  const regex = /```(?:cmd|shell|bash|sh|powershell|ps1)\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const body = (match[1] ?? '').trim();
    if (!body) continue;

    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // Extract optional leading comment as shared reason
    let sharedReason: string | undefined;
    let commandLines: string[];

    if (lines[0]!.startsWith('#') || lines[0]!.startsWith('//')) {
      sharedReason = lines[0]!.replace(/^[#/]+\s*/, '');
      commandLines = lines.slice(1);
    } else {
      commandLines = lines;
    }

    // Emit one CommandBlock per non-comment line so each is validated
    // independently — prevents chain-operator injection across lines.
    for (const line of commandLines) {
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      blocks.push({ command: line.trim(), reason: sharedReason });
    }
  }

  return blocks;
}

// ─── Safety Validator ────────────────────────────────────────────────────

export type SafetyVerdict =
  | { safe: true }
  | { safe: false; reason: string };

/**
 * Split a command string on shell chain operators AND subshell delimiters,
 * returning each individual segment trimmed, discarding empty parts.
 *
 * Handles:
 *   &&  ||  ;  |  &          — standard chain operators
 *   `...`                    — backtick subshells
 *   $(...)                   — dollar-paren subshells
 *   <<<                      — here-string
 *   <(...)  >(...)            — process substitution
 *
 * Quote-aware: operators inside single-quoted or double-quoted strings are
 * NOT split, preventing false positives like `echo "hello && world"`.
 *
 * This prevents bypasses like:
 *   npm install `rm -rf /`
 *   cat <<< $(rm -rf /)
 */
function splitOnOperators(command: string): string[] {
  // First extract any backtick-subshell contents and add them as segments
  const segments: string[] = [];

  // Replace backtick subshells with sentinel so they get split out
  // e.g.  npm install `rm -rf /`  → we extract "rm -rf /" as a segment
  let remaining = command;

  // Extract backtick subshell contents
  remaining = remaining.replace(/`([^`]*)`/g, (_match, inner: string) => {
    segments.push(inner.trim());
    return ' ';
  });

  // Extract $(...) subshell contents (non-nested, handles common cases)
  remaining = remaining.replace(/\$\(([^)]*)\)/g, (_match, inner: string) => {
    segments.push(inner.trim());
    return ' ';
  });

  // Extract <(...) and >(...) process substitution contents
  remaining = remaining.replace(/[<>]\(([^)]*)\)/g, (_match, inner: string) => {
    segments.push(inner.trim());
    return ' ';
  });

  // Extract <<< (here-string) — the word after <<< is data, not a command,
  // but we still want to split on it in case it embeds something dangerous
  remaining = remaining.replace(/<<<\s*(\S+)/g, (_match, word: string) => {
    segments.push(word.trim());
    return ' ';
  });

  // FIX (Medium #13): Split on chain operators ONLY outside of quoted strings.
  // A naive regex split would split `echo "hello && world"` into two segments.
  const chainParts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < remaining.length; i++) {
    const ch = remaining[i]!;
    const next = remaining[i + 1];
    const next2 = remaining[i + 2];

    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }

    if (!inSingle && !inDouble) {
      // &&
      if (ch === '&' && next === '&') { chainParts.push(current); current = ''; i++; continue; }
      // ||
      if (ch === '|' && next === '|') { chainParts.push(current); current = ''; i++; continue; }
      // |
      if (ch === '|') { chainParts.push(current); current = ''; continue; }
      // ;
      if (ch === ';') { chainParts.push(current); current = ''; continue; }
      // & (single, not &&)
      if (ch === '&' && next !== '&') { chainParts.push(current); current = ''; continue; }
    }
    current += ch;
  }
  if (current) chainParts.push(current);

  segments.push(...chainParts.map(s => s.trim()).filter(Boolean));

  return segments.filter(Boolean);
}

/**
 * Validate a command string against the allowlist and blocklist.
 * Each operator-separated segment is validated independently so that
 * chained commands cannot hide dangerous sub-commands behind an allowed prefix.
 * Returns { safe: true } or { safe: false, reason: string }.
 */
export function validateCommand(command: string): SafetyVerdict {
  const trimmed = command.trim();

  if (!trimmed) {
    return { safe: false, reason: 'Empty command.' };
  }

  // Split on chain operators — validate every segment independently
  const segments = splitOnOperators(trimmed);

  for (const segment of segments) {
    // Check blocklist first — takes priority over allowlist
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(segment)) {
        return {
          safe: false,
          reason: `Blocked pattern detected in segment "${segment}": ${pattern.source}`,
        };
      }
    }

    // Extract the base command (first word, strip path separators)
    const baseCommand = segment
      .split(/\s+/)[0]!
      .replace(/^.*[/\\]/, '') // strip directory prefix (e.g. /usr/bin/npm → npm)
      .toLowerCase();

    const allowed = ALLOWED_PREFIXES.has(baseCommand) ||
      ALLOWED_PREFIXES.has(baseCommand.replace(/\.exe$/, '')); // node.exe → node

    if (!allowed) {
      return {
        safe: false,
        reason: `"${baseCommand}" is not in the allowed command list.\nAllowed: ${[...ALLOWED_PREFIXES].join(', ')}`,
      };
    }
  }

  return { safe: true };
}

// ─── Permission Prompt ───────────────────────────────────────────────────

function renderCommandBox(block: CommandBlock, cwd: string): void {
  const width = Math.max(block.command.length + 4, 54);
  const bar   = '─'.repeat(width);

  console.log('');
  console.log(chalk.yellow(`  ┌─ Command Request ${'─'.repeat(Math.max(0, width - 17))}┐`));

  if (block.reason) {
    console.log(chalk.yellow('  │') + chalk.dim(` ${block.reason.padEnd(width - 1)}`) + chalk.yellow('│'));
    console.log(chalk.yellow(`  ├${'─'.repeat(width + 1)}┤`));
  }

  console.log(chalk.yellow('  │') + chalk.cyan(` ${block.command.padEnd(width - 1)}`) + chalk.yellow('│'));
  console.log(chalk.yellow('  │') + chalk.dim(`  cwd: ${cwd.padEnd(width - 7)}`) + chalk.yellow('│'));
  console.log(chalk.yellow(`  └${'─'.repeat(width + 1)}┘`));
  console.log('');
}

/**
 * Show the permission prompt and return true if the user approves.
 * In non-TTY / CI environments always returns false (safe default).
 * If `rl` is provided (REPL context) use it directly to avoid double-echo.
 */
async function askPermission(block: CommandBlock, cwd: string, rl?: import('readline').Interface): Promise<boolean> {
  // Never auto-execute in non-interactive environments (CI/piped input)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(chalk.yellow('  ⚠  Non-interactive environment — command skipped.'));
    console.log(chalk.dim(`     Skipped: ${block.command}`));
    return false;
  }

  renderCommandBox(block, cwd);

  const { askYesNo } = await import('../utils/prompt-utils.js');
  let result = false;
  if (rl) {
    result = await askYesNo(rl, chalk.magenta('  Run this command?'), false);
  } else {
    const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    result = await askYesNo(tempRl, chalk.magenta('  Run this command?'), false);
    tempRl.close();
  }
  return result;
}

// ─── Executor ────────────────────────────────────────────────────────────

/**
 * Run an approved command with streaming stdout/stderr output.
 * Returns the captured output and exit code.
 */
async function executeCommand(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const start = Date.now();

  return new Promise(resolve => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut  = false;

    // Use shell: true on Unix, but explicitly powershell.exe on Windows 
    // so that PowerShell cmdlets actually execute instead of failing in cmd.exe.
    const isWin = process.platform === 'win32';
    const child = spawn(command, [], {
      cwd,
      shell: isWin ? 'powershell.exe' : true,
      stdio: 'pipe',
      // Use a minimal env — never inherit secrets (AWS keys, DB passwords, tokens etc.)
      // from process.env into the child process. Only pass essentials for commands to work.
      env: {
        PATH:        process.env['PATH']        ?? '',
        HOME:        process.env['HOME']        ?? '',
        USERPROFILE: process.env['USERPROFILE'] ?? '',
        TEMP:        process.env['TEMP']        ?? '',
        TMP:         process.env['TMP']         ?? '',
        TMPDIR:      process.env['TMPDIR']      ?? '',
        SYSTEMROOT:  process.env['SYSTEMROOT']  ?? '',
        NODE_ENV:    process.env['NODE_ENV']    ?? '',
        FORCE_COLOR: '0',
      },
    });

    // FIX (High): Handle spawn 'error' event — fires when the shell binary doesn't
    // exist or can't be executed. Without this, the error becomes an unhandled
    // exception that crashes the Node.js process.
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode:   1,
        stdout:     stdoutBuf,
        stderr:     stderrBuf + `\nSpawn error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      console.log(chalk.yellow('\n  ⚠  Command timed out after 2 minutes — killed.'));
    }, COMMAND_TIMEOUT_MS);

    // Stream stdout live to terminal (dim, indented)
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf += text;
      process.stdout.write(
        text.split('\n').map(l => (l ? chalk.dim(`  ${l}`) : '')).join('\n'),
      );
    });

    // Stream stderr live to terminal (yellow, indented)
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      process.stderr.write(
        text.split('\n').map(l => (l ? chalk.yellow(`  ${l}`) : '')).join('\n'),
      );
    });

    child.on('close', exitCode => {
      clearTimeout(timer);
      const code = timedOut ? 124 : (exitCode ?? 1);
      resolve({
        exitCode: code,
        stdout:   stdoutBuf.slice(-4000), // keep last 4k — same cap as validation runner
        stderr:   stderrBuf.slice(-4000),
        durationMs: Date.now() - start,
      });
    });
  });
}

// ─── Audit Logger ────────────────────────────────────────────────────────

function logToDb(
  result: CommandResult,
  sessionId: number | null,
  taskId: number | null,
): void {
  try {
    getDb()
      .prepare(`
        INSERT INTO command_log
          (task_id, session_id, command, approved, exit_code, stdout, stderr, duration_ms, executed_at)
        VALUES
          (@task_id, @session_id, @command, @approved, @exit_code, @stdout, @stderr, @duration_ms, @executed_at)
      `)
      .run({
        task_id:     taskId,
        session_id:  sessionId,
        command:     result.command,
        approved:    result.approved ? 1 : 0,
        exit_code:   result.exitCode,
        stdout:      result.stdout   ?? null,
        stderr:      result.stderr   ?? null,
        duration_ms: result.durationMs,
        executed_at: Math.floor(result.executedAt / 1000), // store as unix seconds
      });
  } catch {
    // Audit log failure must never break the main flow
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface RunCommandOptions {
  cwd: string;
  sessionId: number | null;
  taskId: number | null;
  rl?: import('readline').Interface;
}

/**
 * Full pipeline: validate → prompt → execute → log → return result.
 *
 * Usage in start.ts after getting an LLM response:
 *
 *   const cmdBlocks = parseCommandBlocks(result.response);
 *   const cmdResults = await runCommandBlocks(cmdBlocks, { cwd, sessionId, taskId });
 */
export async function runCommandBlocks(
  blocks: CommandBlock[],
  opts: RunCommandOptions,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];

  for (const block of blocks) {
    const verdict = validateCommand(block.command);

    if (!verdict.safe) {
      // Show the rejection reason but never execute
      console.log('');
      console.log(chalk.red('  ✖  Command blocked by safety rules:'));
      console.log(chalk.dim(`     ${block.command}`));
      console.log(chalk.yellow(`     Reason: ${verdict.reason}`));
      console.log('');

      const denied: CommandResult = {
        command:     block.command,
        approved:    false,
        exitCode:    null,
        stdout:      '',
        stderr:      `Blocked: ${verdict.reason}`,
        durationMs:  0,
        executedAt:  Date.now(),
      };
      logToDb(denied, opts.sessionId, opts.taskId);
      results.push(denied);
      continue;
    }

    const approved = await askPermission(block, opts.cwd, opts.rl);

    if (!approved) {
      console.log(chalk.dim('  Skipped.'));

      const denied: CommandResult = {
        command:    block.command,
        approved:   false,
        exitCode:   null,
        stdout:     '',
        stderr:     '',
        durationMs: 0,
        executedAt: Date.now(),
      };
      logToDb(denied, opts.sessionId, opts.taskId);
      results.push(denied);
      continue;
    }

    // User approved — run it
    console.log(chalk.dim(`  $ ${block.command}`));
    console.log('');

    const exec = await executeCommand(block.command, opts.cwd);

    console.log('');
    if (exec.exitCode === 0) {
      console.log(chalk.green(`  ✔  Command completed in ${exec.durationMs}ms`));
    } else {
      console.log(chalk.red(`  ✖  Command exited with code ${exec.exitCode}`));
    }

    const cmdResult: CommandResult = {
      command:    block.command,
      approved:   true,
      exitCode:   exec.exitCode,
      stdout:     exec.stdout,
      stderr:     exec.stderr,
      durationMs: exec.durationMs,
      executedAt: Date.now(),
    };
    logToDb(cmdResult, opts.sessionId, opts.taskId);
    results.push(cmdResult);
  }

  return results;
}

/**
 * Format CommandResults into a compact string for injecting back into LLM context.
 *
 * Example output:
 *   [Command: npm install express]
 *   Exit: 0
 *   stdout: added 1 package in 2.3s
 */
export function formatCommandResultsForContext(results: CommandResult[]): string {
  if (results.length === 0) return '';

  return results
    .map(r => {
      if (!r.approved) {
        return `[Command: ${r.command}]\nStatus: declined by user or blocked by safety rules`;
      }
      const lines: string[] = [
        `[Command: ${r.command}]`,
        `Exit: ${r.exitCode ?? 'n/a'}`,
      ];
      if (r.stdout.trim()) lines.push(`stdout:\n${r.stdout.trim()}`);
      if (r.stderr.trim()) lines.push(`stderr:\n${r.stderr.trim()}`);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
}
