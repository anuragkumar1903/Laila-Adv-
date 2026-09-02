import readline from 'readline';
import path from 'path';
import chalk from 'chalk';
import { pathExists } from '../../utils/fs-utils.js';
import { isGitRepo, getGitRemote } from '../../utils/git-utils.js';
import { scanProject } from '../../scanner/scanner.js';
import { buildProjectIndex, writeProjectIndex } from '../../scanner/project-index.js';
import { upsertProject, findByPath } from '../../memory/repositories/projects.js';
import { bulkUpsertFiles } from '../../memory/repositories/indexes.js';
import { updateLastScanned } from '../../memory/repositories/projects.js';
import { createSession, endSession } from '../../memory/repositories/sessions.js';
import { run as orchestrate } from '../../orchestrator/orchestrator.js';
import { getProvider, setProvider, resetProvider } from '../../llm/provider-factory.js';
import { loadProviderConfig, isConfigComplete } from '../../config/config-loader.js';
import { runSetupWizard, askChangeProvider, switchProvider } from '../../llm/setup-wizard.js';
import type { LLMProvider } from '../../llm/providers/base.js';
import { printer } from '../ui/printer.js';
import { spinner, setRl } from '../ui/spinner.js';
import type { ScannedFile } from '../../types.js';
import { runToolChecks } from '../../system/tool-checks.js';
import { installTool } from '../../system/installer.js';
import { parseCodeBlocks, generateAndPromptDiff } from '../../editor/diff-editor.js';
import { parseCommandBlocks, runCommandBlocks, formatCommandResultsForContext } from '../../tools/shell-tool.js';
import { runGitBlocks } from '../../tools/git-tool.js';
import { runWebBlocks } from '../../tools/web-tool.js';
import { triggerN8nWebhook } from '../../utils/n8n-webhook.js';
import { SKILLS_DIR } from '../../config.js';

async function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const { askQuestion } = await import('../../utils/prompt-utils.js');
  const answer = await askQuestion(rl, prompt);
  rl.close();
  return answer;
}

async function promptYesNo(prompt: string): Promise<boolean> {
  const answer = await promptLine(prompt);
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

function looksLikeCliCommand(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized.startsWith('laila-cli') || normalized.startsWith('npm ') || normalized.startsWith('node ') || normalized.startsWith('/');
}

/** Project root markers — checked in order of confidence. */
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'project-index.json',
  'Brain.md',
  'BRAIN.md',
  'tsconfig.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  '.laila',
];

async function checkForUpdates() {
  try {
    // FIX (High + Low): Use execFile (not exec) so the package name is passed as an
    // argument array, never shell-interpolated. A malicious `"name": "foo; curl ..."` 
    // in package.json cannot inject shell commands this way.
    // Also: import these at module scope instead of re-importing inside the function
    // (Ponytail: removes redundant dynamic imports).
    const { execFile } = await import('child_process');
    const { promisify }   = await import('util');
    const { readFile, stat, writeFile } = await import('fs/promises');
    const pathMod = await import('path');
    const os      = await import('os');
    
    // Ponytail Throttle: Only check once every 24 hours to avoid slowing down startup
    const marker = pathMod.join(os.homedir(), '.laila', '.last_update_check');
    try {
      const stats = await stat(marker);
      if (Date.now() - stats.mtimeMs < 24 * 60 * 60 * 1000) return;
    } catch {}
    
    const execFileAsync = promisify(execFile);
    
    const pkgPath = new URL('../../package.json', import.meta.url);
    const { version, name } = JSON.parse(await readFile(pkgPath, 'utf8'));

    // Validate name looks like a real npm package name before using it
    if (typeof name !== 'string' || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return;

    // FIX: execFile passes name as a discrete argument — not interpolated in a shell
    const { stdout } = await execFileAsync('npm', ['show', name, 'version'], { timeout: 2000 });
    
    const latestVersion = stdout.trim();
    if (latestVersion && latestVersion !== version && !latestVersion.includes('ERR')) {
      printer.blank();
      printer.warn(`🚀 UPDATE AVAILABLE! ${version} -> ${latestVersion}`);
      printer.info(`Run "npm install -g ${name}" to update to the latest version.`);
      printer.blank();
    }
    
    await writeFile(marker, Date.now().toString());
  } catch (e) {
    // Ignore errors silently
  }
}

/** Check if `dir` looks like a project root. */
async function isProjectRoot(dir: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if (await pathExists(path.join(dir, marker))) return true;
  }
  return false;
}

/**
 * Resolve the project path automatically:
 * 1. Check CWD first (most common case — user runs laila-cli inside project)
 * 2. Walk up parent directories (like git does from a subdirectory)
 * Stops at the filesystem root to avoid infinite loops.
 */
