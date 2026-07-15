import { spawn } from 'child_process';
import type { ValidationResult } from '../types.js';

const STEP_TIMEOUT_MS = 120_000;

/**
 * Run a shell command and return a ValidationResult.
 * Uses spawn (not exec) to handle large stdout/stderr without buffer overflow.
 */
export async function runStep(
  step: ValidationResult['step'],
  command: string,
  args: string[],
  cwd: string,
): Promise<ValidationResult> {
  const start = Date.now();

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      shell: true,
      stdio: 'pipe',
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, STEP_TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', exitCode => {
      clearTimeout(timer);
      const code = timedOut ? 124 : (exitCode ?? 1);
      resolve({
        step,
        success: code === 0,
        stdout: stdout.slice(-4000), // keep last 4k chars
        stderr: stderr.slice(-4000),
        exitCode: code,
        durationMs: Date.now() - start,
      });
    });
  });
}
