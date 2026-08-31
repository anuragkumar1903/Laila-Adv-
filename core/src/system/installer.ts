import { spawn } from 'child_process';

export interface InstallResult {
  success: boolean;
  output: string;
}

export async function installTool(command: string): Promise<InstallResult> {
  const normalized = command.trim();
  if (!normalized) {
    return { success: false, output: 'No install command provided.' };
  }

  return new Promise((resolve) => {
    // We use shell: true because the commands are full strings (e.g. 'npm install -g ...')
    // but spawn avoids maxBuffer limits and is preferred in enterprise apps.
    const child = spawn(normalized, {
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        output: output.trim(),
      });
    });

    child.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });

}