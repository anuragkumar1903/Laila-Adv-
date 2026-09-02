/**
 * config-loader.ts — Read Laila provider config
 *
 * Priority order (highest wins):
 *   1. Environment variables  (LAILA_PROVIDER, LAILA_MODEL, LAILA_API_KEY, LAILA_BASE_URL)
 *   2. Project config         (.laila/config.yaml in current project)
 *   3. Global config          (~/.laila/config.yaml)
 *   4. Defaults               (nothing — wizard will prompt)
 *
 * No external dependencies — parses YAML manually for the simple key:value
 * format we use, avoiding adding a yaml package dependency.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ProviderConfig, ProviderName } from '../llm/providers/base.js';

// ─── Config file paths ────────────────────────────────────────────────────

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), '.laila', 'config.yaml');
}

export function getProjectConfigPath(projectPath: string): string {
  return path.join(projectPath, '.laila', 'config.yaml');
}

// ─── Minimal YAML parser ──────────────────────────────────────────────────
// Handles only simple key: value pairs — enough for our config format.

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, ''); // strip quotes
    if (!key) continue;
    // FIX (High): Store the key regardless of whether value is empty.
    // An empty value is meaningful — it tells downstream code "this key was set
    // but left blank", so it won't silently fall back to a higher-priority config.
    // Callers should treat '' as "explicitly cleared" and warn the user.
    result[key] = value;
  }
  return result;
}

async function readYamlConfig(filePath: string): Promise<Partial<ProviderConfig> | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const raw     = parseSimpleYaml(content);

    const config: Partial<ProviderConfig> = {};
    if (raw['provider']) config.provider = raw['provider'] as ProviderName;
    if (raw['model'])    config.model    = raw['model'];
    if (raw['api_key'])  config.apiKey   = raw['api_key'];
    if (raw['base_url']) config.baseUrl  = raw['base_url'];

    return Object.keys(config).length > 0 ? config : null;
  } catch { return null; }
}

// ─── Load config ──────────────────────────────────────────────────────────

export async function loadProviderConfig(projectPath?: string): Promise<Partial<ProviderConfig>> {
  // Layer 1 — environment variables (highest priority)
  const fromEnv: Partial<ProviderConfig> = {};
  if (process.env['LAILA_PROVIDER']) fromEnv.provider = process.env['LAILA_PROVIDER'] as ProviderName;
  if (process.env['LAILA_MODEL'])    fromEnv.model    = process.env['LAILA_MODEL'];
  if (process.env['LAILA_API_KEY'])  fromEnv.apiKey   = process.env['LAILA_API_KEY'];
  if (process.env['LAILA_BASE_URL']) fromEnv.baseUrl  = process.env['LAILA_BASE_URL'];

  // If all required fields come from env, skip file reads
  if (fromEnv.provider && fromEnv.model) return fromEnv;

  // Layer 2 — project config
  const fromProject = projectPath
    ? await readYamlConfig(getProjectConfigPath(projectPath))
    : null;

  // Layer 3 — global config
  const fromGlobal = await readYamlConfig(getGlobalConfigPath());

  // Merge: env > project > global
  return {
    ...fromGlobal,
    ...fromProject,
    ...fromEnv,
  };
}

/** Returns true if a complete, usable provider config exists */
export function isConfigComplete(config: Partial<ProviderConfig>): boolean {
  if (!config.provider || !config.model) return false;
  // Cloud providers need an API key
  const cloudProviders: ProviderName[] = ['openai', 'anthropic', 'deepseek', 'groq', 'gemini', 'mistral'];
  if (cloudProviders.includes(config.provider as ProviderName) && !config.apiKey) return false;
  // openai-compat needs a base URL
  if (config.provider === 'openai-compat' && !config.baseUrl) return false;
  return true;
}

/** 
 * Search all config layers (env, project, global) for an API key that belongs 
 * to the specified provider. This prevents a project-level provider override 
 * from obscuring a valid global API key for a different provider.
 */
export async function getApiKeyForProvider(providerId: string, projectPath?: string): Promise<string | undefined> {
  if (process.env['LAILA_PROVIDER'] === providerId && process.env['LAILA_API_KEY']) {
    return process.env['LAILA_API_KEY'];
  }
  
  if (projectPath) {
    const fromProject = await readYamlConfig(getProjectConfigPath(projectPath));
    if (fromProject && fromProject.provider === providerId && fromProject.apiKey) {
      return fromProject.apiKey;
    }
  }

  const fromGlobal = await readYamlConfig(getGlobalConfigPath());
  if (fromGlobal && fromGlobal.provider === providerId && fromGlobal.apiKey) {
    return fromGlobal.apiKey;
  }

  return undefined;
}
