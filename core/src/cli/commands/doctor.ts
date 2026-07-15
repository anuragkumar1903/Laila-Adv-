import path from 'path';
import { pathExists } from '../../utils/fs-utils.js';
import { isGitRepo, getGitRoot } from '../../utils/git-utils.js';
import { ensureDir } from '../../utils/fs-utils.js';
import { DATA_DIR, PROJECTS_DIR, SKILLS_DIR } from '../../config.js';
import { findByPath } from '../../memory/repositories/projects.js';
import { getProvider } from '../../llm/provider-factory.js';
import { loadProviderConfig, isConfigComplete } from '../../config/config-loader.js';
import { runToolChecks } from '../../system/tool-checks.js';
import { printer } from '../ui/printer.js';
import { spinner } from '../ui/spinner.js';

function formatState(ok: boolean, label: string, detail?: string): string {
  return ok ? `OK${detail ? ` - ${detail}` : ''}` : `MISSING${detail ? ` - ${detail}` : ''}`;
}

function addSuggestion(target: string[], condition: boolean, message: string): void {
  if (!condition) target.push(message);
}

function parseDoctorOptions(args: string[]): { fix: boolean; json: boolean } {
  return { 
    fix: args.includes('--fix'),
    json: args.includes('--json') 
  };
}

async function safeCreateDir(targetPath: string): Promise<boolean> {
  await ensureDir(targetPath);
  return pathExists(targetPath);
}

export async function doctorCommand(...args: string[]): Promise<void> {
  const cwd = process.cwd();
  const suggestions: string[] = [];
  const { fix, json } = parseDoctorOptions(args);

  if (!json) printer.header('Laila Doctor');

  spinner.start('Running diagnostics…');

  const providerConfig = await loadProviderConfig(cwd);
  const providerConfigured = isConfigComplete(providerConfig);
  let providerAlive = false;
  if (providerConfigured) {
    try {
      const p = await getProvider(cwd);
      providerAlive = await p.healthCheck();
    } catch { providerAlive = false; }
  }

  const [toolChecks, gitRepo, gitRoot] = await Promise.all([
    runToolChecks(),
    isGitRepo(cwd),
    getGitRoot(cwd),
  ]);

  spinner.succeed('Diagnostics complete');

  const node = toolChecks.find(tool => tool.name === 'Node.js');
  const git  = toolChecks.find(tool => tool.name === 'Git');
  const n8n  = toolChecks.find(tool => tool.name.startsWith('n8n'));
  const repoRoot = gitRoot ?? cwd;
  const projectIndexPath = path.join(repoRoot, 'project-index.json');
  const indexedProject = findByPath(repoRoot);
  const hasProjectIndex = await pathExists(projectIndexPath);
  const dataDirExists = await pathExists(DATA_DIR);
  const projectsDirExists = await pathExists(PROJECTS_DIR);
  const skillsDirExists = await pathExists(SKILLS_DIR);

  const checks = [
    { name: 'Current Folder',   ok: true,                    detail: cwd },
    { name: 'Git Repo',         ok: gitRepo,                 detail: gitRoot ?? undefined },
    { name: 'Project Scan',     ok: !!(hasProjectIndex || indexedProject) },
    { name: 'Node.js',          ok: node?.status === 'available', detail: node?.details ?? node?.installHint },
    { name: 'Git',              ok: git?.status  === 'available', detail: git?.details  ?? git?.installHint },
    { name: 'n8n (optional)',   ok: true, detail: n8n?.details ?? 'Not enabled — set N8N_ENABLED=true to activate' },
    { name: 'LLM Provider',     ok: providerConfigured, detail: providerConfig.provider ? `${providerConfig.provider} / ${providerConfig.model}` : 'Not configured — run laila-cli to setup' },
    { name: 'Provider Health',  ok: providerAlive, detail: providerAlive ? 'Reachable' : providerConfigured ? 'Unreachable — check connection or API key' : 'N/A' },
    { name: 'Project Root',     ok: await pathExists(path.join(cwd, 'package.json')) },
    { name: 'Data Dir',         ok: dataDirExists },
    { name: 'Projects Dir',     ok: projectsDirExists },
    { name: 'Skills Dir',       ok: skillsDirExists },
  ];

  const totalChecks = checks.length;
  const passedChecks = checks.filter(c => c.ok).length;
  const healthScore = Math.round((passedChecks / totalChecks) * 100);

  addSuggestion(suggestions, !gitRepo,                    'Initialize Git in the project root so the assistant can use repository context and change tracking.');
  addSuggestion(suggestions, node?.status !== 'available', 'Install Node.js LTS. On Windows, use `winget install --id OpenJS.NodeJS.LTS -e` or the official installer.');
  addSuggestion(suggestions, git?.status  !== 'available', 'Install Git. On Windows, `winget install --id Git.Git -e` works well.');
  addSuggestion(suggestions, providerConfigured,           'Run `laila-cli` to configure an LLM provider (Ollama, OpenAI, Anthropic, DeepSeek, etc.).');
  addSuggestion(suggestions, !providerConfigured || providerAlive, 'The configured LLM provider is unreachable. Check your API key or local server, then try again.');
  addSuggestion(suggestions, !await pathExists(path.join(cwd, 'package.json')), 'Run the CLI from a project folder, or pass the target project path when prompted.');
  addSuggestion(suggestions, !hasProjectIndex && !indexedProject, 'Run `laila-cli scan` on your project to build the project index and enable better context retrieval.');
  addSuggestion(suggestions, !dataDirExists || !projectsDirExists, 'Create the local data folders with `laila-cli doctor --fix` or by making `data/` and `data/projects/` manually.');
  addSuggestion(suggestions, !skillsDirExists, 'Create a `skills/` folder and add your custom agent bundles there, then run `laila-cli skills` to verify discovery.');

  if (json) {
    console.log(JSON.stringify({ healthScore, checks, suggestions }, null, 2));
    return;
  }

  const rows: Array<[string, string]> = checks.map(c => [
    c.name, formatState(c.ok, c.name, c.detail)
  ]);

  printer.table(rows);
  printer.blank();
  printer.info(`Health Score: ${healthScore}%`);

  if (fix) {
    printer.blank();
    printer.header('Fix Mode');

    if (!dataDirExists) {
      const created = await safeCreateDir(DATA_DIR);
      printer.info(created ? 'Created data/' : 'Could not create data/');
    }

    if (!projectsDirExists) {
      const created = await safeCreateDir(PROJECTS_DIR);
      printer.info(created ? 'Created data/projects/' : 'Could not create data/projects/');
    }

    if (!skillsDirExists) {
      const created = await safeCreateDir(SKILLS_DIR);
      printer.info(created ? 'Created skills/' : 'Could not create skills/');
    }
  }

  printer.blank();
  printer.header('Suggestions');

  if (suggestions.length === 0) {
    printer.success('Everything looks ready.');
    return;
  }

  for (const suggestion of suggestions) {
    printer.info(suggestion);
  }
}