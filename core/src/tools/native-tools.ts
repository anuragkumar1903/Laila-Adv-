/**
 * native-tools.ts
 *
 * Two responsibilities:
 *   1. getNativeTools()   — returns the tool schema array sent to the LLM
 *   2. executeTool()      — executes a tool call returned by the LLM and
 *                           returns a plain string result that goes back
 *                           into the conversation as a 'tool' role message.
 *
 * This is the single execution hub for the agentic tool loop in orchestrator.ts.
 * All safety guards (path traversal, shell allowlist, SSRF) are enforced by
 * the underlying tool modules — executeTool() just routes and formats.
 */

import path from 'path';
import { readFile, writeFile, mkdir, realpath } from 'fs/promises';
import type { ToolDefinition, ToolCall } from '../llm/providers/base.js';
import { pathExists } from '../utils/fs-utils.js';

// ─── MCP Manager Registry ─────────────────────────────────────────────────

/**
 * Module-level registry for the MCPClientManager instance.
 * Populated by registerMcpManager() from start.ts after MCP is initialised.
 */
let _mcpManager: any = null;

/** Register the active MCPClientManager so executeTool can route mcp__ calls. */
export function registerMcpManager(manager: any): void {
  _mcpManager = manager;
}

/** Retrieve the currently registered MCPClientManager (may be null). */
export function getMcpManager(): any {
  return _mcpManager;
}

/**
 * Convert an array of MCP tool descriptors (as exposed by MCPClientManager.tools)
 * into ToolDefinition objects understood by the LLM provider layer.
 *
 * Tool names are namespaced as `mcp__<serverName>__<toolName>` so that
 * executeTool() can unambiguously route them back to the correct MCP server.
 *
 * @param mcpTools  - Raw tool list from MCPClientManager.tools
 * @returns         Array of ToolDefinition objects ready to pass to the LLM
 */
export function getMcpTools(
  mcpTools: Array<{ name: string; description: string; serverName: string; inputSchema?: any }>,
): ToolDefinition[] {
  return mcpTools.map(t => ({
    name: `mcp__${t.serverName}__${t.name}`,
    description: `[MCP:${t.serverName}] ${t.description}`,
    parameters: t.inputSchema ?? {
      type: 'object',
      properties: {},
      required: [],
    },
  }));
}
import { saveCheckpoint } from './checkpoint.js';

// ─── Tool schema ──────────────────────────────────────────────────────────

export function getNativeTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Reads the contents of one or more files from the project. Use this before editing any file.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of relative or absolute file paths to read.',
          },
        },
        required: ['files'],
      },
    },
    {
      name: 'list_directory',
      description: 'Lists files and subdirectories in a directory. Use to explore the project structure.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative or absolute directory path to list. Defaults to project root.',
          },
        },
        required: [],
      },
    },
    {
      name: 'write_file',
      description: 'Creates a new file or completely overwrites an existing file with the given content.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'The relative or absolute path of the file to write.',
          },
          content: {
            type: 'string',
            description: 'The complete file content to write.',
          },
        },
        required: ['file', 'content'],
      },
    },
    {
      name: 'patch_file',
      description: 'Modifies an existing file by finding an exact block of text and replacing it. Prefer this over write_file for small targeted changes.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'The relative or absolute path of the file to patch.',
          },
          find: {
            type: 'string',
            description: 'The exact text to find in the file. Must match whitespace and indentation exactly.',
          },
          replace: {
            type: 'string',
            description: 'The text to replace the found text with.',
          },
        },
        required: ['file', 'find', 'replace'],
      },
    },
    {
      name: 'grep_search',
      description: 'Searches for a regex or string pattern across files in the project. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The regex pattern or literal string to search for.',
          },
          path: {
            type: 'string',
            description: 'Directory or file to search within (e.g. "src" or "."). Defaults to project root.',
          },
          include: {
            type: 'string',
            description: 'Optional glob pattern to filter files, e.g. "*.ts" or "*.{ts,js}".',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'run_command',
      description: 'Executes a shell command in the project directory. Use for npm install, running tests, tsc, etc. Commands are validated against a safety allowlist.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run.',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'git_command',
      description: 'Executes a git operation. Supported actions: status, log, diff, branch, checkout, add, commit, stash, show, blame.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The git action to perform (e.g. "status", "diff", "log", "add", "commit").',
          },
          args: {
            type: 'string',
            description: 'Arguments for the git action, e.g. "-m \'fix: update login\'" or "src/".',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'web_search',
      description: 'Searches the web for current information, documentation, or news. Use when the user asks about external topics, libraries, or current events.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_read_url',
      description: 'Fetches and extracts the full text content from a specific URL.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch content from.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_action',
      description: 'Takes a screenshot of a webpage or extracts its HTML/text. Use to inspect UI or check localhost.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to visit.',
          },
          action: {
            type: 'string',
            description: 'One of: "screenshot", "text", "html".',
          },
        },
        required: ['url', 'action'],
      },
    },
  ];
}