async function resolveInitialProjectPath(): Promise<string | null> {
  let dir = process.cwd();

  while (true) {
    if (await isProjectRoot(dir)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return null;
}

export async function startCommand(): Promise<void> {
  printer.banner();
  
  // Non-blocking fire-and-forget update check
  checkForUpdates();

  // ── System preflight ──────────────────────────────────────────────────
  spinner.start('Checking system readiness…');
  const toolChecks = await runToolChecks();
  spinner.succeed('System check complete');

  printer.table(toolChecks.map(tool => [
    tool.name,
    tool.status === 'available'
      ? (tool.details ?? 'Available')
      : (tool.installHint ?? 'Missing'),
  ]));
  printer.blank();

  for (const tool of toolChecks) {
    if (tool.status !== 'missing' || !tool.installable || !tool.installHint) continue;
    // Skip optional tools — don't prompt to install them at startup
    if (tool.optional) continue;
    const shouldInstall = await promptYesNo(`Install ${tool.name} now? [y/N]: `);
    if (!shouldInstall) continue;

    if (tool.installCommand) {
      spinner.start(`Installing ${tool.name}…`);
      const result = await installTool(tool.installCommand);
      if (result.success) {
        spinner.succeed(`${tool.name} installed`);
      } else {
        spinner.fail(`${tool.name} install failed`);
        printer.error(result.output || `Unable to install ${tool.name}.`);
      }
      continue;
    }

    if (tool.name === 'Node.js') {
      printer.info('Node.js can be installed with winget, choco, scoop, or the official installer.');
      continue;
    }

    if (tool.name === 'Git') {
      printer.info('Git can be installed with winget, choco, scoop, or the official installer.');
    }
  }

  // ── LLM Provider setup ────────────────────────────────────────────────
  let activeProvider: LLMProvider;
  const existingConfig = await loadProviderConfig(process.cwd());

  if (isConfigComplete(existingConfig)) {
    // Config exists — show current provider and optionally let user change it
    printer.info(`Provider: ${existingConfig.provider}  │  Model: ${existingConfig.model}`);
    const wantsChange = await askChangeProvider();
    if (wantsChange) {
      resetProvider();
      activeProvider = await runSetupWizard(process.cwd());
      setProvider(activeProvider);
    } else {
      activeProvider = await getProvider(process.cwd());
    }
  } else {
    // First run — launch the setup wizard
    activeProvider = await runSetupWizard(process.cwd());
    setProvider(activeProvider);
  }

  // Verify provider is reachable
  spinner.start('Checking provider connection…');
  const providerAlive = await activeProvider.healthCheck();
  if (!providerAlive) {
    spinner.fail(`Cannot reach the LLM provider. Check your connection or API key, then try again.`);
    process.exit(1);
  }
  spinner.succeed('Provider ready');

  // ── Project path ─────────────────────────────────────────────────────
  let projectPath = await resolveInitialProjectPath();
  let isGlobalMode = false;

  if (projectPath) {
    printer.info(`Using resolved project root: ${projectPath}`);
  } else {
    isGlobalMode = true;
    projectPath = process.cwd();
    printer.info('No project markers detected. Running in global assistant mode.');
  }

  if (!await pathExists(projectPath)) {
    printer.error(`Path does not exist: ${projectPath}`);
    if (looksLikeCliCommand(projectPath)) {
      printer.info('That looks like a command, not a folder path. Run commands in the terminal after start, and enter a project folder here.');
    }
    process.exit(1);
  }

  const isGit = await isGitRepo(projectPath);
  if (!isGit && !isGlobalMode) printer.warn('No git repository detected — continuing without VCS context.');

  // ── Scan or load ─────────────────────────────────────────────────────
  let projectId: number | null = null;

  if (isGlobalMode) {
    spinner.succeed('Ready');
  } else {
    spinner.start('Loading project…');
    const existing = findByPath(projectPath);

    if (existing?.last_scanned) {
      spinner.succeed(`Project loaded from index (last scanned: ${new Date(existing.last_scanned * 1000).toLocaleString()})`);
      projectId = existing.id;
    } else {
      spinner.update('Scanning project files…');
      const scan   = await scanProject(projectPath);
      spinner.update(`Indexing ${scan.totalFiles} files…`);

      const gitRemote = await getGitRemote(projectPath);
      const project   = upsertProject({
        name:        scan.projectName,
        path:        projectPath,
        git_remote:  gitRemote,
        framework:   scan.framework,
        languages:   JSON.stringify(scan.languages),
        pkg_manager: scan.pkgManager,
      });
      projectId = project.id;

      bulkUpsertFiles(projectId, scan.files.map((f: ScannedFile) => ({
        relPath:  f.relPath,
        category: f.category,
        language: f.language,
        sizeBytes: f.sizeBytes,
      })));

      const index = buildProjectIndex(projectId, projectPath, scan);
      await writeProjectIndex(projectPath, index);
      updateLastScanned(projectId);

      spinner.succeed(`Scanned ${scan.totalFiles} files`);

      printer.blank();
      printer.table([
        ['Framework',  scan.framework   ?? 'unknown'],
        ['Languages',  scan.languages.join(', ') || 'unknown'],
        ['Pkg manager',scan.pkgManager  ?? 'unknown'],
        ['Git remote', scan.gitRemote   ?? 'none'],
      ]);
    }
    
    // Ponytail Phase 14: Zero-Bloat File Watcher
    try {
      const fs = await import('fs');
      // native fs.watch is fast, avoids chokidar dependencies
      // we just debounce it heavily so it doesn't thrash on node_modules
      let debounceTimer: NodeJS.Timeout | null = null;
      fs.watch(projectPath, { recursive: true }, (eventType, filename) => {
        if (!filename || filename.includes('node_modules') || filename.includes('.git')) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          // silently trigger re-scan for just this file or full project if needed
          // to stay fast, we'll just trigger a lightweight scan block here
          try {
            const { scanProject } = await import('../../scanner/scanner.js');
            await scanProject(projectPath); // scan is heavily cached in sqlite anyway
          } catch {}
        }, 5000);
      });
      printer.dim('  ⚡ Real-time file watcher active (Phase 14)');
    } catch (e) {
      printer.dim('  ⚠ File watcher failed to start');
    }
  }

  // ── Session ───────────────────────────────────────────────────────────
  const { findLatestActiveSession } = await import('../../memory/repositories/sessions.js');
  let session = findLatestActiveSession();
  
  if (session && session.project_id === projectId) {
    printer.blank();
    const resume = await promptYesNo(`Resume active session (started ${new Date(session.started_at * 1000).toLocaleString()})? [Y/n]: `);
    if (!resume) {
      endSession(session.id);
      session = createSession(projectId);
    } else {
      printer.success(`Resumed session ${session.id}`);
    }
  } else {
    if (session) endSession(session.id);
    session = createSession(projectId);
  }

  let previousTaskId: number | undefined;
  
  // Try to find the latest task for this session to restore previousTaskId
  const { getDb } = await import('../../memory/db.js');
  const lastTask = getDb().prepare('SELECT id FROM tasks WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(session.id) as { id: number } | undefined;
  if (lastTask) {
    previousTaskId = lastTask.id;
  }

  printer.blank();
  printer.info('Type your request. Type /help for available commands.');
  printer.blank();

  // ── Prompt queue & MCP ────────────────────────────────────────────────
  const promptQueue: string[] = [];
  let queueRunning = false;
  let autoFixCount = 0;
  let mcpManager: import('../../mcp/mcp-client.js').MCPClientManager | null = null;
  try {
    const { MCPClientManager } = await import('../../mcp/mcp-client.js');
    mcpManager = new MCPClientManager();
    if (projectPath) {
      await mcpManager.loadConfig(path.join(projectPath, '.laila', 'mcp.json'));
      await mcpManager.connectAllFromConfig();
    }
  } catch (e) {
    // Ignore initialization errors for MCP
  }

  function updatePrompt(): void {
    const depth = promptQueue.length;
    const label = depth > 0
      ? chalk.magenta(`  laila[+${depth}]> `)
      : chalk.magenta('  laila> ');
    rl.setPrompt(label);
  }

  async function runPrompt(userMessage: string): Promise<void> {
    try {
      const startMs = Date.now();
      spinner.start('Thinking…');
      
      let finalMessage = userMessage;
      
      const { readGlobalMemory } = await import('../../memory/episodic.js');
      const globalMem = await readGlobalMemory();
      if (globalMem.trim()) {
        finalMessage += `\n\n[SYSTEM: GLOBAL EPISODIC MEMORY (Remember these user preferences/facts)]\n${globalMem}`;
      }

      if (mcpManager) {
        await mcpManager.checkAutoTriggers(userMessage);
        if (mcpManager.tools.length > 0) {
          finalMessage += `\n\n[SYSTEM: You are connected to an MCP server. You may call its tools by returning a markdown block like this:\n\`\`\`mcp\n{\n  "serverName": "name_here",\n  "name": "tool_name",\n  "args": { "param": "value" }\n}\n\`\`\`\n\nAvailable tools:\n${JSON.stringify(mcpManager.tools, null, 2)}]`;
        }
      }

      const result = await orchestrate({
        userMessage: finalMessage,
        sessionId: session!.id,
        projectId,
        previousTaskId,
      });
      spinner.stop();
      const durationMs = Date.now() - startMs;

      previousTaskId = result.taskId;
      printer.response(result.response);

      if (result.tokensUsed) {
        printer.tokenUsage(result.tokensUsed, durationMs);
      } else {
        printer.dim(`⏱ ${printer.elapsed(startMs)}`);
      }

      // ── Convert Native Tool Calls to Markdown Blocks ────────────────
      if (result.toolCalls && result.toolCalls.length > 0) {
        let fakeMarkdown = '';
        for (const tc of result.toolCalls) {
          if (tc.name === 'read_file') {
            for (const f of tc.arguments.files || []) {
              fakeMarkdown += `\n\`\`\`read\nfile: ${f}\n\`\`\`\n`;
            }
          } else if (tc.name === 'write_file') {
            fakeMarkdown += `\n\`\`\`write\nfile: ${tc.arguments.file}\ncontent: |\n${tc.arguments.content}\n\`\`\`\n`;
          } else if (tc.name === 'patch_file') {
            fakeMarkdown += `\n\`\`\`patch\nfile: ${tc.arguments.file}\nfind:\n${tc.arguments.find}\nreplace:\n${tc.arguments.replace}\n\`\`\`\n`;
          } else if (tc.name === 'grep_search') {
            fakeMarkdown += `\n\`\`\`grep\npattern: ${tc.arguments.pattern}\npath: ${tc.arguments.path || '.'}\n\`\`\`\n`;
          } else if (tc.name === 'run_command') {
            fakeMarkdown += `\n\`\`\`cmd\n${tc.arguments.command}\n\`\`\`\n`;
          } else if (tc.name === 'git_command') {
            fakeMarkdown += `\n\`\`\`git\naction: ${tc.arguments.action}\nargs: ${tc.arguments.args || ''}\n\`\`\`\n`;
          } else if (tc.name === 'browser_action') {
            fakeMarkdown += `\n\`\`\`browser\nurl: ${tc.arguments.url}\naction: ${tc.arguments.action}\n\`\`\`\n`;
          } else if (tc.name === 'web_search') {
            fakeMarkdown += `\n\`\`\`search\nquery: ${tc.arguments.query}\n\`\`\`\n`;
          } else if (tc.name === 'web_read_url') {
            fakeMarkdown += `\n\`\`\`url\nurl: ${tc.arguments.url}\n\`\`\`\n`;
          }
        }
        result.response += fakeMarkdown;
      }

      // ── Sequential Tool Router ───────────────────────────────────────
      const { runBrowserTool, parseBrowserBlocks } = await import('../../tools/browser-tool.js');
      const { parseAllBlocks } = await import('../../utils/markdown-parser.js');
      const allBlocks = parseAllBlocks(result.response);
      
      let filesWritten = 0;
      const contextSuffixes: string[] = [];

      for (const block of allBlocks) {
        if (block.language.match(/^(typescript|javascript|python|css|html|json|yaml|md|ts|js|jsx|tsx)$/)) {
          const fileBlocks = parseCodeBlocks(block.raw);
          if (fileBlocks.length > 0) {
            filesWritten += await generateAndPromptDiff(projectPath!, fileBlocks, rl);
          }
        } 
        else if (['cmd', 'bash', 'sh'].includes(block.language)) {
          const cmdBlocks = parseCommandBlocks(block.raw);
          if (cmdBlocks.length > 0) {
            const cmdRes = await runCommandBlocks(cmdBlocks, { cwd: projectPath!, sessionId: session!.id, taskId: result.taskId, rl });
            const sfx = formatCommandResultsForContext(cmdRes);
            if (sfx) contextSuffixes.push(sfx);
          }
        }
        else if (['read', 'write', 'create'].includes(block.language)) {
          const { runFileBlocks } = await import('../../tools/file-tool.js');
          const fileRes = await runFileBlocks(block.raw, { projectRoot: projectPath! });
          if (fileRes.readContext) contextSuffixes.push(fileRes.readContext);
          if (fileRes.writeContext) contextSuffixes.push(fileRes.writeContext);
        }
        else if (['patch', 'grep'].includes(block.language)) {
          const { runGrepPatchBlocks } = await import('../../tools/grep-tool.js');
          const gpRes = await runGrepPatchBlocks(block.raw, { projectRoot: projectPath!, rl });
          if (gpRes.grepContext) contextSuffixes.push(gpRes.grepContext);
          if (gpRes.patchContext) contextSuffixes.push(gpRes.patchContext);
        }
        else if (block.language === 'git') {
          const gitRes = await runGitBlocks(block.raw, projectPath!);
          if (gitRes.gitContext) contextSuffixes.push(gitRes.gitContext);
        }
        else if (block.language === 'browser') {
          const bBlocks = parseBrowserBlocks(block.raw);
          for (const b of bBlocks) {
             const res = await runBrowserTool(projectPath!, b);
             contextSuffixes.push(res);
          }
        }
        else if (block.language === 'search' || block.language === 'url') {
          const webRes = await runWebBlocks(block.raw);
          if (webRes.webContext) contextSuffixes.push(webRes.webContext);
        }
        else if (block.language === 'mcp' && mcpManager) {
          try {
            const parsed = JSON.parse(block.content);
            const srv = parsed.serverName || 'default';
            const toolName = parsed.name || parsed.tool;
            spinner.start(`Calling MCP tool ${toolName} on ${srv}…`);
            const mcpRes = await mcpManager.callTool(srv, toolName, parsed.args);
            spinner.stop();
            contextSuffixes.push(`=== MCP Tool Result (${srv}:${toolName}) ===\n${JSON.stringify(mcpRes, null, 2)}`);
          } catch (e: any) {
            spinner.fail();
            contextSuffixes.push(`=== MCP Tool Error ===\n${e.message}`);
          }
        }
      }

      if (contextSuffixes.length > 0) {
        printer.warn('Tools executed. Asking Laila to process the output…');
        spinner.start('Thinking…');
        const followUp = await orchestrate({
          userMessage: `The following tools ran after your previous response. Review the output and continue:\n\n${contextSuffixes.join('\n\n')}`,
          sessionId: session!.id,
          projectId,
          previousTaskId: result.taskId,
        });
        spinner.stop();
        previousTaskId = followUp.taskId;
        printer.response(followUp.response);
        
        // Very basic recursion for just files if the follow-up generated files directly
        const followUpBlocks = parseCodeBlocks(followUp.response);
        if (followUpBlocks.length > 0) {
          filesWritten += await generateAndPromptDiff(projectPath!, followUpBlocks, rl);
        }
      } else {
        previousTaskId = result.taskId;
      }

      // ── Validation ───────────────────────────────────────────────────
      if (filesWritten > 0 && projectId !== null) {
        const { findById } = await import('../../memory/repositories/projects.js');
        const { runValidation } = await import('../../validation/validator.js');
        const project = findById(projectId);
        if (project) {
          spinner.start('Running validation…');
          const validation = await runValidation(project.path, project.pkg_manager ?? 'npm');
          spinner.stop();
          printer.validationReport(validation.results);
          if (!validation.success) {
            if (autoFixCount < 3) {
              autoFixCount++;
              printer.warn(`Auto-healing... (Attempt ${autoFixCount} of 3). Queueing fix prompt.`);
              const errorLogs = validation.results.filter(r => !r.success).map(r => `[${r.step}] Failed:\n${r.stdout}\n${r.stderr}`).join('\n\n');
              promptQueue.unshift(`[Auto-Fix]: The code you just wrote failed validation. Here are the compiler/linter errors:\n\n${errorLogs}\n\nPlease fix the files you edited to resolve these errors.`);
              updatePrompt();
              // Kick off drainQueue if it's not running
              if (!queueRunning) {
                setTimeout(drainQueue, 100);
              }
            } else {
              printer.warn('Validation failed 3 times. Giving up on auto-heal.');
              triggerN8nWebhook({
                event: 'validation_failed',
                projectId,
                taskId: previousTaskId,
                message: 'Code validation failed after file edits (auto-heal exhausted)',
                details: validation.results,
              }).catch(() => {}); // FIX (Low #29): explicit no-op catch instead of void operator
            }
          } else {
            triggerN8nWebhook({
              event: 'task_completed',
              projectId,
              taskId: previousTaskId,
              message: 'Task completed and validated successfully',
            }).catch(() => {}); // FIX (Low #29): explicit no-op catch instead of void operator
          }
        }
      } else {
        // If no files were written, task is still done
        triggerN8nWebhook({
          event: 'task_completed',
          projectId,
          taskId: previousTaskId,
          message: 'Task completed (no file edits)',
        }).catch(() => {}); // FIX (Low #29): explicit no-op catch instead of void operator
      }
    } catch (err: unknown) {
      spinner.fail();
      const msg = err instanceof Error ? err.message : String(err);
      printer.error(msg);
      triggerN8nWebhook({
        event: 'task_failed',
        projectId,
        taskId: previousTaskId,
        message: msg,
      }).catch(() => {}); // FIX (Low #29): explicit no-op catch instead of void operator
    }
  }

  /** Drain the queue sequentially. Shows next prompt label between tasks. */
  async function drainQueue(): Promise<void> {
    if (queueRunning) return;
    queueRunning = true;

    while (promptQueue.length > 0) {
      const next = promptQueue.shift()!;
      updatePrompt();

      if (promptQueue.length > 0) {
        printer.dim(`  ▶ Running queued prompt (${promptQueue.length} remaining after this)`);
      }

      await runPrompt(next);
      updatePrompt();
    }

    queueRunning = false;
    rl.prompt();
  }

  // ── REPL ──────────────────────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    printer.error('Interactive mode requires a real terminal (TTY).');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
    prompt:   chalk.magenta('  laila> '),
  });

  let autoApprove = false;

  /** Ask a question using the existing rl — avoids double-echo from nested interfaces. */
  async function rlAsk(promptText: string): Promise<string> {
    if (autoApprove && promptText.includes('[Y/n]')) {
      printer.dim(`  Auto-approved: ${promptText}`);
      return 'y';
    }
    const { confirm, text } = await import('@clack/prompts');
    rl.pause();
    let res: any;
    if (promptText.includes('[Y/n]')) {
      const ans = await confirm({ message: promptText.replace(' [Y/n]', '') });
      res = ans ? 'y' : 'n';
    } else {
      res = await text({ message: promptText });
    }
    rl.resume();
    return res as string;
  }

  rl.prompt();
  process.stdin.resume();
  setRl(rl);

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    const normalized = line.toLowerCase();

    // Redraw the input as a clean user message (remove prompt prefix, keep text)
    if (process.stdout.isTTY) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
      if (line) process.stdout.write(chalk.bold.white(`  > ${line}\n`));
    }

    if (!line) { rl.resume(); rl.prompt(); return; }
    
    // FIX (High): Only reset autoFixCount for genuine user-initiated messages,
    // NOT for /interrupt (which pushes to the front of a running queue and would
    // reset the counter mid-auto-heal loop, enabling infinite retries).
    // Also do NOT reset if the queue is actively draining auto-fix prompts.
    if (!normalized.startsWith('/interrupt') && !normalized.startsWith('.interrupt')) {
      autoFixCount = 0;
    }

    // If queue is already running, just enqueue and return
    if (queueRunning && !normalized.startsWith('/') && !normalized.startsWith('.')) {
      promptQueue.push(line);
      updatePrompt();
      printer.dim(`  ✚ Queued (${promptQueue.length} pending)`);
      rl.prompt();
      return;
    }

    if (normalized === '.exit' || normalized === '.quit' || normalized === '/exit' || normalized === '/quit') {
      rl.close();
      return;
    }

    if (normalized === '/help' || normalized === '.help') {
      printer.helpMenu();
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '/auto' || normalized === '.auto') {
      autoApprove = !autoApprove;
      if (autoApprove) {
        printer.success('Auto-Approve is ON. Laila will no longer ask for permission (Y/n).');
      } else {
        printer.warn('Auto-Approve is OFF. Laila will ask for permission (Y/n) again.');
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized.startsWith('/plan ') || normalized.startsWith('.plan ')) {
      const goal = line.slice(6).trim();
      if (!goal) {
        printer.error('Please specify a goal. Example: /plan Create a new login component');
        rl.resume(); rl.prompt(); return;
      }
      
      const { generatePlan } = await import('../../orchestrator/planner.js');
      spinner.start('Planning tasks...');
      try {
        const plan = await generatePlan(goal, projectPath, projectId);
        spinner.succeed('Plan generated');
        printer.blank();
        printer.section('Execution Plan');
        plan.forEach((step, i) => {
          printer.info(`${i + 1}. ${step}`);
        });
        
        const proceed = await rlAsk('Proceed with this plan? [Y/n]: ');
        if (proceed.toLowerCase() !== 'n') {
          for (const step of plan) {
             promptQueue.push(step);
          }
          printer.success(`Added ${plan.length} steps to queue.`);
          drainQueue(); // async fire-and-forget
        } else {
          printer.dim('Plan discarded.');
        }
      } catch (err) {
        spinner.fail('Planning failed');
        printer.error(String(err));
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '/paste' || normalized === '.paste') {
      try {
        spinner.start('Reading clipboard...');
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    $path = "$env:TEMP\\laila_clip.png"
    $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "IMAGE:$path"
} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
    Write-Output "TEXT:$([System.Windows.Forms.Clipboard]::GetText())"
}`;
        const { writeFile } = await import('fs/promises');
        const os = await import('os');
        const psPath = path.join(os.tmpdir(), 'laila_paste.ps1');
        await writeFile(psPath, psScript);
        
        const { stdout } = await execAsync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`);
        const result = stdout.trim();
        
        if (result.startsWith('IMAGE:')) {
          const imgPath = result.slice(6).trim();
          spinner.succeed('Pasted image from clipboard');
          printer.info(`Saved to: ${imgPath}`);
          
          const followUp = await rlAsk('What do you want me to do with this image? ');
          if (followUp) {
            // Assume Phase 9 vision tools can read this path if we pass it in the prompt
            promptQueue.push(`${followUp}\n\n[Attached Image]: ${imgPath}`);
            drainQueue();
          }
        } else if (result.startsWith('TEXT:')) {
          const text = result.slice(5).trim();
          spinner.succeed('Pasted text from clipboard');
          printer.info(`\nClipboard content:\n${text.slice(0, 100)}... (truncated)`);
          
          const followUp = await rlAsk('What do you want me to do with this? ');
          if (followUp) {
            promptQueue.push(`${followUp}\n\nClipboard context:\n${text}`);
            drainQueue();
          }
        } else {
          spinner.fail('Clipboard is empty or contains non-text data.');
        }
      } catch (err: any) {
        spinner.fail('Failed to read clipboard');
        printer.error(String(err));
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '/commit' || normalized === '.commit') {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        spinner.start('Checking git diff...');
        const { stdout: diff } = await execAsync('git diff', { cwd: projectPath });
        const { stdout: stagedDiff } = await execAsync('git diff --cached', { cwd: projectPath });
        
        const totalDiff = diff + '\n' + stagedDiff;
        if (!totalDiff.trim()) {
          spinner.fail('No changes to commit.');
          rl.resume(); rl.prompt(); return;
        }
        
        spinner.update('Generating semantic commit message...');
        const { chat } = await import('../../llm/provider-factory.js');
        const result = await chat([
          { role: 'system', content: 'You are a git expert. Write a strict, single-line semantic commit message based on the diff. No quotes, no markdown, no explanation. Just the message.' },
          { role: 'user', content: totalDiff.slice(0, 4000) } // trunc to fit
        ], { temperature: 0.1 });
        
        const commitMsg = result.content.trim().replace(/^"|"$/g, '');
        spinner.stop();
        
        const proceed = await rlAsk(`Commit with message: "${commitMsg}"? [Y/n]: `);
        if (proceed.toLowerCase() !== 'n') {
          spinner.start('Committing...');
          await execAsync('git add .', { cwd: projectPath });
          await execAsync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: projectPath });
          spinner.succeed(`Committed: ${commitMsg}`);
        } else {
          printer.dim('Commit cancelled.');
        }
      } catch (err: any) {
        spinner.fail('Commit failed');
        printer.error(err.message || String(err));
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized.startsWith('/pipeline ') || normalized.startsWith('.pipeline ')) {
      const goal = line.slice(10).trim();
      if (!goal) {
        printer.error('Please specify a goal. Example: /pipeline Build a user auth feature');
        rl.resume(); rl.prompt(); return;
      }
      
      printer.section('Sub-Agent Pipeline');
      printer.info('1. [Researcher] Research best practices and find context');
      printer.info('2. [Coder] Write the code based on the context');
      printer.info('3. [Reviewer] Audit the changes for style and security');
      
      const proceed = await rlAsk('Launch pipeline? [Y/n]: ');
      if (proceed.toLowerCase() !== 'n') {
        promptQueue.push(`/research I need to build this, but first research the best approach and gather relevant file context. Goal: ${goal}`);
        promptQueue.push(`/code Implement the code changes for this goal based on the previous research. Goal: ${goal}`);
        promptQueue.push(`/review Audit the code changes you just made for security, style, and correctness. Goal: ${goal}`);
        
        printer.success('Pipeline launched (3 agents queued).');
        drainQueue(); // async fire-and-forget
      } else {
        printer.dim('Pipeline cancelled.');
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized.startsWith('/swarm ') || normalized.startsWith('.swarm ')) {
      const goal = line.slice(7).trim();
      if (!goal) {
        printer.error('Please specify a goal. Example: /swarm Refactor the database layer');
        rl.resume(); rl.prompt(); return;
      }
      
      printer.section('Parallel Agent Swarm');
      printer.info('Spawning 3 parallel Researchers...');
      
      try {
        spinner.start('Swarm thinking (running 3 agents concurrently)...');
        const { run } = await import('../../orchestrator/orchestrator.js');
        
        // Run 3 agents in parallel!
        const [res1, res2, res3] = await Promise.all([
          run({ userMessage: `/research Find all database models related to: ${goal}`, sessionId: session!.id, projectId, previousTaskId }),
          run({ userMessage: `/research Find all API routes related to: ${goal}`, sessionId: session!.id, projectId, previousTaskId }),
          run({ userMessage: `/research Find all tests related to: ${goal}`, sessionId: session!.id, projectId, previousTaskId })
        ]);
        
        spinner.succeed('Swarm completed parallel research.');
        
        const mergedContext = `=== Swarm Research ===\n\nModels: ${res1.response}\n\nRoutes: ${res2.response}\n\nTests: ${res3.response}`;
        printer.info('Merging context and passing to Coder...');
        
        promptQueue.push(`/code Goal: ${goal}\n\nContext from Swarm:\n${mergedContext}`);
        drainQueue();
      } catch (err) {
        spinner.fail('Swarm failed');
        printer.error(String(err));
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '.status' || normalized === '/status') {
      const cfg = await loadProviderConfig(projectPath);
      printer.section('Session Info');
      printer.table([
        ['Session',  String(session.id)],
        ['Project',  projectPath],
        ['Tasks',    String(previousTaskId ?? 0)],
        ['Provider', activeProvider.id],
        ['Model',    cfg.model ?? activeProvider.displayName],
        ['Queue',    String(promptQueue.length)],
      ]);
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '/git' || normalized === '.git') {
      const { getGitStatus: gitSt, getGitBranch } = await import('../../utils/git-utils.js');
      const [status, branch] = await Promise.all([gitSt(projectPath), getGitBranch(projectPath)]);
      printer.section(`Git (${branch ?? 'no branch'})`);
      if (status) {
        printer.gitSummary(status);
      } else {
        printer.warn('Not a Git repository.');
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '/commit' || normalized === '.commit') {
      const { getGitStaged, commitChanges, getGitBranch } = await import('../../utils/git-utils.js');
      const staged = await getGitStaged(projectPath);
      if (!staged) {
        printer.warn('Nothing staged. Use `git add` to stage files before committing.');
        rl.resume(); rl.prompt(); return;
      }
      printer.section('Staged Changes');
      staged.split('\n').filter(Boolean).forEach(l => printer.dim(`  ${l}`));
      printer.blank();
      const branch = await getGitBranch(projectPath);
      const msg = await rlAsk(`Commit message (branch: ${branch ?? 'unknown'}): `);
      if (!msg.trim()) {
        printer.warn('Commit cancelled — empty message.');
        rl.resume(); rl.prompt(); return;
      }
      const ok = await commitChanges(projectPath, msg.trim());
      if (ok) {
        printer.success(`Committed: "${msg.trim()}"`);
      } else {
        printer.error('Commit failed. Check git output above.');
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '/scan' || normalized === '.scan') {
      if (isGlobalMode) {
        printer.warn('Cannot scan in global mode. Please run inside a project directory.');
      } else {
        spinner.start('Re-scanning project files…');
        const scan = await scanProject(projectPath);
        spinner.succeed(`Re-scanned ${scan.totalFiles} files (${scan.reusedFiles} reused)`);
      }
      rl.resume(); rl.prompt(); return;
    }

    if (normalized === '.clear' || normalized === '/clear') {
      console.clear();
      printer.banner();
      printer.dim(`Session ${session.id}  •  ${path.basename(projectPath)}  •  ${activeProvider.id}`);
      printer.blank();
      rl.resume(); rl.prompt(); return;
    }

    // ── /swarm ────────────────────────────────────────────────────────────
    if (normalized.startsWith('/swarm ')) {
      const parts = line.slice(7).split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) {
        printer.warn('Usage: /swarm <agent 1 task> | <agent 2 task> | ...');
        rl.resume(); rl.prompt(); return;
      }
      printer.info(`Spawning ${parts.length} concurrent sub-agents...`);
      rl.pause();
      
      try {
        const startMs = Date.now();
        // Run all parts concurrently
        const swarmResults = await Promise.all(parts.map(async (task, idx) => {
          const res = await orchestrate({
            userMessage: `[Sub-Agent ${idx + 1} Task]: ${task}`,
            sessionId: session!.id,
            projectId,
            previousTaskId,
          });
          return `=== Sub-Agent ${idx + 1} Result ===\n${res.response}`;
        }));
        
        const durationMs = Date.now() - startMs;
        printer.success(`Swarm completed in ${printer.elapsed(startMs)}`);
        
        // Push the merged results into the prompt queue for the main agent to review
        const merged = `[SYSTEM: Swarm execution completed. Review the parallel outputs below and finalize the goal.]\n\n${swarmResults.join('\n\n')}`;
        promptQueue.push(merged);
        await drainQueue();
      } catch (err: any) {
        printer.error(`Swarm failed: ${err.message}`);
      }
      return;
    }

    // ── /remember ─────────────────────────────────────────────────────────
    if (normalized.startsWith('/remember ')) {
      const fact = line.slice(10).trim();
      if (!fact) {
        printer.warn('Usage: /remember <fact or preference>');
        rl.resume(); rl.prompt(); return;
      }
      const { rememberFact } = await import('../../memory/episodic.js');
      await rememberFact(fact);
      printer.success('Fact saved to Global Episodic Memory.');
      rl.resume(); rl.prompt(); return;
    }

    // ── /look ─────────────────────────────────────────────────────────────
    if (normalized.startsWith('/look ')) {
      const match = line.match(/^\/look\s+([^\s]+)(?:\s+(.*))?$/);
      if (!match) {
        printer.warn('Usage: /look <path/to/image.png> [optional prompt]');
        rl.resume(); rl.prompt(); return;
      }
      const imgPath = match[1]!;
      const prompt = match[2] ?? 'Describe this image in detail.';
      spinner.start(`Analyzing image: ${imgPath}…`);
      try {
        const { askVision } = await import('../../tools/vision-tool.js');
        const absPath = path.resolve(projectPath, imgPath);
        const analysis = await askVision(projectPath, absPath, prompt);
        spinner.stop();
        printer.section('Vision Analysis');
        printer.response(analysis);
        
        // Push the analysis into the queue so the next prompt can use it!
        promptQueue.push(`[Vision Analysis of ${imgPath}]: ${analysis}`);
        printer.dim('  (Analysis added to context for your next prompt)');
      } catch (e: any) {
        spinner.fail();
        printer.error(e.message);
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /browse ───────────────────────────────────────────────────────────
    if (normalized.startsWith('/browse ')) {
      const url = line.slice(8).trim();
      if (!url) {
        printer.warn('Usage: /browse <url>');
        rl.resume(); rl.prompt(); return;
      }
      spinner.start(`Browsing to ${url}…`);
      try {
        const { takeScreenshot } = await import('../../tools/browser-tool.js');
        const { askVision } = await import('../../tools/vision-tool.js');
        
        const screenshotPath = await takeScreenshot(url, projectPath);
        spinner.start('Analyzing webpage visual state…');
        
        const analysis = await askVision(projectPath, screenshotPath, 'You are an expert QA tester. Describe the UI state of this webpage in extreme detail. List all visible text, buttons, and layout structures.');
        spinner.stop();
        
        printer.section(`Web UI Analysis (${url})`);
        printer.response(analysis);
        
        promptQueue.push(`[Web UI Analysis of ${url}]:\n${analysis}`);
        printer.dim('  (UI state added to context for your next prompt)');
      } catch (e: any) {
        spinner.fail();
        printer.error(e.message);
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /mcp ──────────────────────────────────────────────────────────────
    if (normalized === '/mcp' || normalized.startsWith('/mcp ')) {
      const parts = line.split(' ').slice(1);
      const REGISTRY: Record<string, any> = {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" } },
        slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" } },
        sqlite: { command: "npx", args: ["-y", "mcp-server-sqlite", "--db-path", "./database.sqlite"] },
        postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:password@localhost/mydb"] },
        brave: { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "" } },
        stitch: { command: "npx", args: ["-y", "stitch-mcp"], env: { STITCH_API_KEY: "", GOOGLE_CLOUD_PROJECT: "" } },
        puppeteer: { command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }
      };

      if (parts.length === 0 || parts[0] === 'list') {
        printer.section('Available MCP Add-ons');
        printer.info('  ' + Object.keys(REGISTRY).join(', '));
        printer.blank();
        printer.info('Type /mcp add <name> to install one.');
        if (mcpManager && mcpManager.tools.length > 0) {
          printer.success(`\nActive MCP tools: ${mcpManager.tools.map((t: any) => t.name).join(', ')}`);
        }
        rl.resume(); rl.prompt(); return;
      }
      
      if (parts[0] === 'add' && parts[1]) {
        const name = parts[1];
        if (!REGISTRY[name]) {
          printer.error(`Unknown add-on '${name}'.`);
        } else {
          if (!mcpManager) {
            const { MCPClientManager } = await import('../../mcp/mcp-client.js');
            mcpManager = new MCPClientManager();
          }
          if (!mcpManager.config) mcpManager.config = { mcpServers: {} };
          mcpManager.config.mcpServers[name] = REGISTRY[name];
          const { writeFile, mkdir } = await import('fs/promises');
          await mkdir(path.join(projectPath!, '.laila'), { recursive: true });
          await writeFile(path.join(projectPath!, '.laila', 'mcp.json'), JSON.stringify(mcpManager.config, null, 2));
          printer.success(`Added '${name}' to mcp.json!`);
          if (REGISTRY[name].env) printer.warn(`This server requires API keys. Run: /mcp auth ${name}`);
        }
        rl.resume(); rl.prompt(); return;
      }

      if (parts[0] === 'search' && parts[1]) {
        spinner.start(`Searching NPM for MCP servers matching '${parts.slice(1).join(' ')}'…`);
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          const query = parts.slice(1).join(' ');
          const { stdout } = await execAsync(`npm search mcp ${query} --json`, { timeout: 15000 });
          spinner.stop();
          const results = JSON.parse(stdout);
          const filtered = results.filter((r: any) => r.name.includes('mcp') || (r.description && r.description.toLowerCase().includes('mcp')));
          
          printer.section('Search Results (Cleaned)');
          if (filtered.length === 0) {
            printer.warn('No MCP servers found for that query.');
          } else {
            filtered.forEach((r: any) => {
              const desc = r.description ? (r.description.length > 80 ? r.description.substring(0, 77) + '...' : r.description) : 'No description';
              console.log(`\x1b[36m${r.name}\x1b[0m - ${desc.replace(/\n/g, ' ')}`);
            });
            printer.blank();
            printer.info('To run any of these, use: /mcp npx -y <package-name>');
          }
        } catch (e: any) {
          spinner.fail('Search failed.');
          printer.error(e.message);
        }
        rl.resume(); rl.prompt(); return;
      }
      if (parts[0] === 'auth' && parts[1]) {
        const srvName = parts[1];
        if (mcpManager?.config?.mcpServers[srvName]) {
          const srv = mcpManager.config.mcpServers[srvName];
          if (srv.env) {
            for (const key of Object.keys(srv.env)) {
              const val = await rlAsk(`Enter value for ${key}: `);
              if (val) srv.env[key] = val;
            }
            const { writeFile, mkdir } = await import('fs/promises');
            await mkdir(path.join(projectPath!, '.laila'), { recursive: true });
            await writeFile(path.join(projectPath!, '.laila', 'mcp.json'), JSON.stringify(mcpManager.config, null, 2));
            printer.success(`Saved auth config for ${srvName} to mcp.json!`);
          } else {
            printer.warn(`No env config found for ${srvName}.`);
          }
        } else {
          printer.error(`Server '${srvName}' not found in mcp.json`);
        }
        rl.resume(); rl.prompt(); return;
      }
      spinner.start(`Connecting to MCP server: ${parts.join(' ')}…`);
      try {
        if (!mcpManager) {
          const { MCPClientManager } = await import('../../mcp/mcp-client.js');
          mcpManager = new MCPClientManager();
        }
        await mcpManager.connect('default', parts[0]!, parts.slice(1));
        spinner.succeed(`Connected! Loaded ${mcpManager.tools.length} tools.`);
        mcpManager.tools.forEach(t => printer.dim(`  - ${t.name}: ${t.description}`));
      } catch (e: any) {
        spinner.fail();
        printer.error(e.message);
        mcpManager = null;
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /history ──────────────────────────────────────────────────────────
    if (normalized === '/history' || normalized === '.history') {
      const { findBySession } = await import('../../memory/repositories/tasks.js');
      const tasks = findBySession(session.id, 20);
      printer.section('Session History');
      printer.historyTable(tasks);
      rl.resume(); rl.prompt(); return;
    }

    // ── /memory ───────────────────────────────────────────────────────────
    if (normalized === '/memory' || normalized === '.memory') {
      const { readFileSafe } = await import('../../utils/fs-utils.js');
      const memoryPaths = [
        path.join(projectPath, 'LAILA.md'),
        path.join(projectPath, '.laila', 'LAILA.md'),
        path.join(projectPath, 'BRAIN.md'),
        path.join(projectPath, 'Brain.md'),
      ];
      let found = false;
      for (const mp of memoryPaths) {
        const content = await readFileSafe(mp);
        if (content) {
          printer.memoryDisplay(path.basename(mp), content);
          found = true;
          break;
        }
      }
      if (!found) {
        printer.warn('No project memory file found (LAILA.md or BRAIN.md).');
        printer.info('Create LAILA.md in the project root to add project-specific memory.');
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /skills ───────────────────────────────────────────────────────────
    if (normalized === '/skills' || normalized === '.skills') {
      const { discoverSkills } = await import('../../skills/skill-loader.js');
      spinner.start('Discovering skills…');
      const skills = await discoverSkills();
      spinner.stop();
      const unique = skills.filter(s => !s.path.includes('/references/') && !s.path.includes('\\references\\'));
      printer.section('Discovered Skills');
      printer.skillsList(unique.map(s => ({ name: s.name, agent: s.agent, description: s.description })));
      printer.dim(`${unique.length} skill(s) found in ${SKILLS_DIR}`);
      rl.resume(); rl.prompt(); return;
    }

    // ── /provider ─────────────────────────────────────────────────────────
    if (normalized === '/provider' || normalized === '.provider') {
      const newProvider = await switchProvider(activeProvider.id, projectPath, rl);
      if (newProvider) {
        activeProvider = newProvider;
        setProvider(activeProvider);
      } else {
        printer.dim('Provider switch cancelled — keeping current provider.');
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /model ────────────────────────────────────────────────────────────
    if (normalized === '/model' || normalized === '.model') {
      spinner.start('Fetching available models…');
      let models: import('../../llm/providers/base.js').ModelInfo[] = [];
      try {
        models = await activeProvider.listModels();
        spinner.stop();
      } catch {
        spinner.fail('Could not list models from provider.');
        rl.resume(); rl.prompt(); return;
      }

      if (models.length === 0) {
        printer.warn('No models available from current provider.');
        rl.resume(); rl.prompt(); return;
      }

      printer.section(`Models on ${activeProvider.id}`);
      models.forEach((m, i) => {
        const desc = m.description ? `  ${m.description}` : '';
        printer.dim(`  ${String(i + 1).padStart(2)}. ${m.name}${desc}`);
      });
      printer.blank();

      const { askQuestion } = await import('../../utils/prompt-utils.js');
      const choice = await askQuestion(rl, chalk.magenta('  Enter model number or name (or press ESC/Enter to go back): '));

      if (!choice) {
        printer.dim('No selection made — keeping current model.');
        rl.resume(); rl.prompt(); return;
      }

      let selectedModel: import('../../llm/providers/base.js').ModelInfo | undefined;
      const idx = parseInt(choice, 10);
      if (!isNaN(idx)) {
        // Numeric entry — validate range explicitly
        if (idx < 1 || idx > models.length) {
          printer.warn(`Invalid selection: ${idx}. Enter a number between 1 and ${models.length}.`);
          rl.resume(); rl.prompt(); return;
        }
        selectedModel = models[idx - 1];
      } else {
        // Name/ID entry
        selectedModel = models.find(m => m.id === choice || m.name === choice);
      }

      if (!selectedModel) {
        printer.warn(`Model "${choice}" not found.`);
        rl.resume(); rl.prompt(); return;
      }

      const { buildProvider } = await import('../../llm/provider-factory.js');
      const { saveProjectConfig } = await import('../../config/config-writer.js');
      const currentConfig = await loadProviderConfig(projectPath);
      const newConfig = { ...currentConfig, model: selectedModel.id };

      try {
        const newProv = buildProvider(newConfig as import('../../llm/providers/base.js').ProviderConfig);
        activeProvider = newProv;
        setProvider(activeProvider);

        const { askYesNo } = await import('../../utils/prompt-utils.js');
        const save = await askYesNo(rl, chalk.magenta('  Save as default for this project?'));

        if (save) {
          await saveProjectConfig(projectPath, newConfig as import('../../llm/providers/base.js').ProviderConfig);
          printer.success(`Switched to model: ${selectedModel.id} (saved)`);
        } else {
          printer.success(`Switched to model: ${selectedModel.id} (session only)`);
        }
      } catch (err) {
        printer.error(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`);
      }

      rl.resume(); rl.prompt(); return;
    }
    // ── /plan <goal> ───────────────────────────────────────────────────────
    if (normalized.startsWith('/plan ') || normalized.startsWith('.plan ')) {
      const goal = line.substring(6).trim();
      if (!goal) { printer.warn('Usage: /plan <goal>'); rl.resume(); rl.prompt(); return; }
      printer.section(`Planning: ${goal}`);
      
      const planRes = await orchestrate({
        userMessage: `Break this goal into 3-5 independent, sequential tasks: "${goal}". Return ONLY a JSON array of strings representing the tasks. Do not include markdown blocks or any other text.`,
        sessionId: session.id,
        projectId,
      });

      try {
        let jsonStr = planRes.response;
        const jsonMatch = planRes.response.match(/```json\n([\s\S]*?)```/) || planRes.response.match(/\[\s*[\s\S]*?\s*\]/);
        if (jsonMatch) jsonStr = jsonMatch[1] || jsonMatch[0];
        
        const tasks = JSON.parse(jsonStr);
        if (!Array.isArray(tasks)) throw new Error('Not an array');
        printer.success('Plan generated:');
        tasks.forEach((t, i) => printer.dim(`  ${i + 1}. ${t}`));
        printer.blank();
        const ok = await rlAsk('Queue these steps for execution? [Y/n]: ');
        if (ok.toLowerCase() !== 'n') {
          tasks.forEach((t, i) => promptQueue.push(`[Plan Step ${i + 1}/${tasks.length}]: ${t}`));
          updatePrompt();
          // FIX (Medium): attach .catch() so a drainQueue rejection becomes a handled error
          drainQueue().catch(err => printer.error(`Queue error: ${err instanceof Error ? err.message : String(err)}`));
          return; // Don't prompt, queue is running
        } else {
          printer.dim('Plan discarded.');
        }
      } catch (err: any) {
        printer.error('Failed to parse plan. Try again or refine the goal.');
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /pipeline <task> ───────────────────────────────────────────────────
    if (normalized.startsWith('/pipeline ') || normalized.startsWith('.pipeline ')) {
      const goal = line.substring(10).trim();
      if (!goal) { printer.warn('Usage: /pipeline <task>'); rl.resume(); rl.prompt(); return; }
      
      printer.section(`Pipeline created for: ${goal}`);
      printer.dim('  1. Researcher: Investigate and gather context');
      printer.dim('  2. Coder: Implement the feature');
      printer.dim('  3. Reviewer: Audit the code');
      printer.blank();

      const ok = await rlAsk('Start pipeline? [Y/n]: ');
      if (ok.toLowerCase() !== 'n') {
        promptQueue.push(`As a researcher, investigate how to implement this task: "${goal}". Summarize the current state of the codebase regarding this feature and outline an implementation plan.`);
        promptQueue.push(`As a coder, implement the feature based on the previous research: "${goal}". Write the actual code and apply patches.`);
        promptQueue.push(`As a reviewer, review the code that was just implemented for: "${goal}". Check for security, style, and correctness. If there are issues, fix them.`);
        updatePrompt();
        // FIX (Medium): attach .catch() so a drainQueue rejection becomes a handled error
        drainQueue().catch(err => printer.error(`Queue error: ${err instanceof Error ? err.message : String(err)}`));
        return;
      } else {
        printer.dim('Pipeline discarded.');
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /queue — list pending prompts ─────────────────────────────────────
    if (normalized === '/queue' || normalized === '.queue') {
      if (promptQueue.length === 0) {
        printer.dim('  Queue is empty.');
      } else {
        printer.section(`Prompt Queue (${promptQueue.length})`);
        promptQueue.forEach((p, i) => {
          const preview = p.length > 70 ? p.slice(0, 69) + '…' : p;
          printer.dim(`  ${String(i + 1).padStart(2)}. ${preview}`);
        });
        printer.blank();
      }
      rl.resume(); rl.prompt(); return;
    }

    // ── /skip [n] — remove a queued prompt ────────────────────────────────
    if (normalized.startsWith('/skip') || normalized.startsWith('.skip')) {
      if (promptQueue.length === 0) {
        printer.dim('  Queue is empty — nothing to skip.');
        rl.resume(); rl.prompt(); return;
      }
      const parts = line.split(/\s+/);
      const arg = parts[1];
      const n = arg ? parseInt(arg, 10) : 1;
      if (isNaN(n) || n < 1 || n > promptQueue.length) {
        printer.warn(`Invalid index. Queue has ${promptQueue.length} item(s). Use /skip [1-${promptQueue.length}].`);
        rl.resume(); rl.prompt(); return;
      }
      const removed = promptQueue.splice(n - 1, 1)[0]!;
      const preview = removed.length > 60 ? removed.slice(0, 59) + '…' : removed;
      printer.success(`Removed #${n}: "${preview}"`);
      updatePrompt();
      rl.resume(); rl.prompt(); return;
    }

    // ── /interrupt <prompt> — push to front of queue ──────────────────────
    if (normalized.startsWith('/interrupt') || normalized.startsWith('.interrupt')) {
      const interruptText = line.slice(line.indexOf(' ') + 1).trim();
      if (!interruptText || interruptText.toLowerCase() === '/interrupt') {
        printer.warn('Usage: /interrupt <your prompt>');
        rl.resume(); rl.prompt(); return;
      }
      promptQueue.unshift(interruptText);
      printer.success(`Interrupt queued — will run next (${promptQueue.length} total in queue).`);
      updatePrompt();
      // Kick off the drainer if it's not already running
      if (!queueRunning) {
        drainQueue().catch(() => {});
      }
      return;
    }

    // ── Regular prompt — push to back of queue and drain ──────────────────
    promptQueue.push(line);
    updatePrompt();
    if (!queueRunning) {
      drainQueue().catch(() => {});
    }
  });

  rl.on('close', () => {
    endSession(session.id);
    printer.blank();
    printer.dim('Session ended. Goodbye.');
    printer.blank();
    process.exit(0);
  });

  rl.on('SIGINT', () => {
    rl.close();
  });
}
