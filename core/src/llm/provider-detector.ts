/**
 * provider-detector.ts — Auto-detect locally running LLM providers
 *
 * Scans well-known local ports in parallel to find running providers.
 * Fast: all probes run concurrently with a 3s timeout each.
 */

import type { ModelInfo } from './providers/base.js';

export interface DetectedProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  models: ModelInfo[];
  running: boolean;
}

const PROBE_TIMEOUT_MS = 3_000;

// ─── Ollama ───────────────────────────────────────────────────────────────

async function probeOllama(host = 'http://localhost:11434'): Promise<DetectedProvider> {
  const result: DetectedProvider = {
    id:          'ollama',
    displayName: 'Ollama (local)',
    baseUrl:     host,
    models:      [],
    running:     false,
  };

  try {
    const res = await fetch(`${host}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return result;
    result.running = true;

    // Fetch installed models
    const tagsRes = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (tagsRes.ok) {
      const data = await tagsRes.json() as {
        models: Array<{ name: string; size: number; details?: { parameter_size?: string } }>;
      };
      result.models = data.models.map(m => ({
        id:          m.name,
        name:        m.name,
        description: m.details?.parameter_size
          ? `${m.details.parameter_size} — ${(m.size / 1e9).toFixed(1)} GB`
          : `${(m.size / 1e9).toFixed(1)} GB`,
      }));
    }
  } catch { /* not running */ }

  return result;
}

// ─── LM Studio ────────────────────────────────────────────────────────────

async function probeLMStudio(host = 'http://localhost:1234'): Promise<DetectedProvider> {
  const result: DetectedProvider = {
    id:          'lmstudio',
    displayName: 'LM Studio (local)',
    baseUrl:     `${host}/v1`,
    models:      [],
    running:     false,
  };

  try {
    const res = await fetch(`${host}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return result;
    result.running = true;

    const data = await res.json() as { data: Array<{ id: string }> };
    result.models = (data.data ?? []).map(m => ({ id: m.id, name: m.id }));
  } catch { /* not running */ }

  return result;
}

// ─── Custom endpoint ──────────────────────────────────────────────────────

export async function probeCustomEndpoint(baseUrl: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch { return false; }
}

// ─── Main detector ────────────────────────────────────────────────────────

export interface LocalDetectionResult {
  ollama:   DetectedProvider;
  lmstudio: DetectedProvider;
  anyFound: boolean;
}

/**
 * Probe all known local ports in parallel.
 * Returns results for both Ollama and LM Studio.
 */
export async function detectLocalProviders(): Promise<LocalDetectionResult> {
  const [ollama, lmstudio] = await Promise.all([
    probeOllama(),
    probeLMStudio(),
  ]);

  return {
    ollama,
    lmstudio,
    anyFound: ollama.running || lmstudio.running,
  };
}