// ─── Execution context ────────────────────────────────────────────────────

export interface ToolExecutionContext {
  projectRoot: string;
  sessionId: number;
  taskId: number;
  /** When true, write_file and patch_file skip user confirmation (e.g. /auto mode) */
  autoApprove?: boolean;
}

// ─── Path safety helper ───────────────────────────────────────────────────

async function safeResolvePath(inputPath: string, projectRoot: string): Promise<string | null> {
  const resolved = path.resolve(projectRoot, inputPath);
  const root = path.resolve(projectRoot);

  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null; // path traversal
  }

  // Resolve symlinks to catch symlink-based escapes
  try {
    const real = await realpath(resolved);
    const realRoot = await realpath(root).catch(() => root);
    if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
      return null;
    }
    return real;
  } catch {
    // File doesn't exist yet (write case) — lexical check is sufficient
    return resolved;
  }
}

// ─── Individual tool executors ────────────────────────────────────────────

async function execReadFile(args: any, ctx: ToolExecutionContext): Promise<string> {
  const files: string[] = Array.isArray(args.files) ? args.files : [args.files];
  const results: string[] = [];

  for (const f of files) {
    const safePath = await safeResolvePath(String(f), ctx.projectRoot);
    if (!safePath) {
      results.push(`ERROR reading ${f}: path traversal blocked`);
      continue;
    }
    try {
      const content = await readFile(safePath, 'utf-8');
      const relPath = path.relative(ctx.projectRoot, safePath);
      results.push(`=== File: ${relPath} ===\n${content}`);
    } catch (err: any) {
      results.push(`ERROR reading ${f}: ${err.message}`);
    }
  }

  return results.join('\n\n');
}

async function execListDirectory(args: any, ctx: ToolExecutionContext): Promise<string> {
  const { readdir } = await import('fs/promises');
  const { loadLailaIgnore } = await import('../scanner/scanner.js');
  const targetPath = args.path ? String(args.path) : '.';
  const safePath = await safeResolvePath(targetPath, ctx.projectRoot);

  if (!safePath) {
    return `ERROR: path traversal blocked`;
  }

  try {
    const lailaIgnorePatterns = await loadLailaIgnore(ctx.projectRoot);
    const hardcodedExcludes = new Set(['node_modules', 'dist', 'build', '.git']);

    const entries = await readdir(safePath, { withFileTypes: true });
    const lines = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.laila')
      .filter(e => !hardcodedExcludes.has(e.name))
      .filter(e => {
        // Check entry name against .lailaignore patterns (simple glob match)
        if (lailaIgnorePatterns.length === 0) return true;
        const entryName = e.name;
        const entryNameSlash = e.isDirectory() ? `${entryName}/` : entryName;
        return !lailaIgnorePatterns.some(pattern => {
          // Strip trailing slash for dir patterns — match on both forms
          const cleanPattern = pattern.replace(/\/$/, '');
          return entryName === cleanPattern || entryNameSlash === pattern ||
                 entryName.endsWith(cleanPattern.replace(/^\*/, ''));
        });
      })
      .map(e => `${e.isDirectory() ? '[DIR] ' : '      '}${e.name}`);
    const relPath = path.relative(ctx.projectRoot, safePath) || '.';
    return `Directory: ${relPath}\n${lines.join('\n')}`;
  } catch (err: any) {
    return `ERROR listing directory: ${err.message}`;
  }
}

