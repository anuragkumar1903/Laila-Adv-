import path from 'path';
import { readFileSafe } from '../utils/fs-utils.js';
import { runStep } from './runner.js';
import { notify } from '../n8n/n8n-client.js';
import { logger } from '../utils/logger.js';
import type { ValidationReport, ValidationResult } from '../types.js';

type Scripts = Record<string, string>;

async function getAvailableScripts(projectPath: string): Promise<Scripts> {
  const raw = await readFileSafe(path.join(projectPath, 'package.json'));
  if (!raw) return {};
  try { return (JSON.parse(raw) as { scripts?: Scripts }).scripts ?? {}; }
  catch { return {}; }
}

function getPmCmd(pkgManager: string): string {
  switch (pkgManager) {
    case 'yarn': return 'yarn';
    case 'pnpm': return 'pnpm';
    case 'bun':  return 'bun';
    default:     return 'npm';
  }
}

const STEPS: Array<{ step: ValidationResult['step']; scriptNames: string[] }> = [
  { step: 'build', scriptNames: ['build', 'compile', 'tsc'] },
  { step: 'lint',  scriptNames: ['lint', 'eslint', 'check'] },
  { step: 'test',  scriptNames: ['test', 'test:unit', 'test:ci'] },
];

/**
 * Run build → lint → test using the project's own npm scripts.
 * Stops at first failure.
 */
export async function runValidation(
  projectPath: string,
  pkgManager = 'npm',
): Promise<ValidationReport> {
  const scripts = await getAvailableScripts(projectPath);
  const pm      = getPmCmd(pkgManager);
  const start   = Date.now();
  const results: ValidationResult[] = [];

  for (const { step, scriptNames } of STEPS) {
    const scriptName = scriptNames.find(n => n in scripts);
    if (!scriptName) {
      logger.debug(`Skipping ${step}: no matching script found`);
      continue;
    }

    logger.info(`Validation: running ${pm} run ${scriptName}…`);
    const result = await runStep(step, pm, ['run', scriptName], projectPath);
    results.push(result);

    if (!result.success) {
      logger.warn(`Validation failed at step: ${step} (exit ${result.exitCode})`);
      notify({
        event: 'validation.failed',
        payload: { step, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      break; // Stop on first failure
    }
  }

  const overall = results.length > 0 && results.every(r => r.success);
  return {
    success: overall,
    results,
    totalDurationMs: Date.now() - start,
  };
}
