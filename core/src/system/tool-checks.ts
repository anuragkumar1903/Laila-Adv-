import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { pathExists } from '../utils/fs-utils.js';
import { DATA_DIR } from '../config.js';

const execAsync = promisify(exec);

export type ToolStatus = 'available' | 'missing' | 'unknown';

export interface ToolCheck {
  name: string;
  status: ToolStatus;
  details?: string;
  installHint?: string;
  installable?: boolean;
  installCommand?: string;
  /** If true, this tool is not required for core functionality */
  optional?: boolean;
}

export interface InstallerAvailability {
  winget: boolean;
  choco: boolean;
  scoop: boolean;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    const probe = process.platform === 'win32'
      ? `where.exe ${command}`
      : `command -v ${command}`;
    await execAsync(probe, { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectInstallers(): Promise<InstallerAvailability> {
  return {
    winget: await commandExists('winget'),
    choco:  await commandExists('choco'),
    scoop:  await commandExists('scoop'),
  };
}

function pickInstallCommand(
  options: { winget?: string; choco?: string; scoop?: string; npm?: string },
  installers: InstallerAvailability,
): string | undefined {
  if (installers.winget && options.winget) return options.winget;
  if (installers.choco  && options.choco)  return options.choco;
  if (installers.scoop  && options.scoop)  return options.scoop;
  return options.npm;
}

// ─── Core tool checks ────────────────────────────────────────────────────

async function checkNode(installers: InstallerAvailability): Promise<ToolCheck> {
  const available = await commandExists('node');
  if (!available) {
    return {
      name: 'Node.js',
      status: 'missing',
      installHint: 'Install Node.js LTS.',
      installable: true,
      installCommand: pickInstallCommand({
        winget: 'winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements',
        choco:  'choco install nodejs-lts -y',
        scoop:  'scoop install nodejs-lts',
      }, installers),
    };
  }

  try {
    const { stdout } = await execAsync('node --version', { timeout: 5_000 });
    return { name: 'Node.js', status: 'available', details: stdout.trim(), installable: false };
  } catch {
    return { name: 'Node.js', status: 'unknown' };
  }
}

async function checkGit(installers: InstallerAvailability): Promise<ToolCheck> {
  const available = await commandExists('git');
  return available
    ? { name: 'Git', status: 'available', details: 'Installed', installable: false }
    : {
      name: 'Git',
      status: 'missing',
      installHint: 'Install Git for Windows.',
      installable: true,
      installCommand: pickInstallCommand({
        winget: 'winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements',
        choco:  'choco install git -y',
        scoop:  'scoop install git',
      }, installers),
    };
}

// ─── Optional tool checks ────────────────────────────────────────────────

/**
 * n8n is fully optional.
 * Laila works without it — it is only used for fire-and-forget
 * workflow notifications (task.completed, validation.failed events).
 * Enable with: N8N_ENABLED=true in environment.
 */
async function checkN8n(installers: InstallerAvailability): Promise<ToolCheck> {
  const available  = await commandExists('n8n');
  const localN8n   = await pathExists(path.join(DATA_DIR, 'n8n'));
  const n8nEnabled = process.env['N8N_ENABLED'] === 'true';

  // If n8n is not enabled via env, report as optional/skipped — not missing
  if (!n8nEnabled) {
    return {
      name:     'n8n (optional)',
      status:   'unknown',
      details:  'Not enabled. Set N8N_ENABLED=true to activate workflow notifications.',
      optional: true,
      installable: false,
    };
  }

  if (!available && localN8n) {
    return {
      name:     'n8n (optional)',
      status:   'available',
      details:  'Local n8n data directory found at data/n8n',
      optional: true,
      installable: false,
    };
  }

  return available
    ? {
      name:     'n8n (optional)',
      status:   'available',
      details:  'Installed',
      optional: true,
      installable: false,
    }
    : {
      name:        'n8n (optional)',
      status:      'missing',
      installHint: 'Run: npm install -g n8n   (only needed for workflow notifications)',
      optional:    true,
      installable: true,
      installCommand: pickInstallCommand({ npm: 'npm install -g n8n' }, installers),
    };
}

// ─── Main export ─────────────────────────────────────────────────────────

export async function runToolChecks(): Promise<ToolCheck[]> {
  const installers = await detectInstallers();
  const tools = await Promise.all([
    checkNode(installers),
    checkGit(installers),
    checkN8n(installers),   // Docker removed — not a dependency of Laila
  ]);
  return tools;
}

export async function isWritablePath(targetPath: string): Promise<boolean> {
  return pathExists(targetPath);
}