async function execWriteFile(args: any, ctx: ToolExecutionContext): Promise<string> {
  const file = String(args.file);
  const content = String(args.content);

  const safePath = await safeResolvePath(file, ctx.projectRoot);
  if (!safePath) {
    return `ERROR: path traversal blocked — cannot write outside project root`;
  }

  try {
    // Checkpoint: save original content before overwriting
    try {
      const existing = await readFile(safePath, 'utf-8');
      saveCheckpoint(safePath, existing);
    } catch {
      // File doesn't exist yet — no checkpoint needed
    }

    await mkdir(path.dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf-8');
    const relPath = path.relative(ctx.projectRoot, safePath);
    return `Successfully wrote ${content.split('\n').length} lines to ${relPath}`;
  } catch (err: any) {
    return `ERROR writing ${file}: ${err.message}`;
  }
}

async function execPatchFile(args: any, ctx: ToolExecutionContext): Promise<string> {
  const file = String(args.file);
  const find = String(args.find);
  const replace = String(args.replace);

  const safePath = await safeResolvePath(file, ctx.projectRoot);
  if (!safePath) {
    return `ERROR: path traversal blocked`;
  }

  try {
    const original = await readFile(safePath, 'utf-8');

    // Checkpoint: save original content before patching
    saveCheckpoint(safePath, original);

    if (!original.includes(find)) {
      // Try normalising line endings
      const normalised = original.replace(/\r\n/g, '\n');
      const normFind   = find.replace(/\r\n/g, '\n');
      if (!normalised.includes(normFind)) {
        return `ERROR: Could not find the target text in ${file}. The text to find must match exactly (including indentation and whitespace).`;
      }
      const patched = normalised.replace(normFind, replace);
      await writeFile(safePath, patched, 'utf-8');
    } else {
      const patched = original.replace(find, replace);
      await writeFile(safePath, patched, 'utf-8');
    }
    const relPath = path.relative(ctx.projectRoot, safePath);
    return `Successfully patched ${relPath}`;
  } catch (err: any) {
    return `ERROR patching ${file}: ${err.message}`;
  }
}

async function execGrepSearch(args: any, ctx: ToolExecutionContext): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const { loadLailaIgnore } = await import('../scanner/scanner.js');

  const pattern = String(args.pattern);
  const searchPath = args.path ? path.resolve(ctx.projectRoot, String(args.path)) : ctx.projectRoot;
  const include = args.include ? String(args.include) : undefined;

  // Load .lailaignore patterns for this project
  const lailaIgnorePatterns = await loadLailaIgnore(ctx.projectRoot);

  // Use ripgrep if available, fall back to a JS implementation
  try {
    const rgArgs = [
      '--line-number',
      '--no-heading',
      '--max-count=5',
      '--max-filesize=500K',
      '--glob=!node_modules',
      '--glob=!.git',
      '--glob=!dist',
      '--glob=!build',
    ];
    // Add .lailaignore pattern exclusions to rg
    for (const p of lailaIgnorePatterns) {
      rgArgs.push(`--glob=!${p}`);
    }
    if (include) rgArgs.push(`--glob=${include}`);
    rgArgs.push(pattern, searchPath);

    const { stdout } = await execFileAsync('rg', rgArgs, { timeout: 10000 });
    const lines = stdout.trim().split('\n').slice(0, 50);
    return lines.length > 0 ? lines.join('\n') : 'No matches found.';
  } catch {
    // rg not available — fall back to manual grep
    const { glob } = await import('glob');
    const globPattern = include ? path.join(searchPath, '**', include) : path.join(searchPath, '**', '*');

    // Build ignore list: hardcoded defaults + .lailaignore patterns
    const ignoreList = [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
      ...lailaIgnorePatterns.map(p => {
        const clean = p.replace(/\/$/, '');
        return `**/${clean}/**`;
      }),
    ];

    const files = await glob(globPattern, {
      ignore: ignoreList,
      nodir: true,
    });

    const matches: string[] = [];
    const re = new RegExp(pattern, 'i');

    for (const f of files.slice(0, 100)) {
      if (matches.length >= 50) break;
      try {
        const content = await readFile(f, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            const rel = path.relative(ctx.projectRoot, f);
            matches.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
            if (matches.length >= 50) break;
          }
        }
      } catch { /* skip unreadable files */ }
    }

    return matches.length > 0 ? matches.join('\n') : 'No matches found.';
  }
}

