import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// ── Package Root ──────────────────────────────────────────────────────────
// __dirname will be core/dist/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

// ── Global User Data (laila.db, projects) ─────────────────────────────────
// When installed globally via NPM, writing to the package folder causes Permission Denied.
// Industry standard is to use the user's home directory (~/.laila)
export const USER_HOME    = os.homedir();
export const LAILA_DIR    = path.join(USER_HOME, '.laila');
export const DATA_DIR     = path.join(LAILA_DIR, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const DB_PATH      = path.join(DATA_DIR, 'laila.db');

// ── Skills ───────────────────────────────────────────────────────────────
// Look for user-provided skills in the global ~/.laila/skills directory.
export const SKILLS_DIR   = path.join(LAILA_DIR, 'skills');

// ── Ollama (legacy defaults — overridden by provider config) ──────────────
export const OLLAMA_HOST       = process.env['OLLAMA_HOST']  ?? 'http://localhost:11434';
export const OLLAMA_MODEL      = process.env['OLLAMA_MODEL'] ?? 'qwen2.5-coder:7b';
export const OLLAMA_TIMEOUT_MS = 120_000;

// ── Provider (new multi-provider system) ─────────────────────────────────
// These env vars are the top-priority override for the provider factory.
// If set, they skip ~/.laila/config.yaml and .laila/config.yaml entirely.
export const LAILA_PROVIDER = process.env['LAILA_PROVIDER']; // e.g. 'openai', 'ollama', 'anthropic'
export const LAILA_MODEL    = process.env['LAILA_MODEL'];    // e.g. 'gpt-4o-mini'
export const LAILA_API_KEY  = process.env['LAILA_API_KEY'];  // API key for cloud providers
export const LAILA_BASE_URL = process.env['LAILA_BASE_URL']; // custom endpoint URL

// ── Context limits (tuned for qwen2.5-coder:7b @ 4 GB VRAM) ──────────────
export const MAX_FILE_LINES      = 300;   // lines per file before truncation
export const MAX_RELEVANT_FILES  = 5;     // files sent to LLM per request
// NOTE (Ponytail): MAX_CONTEXT_CHARS was exported here but prompt-builder.ts
// uses its own local getContextLimit() instead. Kept for backwards-compat but
// no longer the primary source of truth.
export const MAX_CONTEXT_CHARS   = 14_000; // ≈ 3.5k tokens – safe upper bound
export const SESSION_HISTORY_SIZE = 8;    // previous messages kept in context

// ── N8N ───────────────────────────────────────────────────────────────────
export const N8N_WEBHOOK_URL = process.env['N8N_WEBHOOK_URL'] ?? 'http://localhost:5678/webhook/laila';
export const N8N_ENABLED     = process.env['N8N_ENABLED'] === 'true';

// ── Scanner exclusions ───────────────────────────────────────────────────
export const SCAN_EXCLUDES: string[] = [
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.cache', 'vendor',
  '.venv', 'venv', 'env', 'target', 'out', '.gradle',
  '.idea', '.vscode', '*.min.js', '*.min.css', '.DS_Store',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
];
