/**
 * config-writer.ts — Save Laila provider config to disk
 *
 * API keys always go to ~/.laila/config.yaml (global) — never inside the
 * project folder where they might accidentally get committed to git.
 *
 * Non-sensitive settings (provider, model) can optionally be saved to
 * the project's .laila/config.yaml for per-project model switching.
 */

import { writeFile, mkdir, chmod } from 'fs/promises';
import path from 'path';
import os   from 'os';
import type { ProviderConfig } from '../llm/providers/base.js';
import { getGlobalConfigPath, getProjectConfigPath } from './config-loader.js';

// ─── YAML serializer ──────────────────────────────────────────────────────

function toYaml(config: Partial<ProviderConfig>): string {
  // Wrap string values in double quotes and escape backslashes and internal
  // double quotes so that values containing '#' or special chars don't
  // create invalid YAML (e.g. inline comments).
  const escape = (v: string) =>
    '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

  const lines: string[] = [
    '# Laila provider configuration',
    '# Generated automatically — you can edit this file.',
    '# API keys are stored here only in the global config (~/.laila/config.yaml).',
    '# Add .laila/ to your .gitignore to keep keys out of version control.',
    '',
  ];

  if (config.provider) lines.push(`provider: ${escape(config.provider)}`);
  if (config.model)    lines.push(`model: ${escape(config.model)}`);
  if (config.baseUrl)  lines.push(`base_url: ${escape(config.baseUrl)}`);
  if (config.apiKey)   lines.push(`api_key: ${escape(config.apiKey)}`);

  return lines.join('\n') + '\n';
}

// ─── Directory helper ─────────────────────────────────────────────────────

// No existsSync guard needed — mkdir with recursive:true is a no-op when the
// directory already exists, and the guard introduced a TOCTOU race condition.
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

// ─── Save global config ───────────────────────────────────────────────────

/**
 * Save the full config (including API key) to ~/.laila/config.yaml.
 * After writing, the file is chmod'd to 0o600 (owner read/write only) so
 * that the API key is not world-readable on POSIX systems.
 */
export async function saveGlobalConfig(config: Partial<ProviderConfig>): Promise<void> {
  const filePath = getGlobalConfigPath();
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, toYaml(config), 'utf8');

  // Restrict to owner-only (rw-------).  chmod is best-effort — it may not
  // work on Windows (FAT32/NTFS ACLs differ), so we swallow the error.
  try {
    await chmod(filePath, 0o600);
  } catch {
    // chmod may not work on Windows — best effort
  }
}

// ─── Save project config ──────────────────────────────────────────────────

/**
 * Save non-sensitive settings (provider, model, base_url — NO api_key)
 * to .laila/config.yaml inside the project, and add .laila/ to .gitignore.
 */
export async function saveProjectConfig(
  projectPath: string,
  config: Partial<ProviderConfig>,
): Promise<void> {
  // Strip API key — never write it into project config
  const { apiKey: _, ...safeConfig } = config;

  const configDir  = path.join(projectPath, '.laila');
  const configFile = getProjectConfigPath(projectPath);

  await ensureDir(configDir);
  await writeFile(configFile, toYaml(safeConfig), 'utf8');

  // Add .laila/ to .gitignore if it's not already there
  await ensureGitignore(projectPath);
}

// ─── .gitignore helper ────────────────────────────────────────────────────

async function ensureGitignore(projectPath: string): Promise<void> {
  const gitignorePath = path.join(projectPath, '.gitignore');
  const entry = '.laila/';

  try {
    const { readFile, appendFile } = await import('fs/promises');
    let existing = '';
    try { existing = await readFile(gitignorePath, 'utf8'); } catch { /* no gitignore yet */ }

    if (!existing.includes(entry)) {
      const prefix = existing.endsWith('\n') || existing === '' ? '' : '\n';
      await appendFile(gitignorePath, `${prefix}${entry}\n`, 'utf8');
    }
  } catch { /* silently skip — not critical */ }
}

// ─── Combined save ────────────────────────────────────────────────────────

/**
 * Save config after the setup wizard completes.
 * - API key + all fields → global config
 * - Provider + model (no key) → project config if projectPath given
 */
export async function saveWizardConfig(
  config: ProviderConfig,
  projectPath?: string,
): Promise<void> {
  await saveGlobalConfig(config);
  if (projectPath) {
    await saveProjectConfig(projectPath, config);
  }
}