async function execRunCommand(args: any, ctx: ToolExecutionContext): Promise<string> {
  const command = String(args.command).trim();

  // ── Safety: validate against shell-tool's allowlist ─────────────────
  const firstToken = command.split(/\s+/)[0]?.toLowerCase() ?? '';
  const BLOCKED: RegExp[] = [
    /rm\s+-rf/i, /rm\s+--recursive/i, /rm\s+-[a-z]*r[a-z]*f/i,
    /del\s+\/[fFsS]/i, /format\s+[a-z]:/i, /shutdown/i, /reboot/i,
    /sudo\s/i, /runas\s/i, /invoke-expression/i, /iex\s/i,
    /curl\s.*\|\s*(bash|sh|powershell)/i, /wget\s.*\|\s*(bash|sh)/i,
    /drop\s+table/i, /drop\s+database/i,
  ];

  const ALLOWED_PREFIXES = new Set([
    'npm', 'npx', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'go',
    'dotnet', 'mvn', 'gradle', 'node', 'python', 'python3', 'tsc',
    'git', 'docker', 'ls', 'dir', 'cat', 'type', 'pwd', 'echo',
    'grep', 'rg', 'find', 'curl', 'wget', 'mkdir', 'touch', 'cp',
    'mv', 'chmod', 'diff', 'head', 'tail', 'wc', 'test-path',
    'get-childitem', 'get-content', 'set-location',
  ]);

  if (!ALLOWED_PREFIXES.has(firstToken)) {
    return `ERROR: Command "${firstToken}" is not in the allowed list. Allowed: npm, npx, node, python, tsc, git, docker, grep, curl, etc.`;
  }

  for (const pattern of BLOCKED) {
    if (pattern.test(command)) {
      return `ERROR: Command blocked by safety rules: ${command}`;
    }
  }

  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const proc = spawn(isWindows ? 'cmd' : 'sh', [isWindows ? '/c' : '-c', command], {
      cwd: ctx.projectRoot,
      timeout: 120_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const out = [
        stdout.trim() ? `STDOUT:\n${stdout.trim()}` : '',
        stderr.trim() ? `STDERR:\n${stderr.trim()}` : '',
      ].filter(Boolean).join('\n');

      resolve(out || `Command exited with code ${code}`);
    });

    proc.on('error', (err) => {
      resolve(`ERROR running command: ${err.message}`);
    });
  });
}

async function execGitCommand(args: any, ctx: ToolExecutionContext): Promise<string> {
  const action = String(args.action).toLowerCase().trim();
  const gitArgs = args.args ? String(args.args).trim() : '';

  const SAFE_ACTIONS = new Set([
    'status', 'log', 'diff', 'diff-staged', 'branch', 'branches',
    'checkout', 'new-branch', 'add', 'commit', 'stash', 'stash-pop',
    'stash-list', 'show', 'blame', 'tag', 'tags', 'cherry-pick',
    'reset-soft', 'discard',
  ]);

  if (!SAFE_ACTIONS.has(action)) {
    return `ERROR: Git action "${action}" is not supported. Supported: ${[...SAFE_ACTIONS].join(', ')}`;
  }

  try {
    const {
      getGitStatus, getGitLog, getGitDiff, getGitStaged, gitAdd, commitChanges,
      gitCheckout, gitCreateBranch, gitListBranches, gitStash, gitStashPop,
      gitStashList, gitShow, gitBlame, gitTag, gitListTags,
    } = await import('../utils/git-utils.js');

    switch (action) {
      case 'status': {
        const s = await getGitStatus(ctx.projectRoot);
        return s ?? 'No changes.';
      }
      case 'log': {
        const l = await getGitLog(ctx.projectRoot, 10);
        return l ?? 'No log.';
      }
      case 'diff': {
        const d = await getGitDiff(ctx.projectRoot, false);
        return d ?? 'No unstaged changes.';
      }
      case 'diff-staged': {
        const d = await getGitDiff(ctx.projectRoot, true);
        return d ?? 'No staged changes.';
      }
      case 'branch':
      case 'branches': {
        const b = await gitListBranches(ctx.projectRoot);
        return b ?? 'No branches.';
      }
      case 'checkout': {
        await gitCheckout(ctx.projectRoot, gitArgs);
        return `Checked out: ${gitArgs}`;
      }
      case 'new-branch': {
        await gitCreateBranch(ctx.projectRoot, gitArgs);
        return `Created and checked out branch: ${gitArgs}`;
      }
      case 'add': {
        await gitAdd(ctx.projectRoot, gitArgs || '.');
        return `Staged: ${gitArgs || 'all changes'}`;
      }
      case 'commit': {
        const ok = await commitChanges(ctx.projectRoot, gitArgs);
        return ok ? `Committed: "${gitArgs}"` : 'Commit failed.';
      }
      case 'stash': {
        await gitStash(ctx.projectRoot);
        return 'Changes stashed.';
      }
      case 'stash-pop': {
        await gitStashPop(ctx.projectRoot);
        return 'Stash popped.';
      }
      case 'stash-list': {
        const l = await gitStashList(ctx.projectRoot);
        return l ?? 'No stashes.';
      }
      case 'show': {
        const s = await gitShow(ctx.projectRoot, gitArgs);
        return s ?? 'Nothing to show.';
      }
      case 'blame': {
        const b = await gitBlame(ctx.projectRoot, gitArgs);
        return b ?? 'No blame output.';
      }
      default:
        return `Action "${action}" not yet implemented.`;
    }
  } catch (err: any) {
    return `ERROR running git ${action}: ${err.message}`;
  }
}

