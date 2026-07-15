import { OLLAMA_HOST, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS } from '../config.js';
import type { OllamaMessage, OllamaChatRequest, OllamaChatResponse } from '../types.js';

export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** Check if the Ollama server is reachable. */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch { return false; }
}

/** Check if the target model is available locally. */
export async function modelExists(model = OLLAMA_MODEL): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { models: Array<{ name: string }> };
    return data.models.some(m => m.name === model || m.name.startsWith(model.split(':')[0] ?? ''));
  } catch { return false; }
}

/**
 * Send a chat request to Ollama and return the full response text.
 * Uses non-streaming for simplicity — suitable for v1.
 */
export async function chat(
  messages: OllamaMessage[],
  options?: OllamaChatRequest['options'],
): Promise<{ content: string; tokensUsed: number }> {
  const body: OllamaChatRequest = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    options: {
      temperature: 0.2,
      top_p: 0.9,
      num_ctx: 4096,
      ...options,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new OllamaError(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw new OllamaError(`Cannot reach Ollama at ${OLLAMA_HOST}: ${String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OllamaError(`Ollama HTTP ${res.status}: ${text}`, res.status);
  }

  const data = await res.json() as OllamaChatResponse;
  return {
    content: data.message.content,
    tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
  };
}
