import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface InstallResult {
  success: boolean;
  output: string;
}

export async function installTool(command: string): Promise<InstallResult> {
  const normalized = command.trim();
  if (!normalized) {
    return { success: false, output: 'No install command provided.' };
  }

  try {
    const { stdout, stderr } = await execAsync(normalized, {
      timeout: 20 * 60 * 1000,
      windowsHide: true,
      env: process.env,
    });

    return {
      success: true,
      output: [stdout, stderr].filter(Boolean).join('\n').trim(),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: message };
  }
}