async function execWebSearch(args: any, _ctx: ToolExecutionContext): Promise<string> {
  const query = String(args.query);

  // Use DuckDuckGo Instant Answer API (no API key required)
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;

    const parts: string[] = [];
    if (data.AbstractText) parts.push(data.AbstractText);
    if (data.RelatedTopics?.length) {
      const topics = data.RelatedTopics.slice(0, 5)
        .filter((t: any) => t.Text)
        .map((t: any) => `- ${t.Text}`);
      if (topics.length) parts.push('Related:\n' + topics.join('\n'));
    }
    if (data.Answer) parts.push(`Answer: ${data.Answer}`);

    return parts.join('\n\n') || `No instant results for: ${query}. Try refining the query.`;
  } catch (err: any) {
    return `Web search failed: ${err.message}`;
  }
}

async function execWebReadUrl(args: any, _ctx: ToolExecutionContext): Promise<string> {
  const url = String(args.url);

  // Block SSRF — no private/localhost IPs
  try {
    const parsed = new URL(url);
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
    if (blocked.includes(parsed.hostname) || parsed.hostname.endsWith('.local')) {
      return `ERROR: Fetching localhost/private URLs is blocked.`;
    }
  } catch {
    return `ERROR: Invalid URL: ${url}`;
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Laila-AI-Assistant/1.0' },
    });
    if (!res.ok) return `HTTP ${res.status} fetching ${url}`;

    const html = await res.text();
    // Strip HTML tags and collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    return `Content from ${url}:\n\n${text}`;
  } catch (err: any) {
    return `ERROR fetching URL: ${err.message}`;
  }
}

async function execBrowserAction(args: any, ctx: ToolExecutionContext): Promise<string> {
  try {
    const { runBrowserTool } = await import('./browser-tool.js');
    const result = await runBrowserTool(ctx.projectRoot, {
      url: String(args.url),
      action: String(args.action) as 'screenshot' | 'text' | 'html',
    });
    return result;
  } catch (err: any) {
    return `Browser action failed: ${err.message}. Is Playwright installed?`;
  }
}

// ─── Main router ──────────────────────────────────────────────────────────

/**
 * Execute a single tool call from the LLM and return the result as a string.
 * This result is sent back to the LLM as a 'tool' role message.
 */
export async function executeTool(tc: ToolCall, ctx: ToolExecutionContext): Promise<string> {
  try {
    switch (tc.name) {
      case 'read_file':      return await execReadFile(tc.arguments, ctx);
      case 'list_directory': return await execListDirectory(tc.arguments, ctx);
      case 'write_file':     return await execWriteFile(tc.arguments, ctx);
      case 'patch_file':     return await execPatchFile(tc.arguments, ctx);
      case 'grep_search':    return await execGrepSearch(tc.arguments, ctx);
      case 'run_command':    return await execRunCommand(tc.arguments, ctx);
      case 'git_command':    return await execGitCommand(tc.arguments, ctx);
      case 'web_search':     return await execWebSearch(tc.arguments, ctx);
      case 'web_read_url':   return await execWebReadUrl(tc.arguments, ctx);
      case 'browser_action': return await execBrowserAction(tc.arguments, ctx);
      default: {
        // ── MCP tool routing ──────────────────────────────────────────────
        // Tool names are encoded as `mcp__<serverName>__<toolName>`.
        if (tc.name.startsWith('mcp__')) {
          const parts = tc.name.split('__');
          // parts[0] = 'mcp', parts[1] = serverName, parts[2..] = toolName segments
          if (parts.length < 3) {
            return `ERROR: Malformed MCP tool name "${tc.name}" — expected mcp__serverName__toolName`;
          }
          const serverName = parts[1]!;
          const toolName = parts.slice(2).join('__'); // handles tool names that contain __

          const manager = getMcpManager();
          if (!manager) {
            return `ERROR: No MCP manager is registered. MCP tools are unavailable in this session.`;
          }
          try {
            const mcpResult = await manager.callTool(serverName, toolName, tc.arguments);
            return JSON.stringify(mcpResult, null, 2);
          } catch (err: any) {
            return `ERROR calling MCP tool ${serverName}:${toolName}: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        return `ERROR: Unknown tool "${tc.name}"`;
      }
    }
  } catch (err: any) {
    return `ERROR executing tool ${tc.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
