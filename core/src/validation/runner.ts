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

    // FIX (Medium #18): Use a minimal env — do NOT pass the full process.env.
    // The validation runner may execute `npm test`, which could be a malicious
    // script. It must not have access to LAILA_API_KEY, AWS credentials, etc.
    const safeEnv: Record<string, string> = {
      PATH:        process.env['PATH']        ?? '',
      HOME:        process.env['HOME']        ?? '',
      USERPROFILE: process.env['USERPROFILE'] ?? '',
      TEMP:        process.env['TEMP']        ?? '',
      TMP:         process.env['TMP']         ?? '',
      TMPDIR:      process.env['TMPDIR']      ?? '',
      SYSTEMROOT:  process.env['SYSTEMROOT']  ?? '',
      NODE_ENV:    process.env['NODE_ENV']    ?? '',
      CI:          'true',
      FORCE_COLOR: '0',
    };

    const child = spawn(command, args, {
      cwd,
      shell: false,  // FIX: args are already an array, no shell needed
      stdio: 'pipe',
      env: safeEnv,
    });

    // FIX (High #10): Handle spawn 'error' event — fires when the binary doesn't
    // exist or cannot be executed. Without this the process crashes.
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        step,
        success: false,
        stdout: stdout.slice(-4000),
        stderr: (stderr + `\nSpawn error: ${err.message}`).slice(-4000),
        exitCode: 1,
        durationMs: Date.now() - start,
      });
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
