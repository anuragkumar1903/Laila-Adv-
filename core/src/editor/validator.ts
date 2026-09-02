import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { pathExists, readJSON } from '../utils/fs-utils.js';

const execAsync = promisify(exec);

export async function validateProject(projectPath: string): Promise<{ success: boolean; log: string }> {
  const pkgJsonPath = path.join(projectPath, 'package.json');
  if (!(await pathExists(pkgJsonPath))) return { success: true, log: 'No package.json, skipping validation.' };
  
  const pkg = await readJSON<any>(pkgJsonPath) || {};
  const scripts = pkg.scripts || {};

  // ponytail: only run what is explicitly defined and fast. We skip test by default to avoid slow test suites during interactive chat, but we run type checks if available.
  const checks = [];
  if (scripts['typecheck']) checks.push('npm run typecheck');
  else if (scripts['build']) checks.push('npm run build'); // fallback to build

  if (checks.length === 0) return { success: true, log: 'No applicable validation scripts found.' };

  let fullLog = '';
  for (const cmd of checks) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: projectPath, timeout: 30000 });
      fullLog += `\n[${cmd} OK]\n${stdout}\n${stderr}`;
    } catch (err: any) {
      fullLog += `\n[${cmd} FAILED]\n${err.stdout}\n${err.stderr}\n${err.message}`;
      return { success: false, log: fullLog.trim() };
    }
  }

  return { success: true, log: fullLog.trim() };
}
