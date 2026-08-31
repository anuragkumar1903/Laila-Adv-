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
  return new Promise(resolve => {
    rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); });
  });
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

  // ── Prompt queue ──────────────────────────────────────────────────────
  const promptQueue: string[] = [];
  let queueRunning = false;
  let autoFixCount = 0;

  function updatePrompt(): void {
    const depth = promptQueue.length;
    const label = depth > 0
      ? chalk.magenta(`  laila[+${depth}]> `)
      : chalk.magenta('  laila> ');
    rl.setPrompt(label);
  }

  /** Run a single user message through the full orchestrator pipeline. */
  async function runPrompt(userMessage: string): Promise<void> {
    try {
      const startMs = Date.now();
      spinner.start('Thinking…');
      const result = await orchestrate({
        userMessage,
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

      // ── Sequential Tool Router ───────────────────────────────────────
      const { parseAllBlocks } = await import('../../utils/markdown-parser.js');
      const allBlocks = parseAllBlocks(result.response);
      
      let filesWritten = 0;
      let contextSuffixes: string[] = [];

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
        else if (block.language === 'git') {
          const gitRes = await runGitBlocks(block.raw, projectPath!);
          if (gitRes.gitContext) contextSuffixes.push(gitRes.gitContext);
        }
        else if (block.language === 'search' || block.language === 'url') {
          const webRes = await runWebBlocks(block.raw);
          if (webRes.webContext) contextSuffixes.push(webRes.webContext);
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
              void triggerN8nWebhook({
                event: 'validation_failed',
                projectId,
                taskId: previousTaskId,
                message: 'Code validation failed after file edits (auto-heal exhausted)',
                details: validation.results,
              });
            }
          } else {
            void triggerN8nWebhook({
              event: 'task_completed',
              projectId,
              taskId: previousTaskId,
              message: 'Task completed and validated successfully',
            });
          }
        }
      } else {
        // If no files were written, task is still done
        void triggerN8nWebhook({
          event: 'task_completed',
          projectId,
          taskId: previousTaskId,
          message: 'Task completed (no file edits)',
        });
      }
    } catch (err: unknown) {
      spinner.fail();
      const msg = err instanceof Error ? err.message : String(err);
      printer.error(msg);
      void triggerN8nWebhook({
        event: 'task_failed',
        projectId,
        taskId: previousTaskId,
        message: msg,
      });
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

  /** Ask a question using the existing rl — avoids double-echo from nested interfaces. */
  function rlAsk(prompt: string): Promise<string> {
    return new Promise(resolve => {
      rl.question(chalk.magenta(`  ${prompt}`), answer => resolve(answer.trim()));
    });
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
    
    // Reset auto-fix loop counter when the user types a new command directly
    autoFixCount = 0;

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

      const choice = await new Promise<string>(resolve => {
        rl.question(chalk.magenta('  Enter model number or name: '), answer => {
          resolve(answer.trim());
        });
      });

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

        const save = await new Promise<string>(resolve => {
          rl.question(chalk.magenta('  Save as default for this project? [Y/n]: '), answer => {
            resolve(answer.trim().toLowerCase());
          });
        });

        if (save === '' || save === 'y' || save === 'yes') {
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
          drainQueue();
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
        drainQueue();
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
