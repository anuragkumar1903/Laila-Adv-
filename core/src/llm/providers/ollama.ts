/**
 * ollama.ts — Ollama local LLM provider
 *
 * Talks to a locally running Ollama instance.
 * Default host: http://localhost:11434
 */

import type { LLMProvider, LLMMessage, ChatOptions, ChatResponse, ModelInfo } from './base.js';
import { LLMError } from './base.js';

// ─── Internal Ollama API types ────────────────────────────────────────────

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    size: number;
    details?: { parameter_size?: string };
  }>;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

// ─── Provider ─────────────────────────────────────────────────────────────

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama (local)';

  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: { host?: string; model?: string; timeoutMs?: number } = {}) {
    this.host      = opts.host      ?? 'http://localhost:11434';
    this.model     = opts.model     ?? 'qwen2.5-coder:7b';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/version`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch { return false; }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const data = await res.json() as OllamaTagsResponse;
      return data.models.map(m => ({
        id:          m.name,
        name:        m.name,
        description: m.details?.parameter_size
          ? `${m.details.parameter_size} — ${(m.size / 1e9).toFixed(1)} GB`
          : `${(m.size / 1e9).toFixed(1)} GB`,
      }));
    } catch { return []; }
  }

  async modelExists(model: string): Promise<boolean> {
    const models = await this.listModels();
    const target = model.toLowerCase();
    return models.some(
      m => m.id.toLowerCase() === target ||
           m.id.toLowerCase().startsWith(target.split(':')[0] ?? ''),
    );
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const body = {
      model:   this.model,
      messages,
      stream:  false,
      options: {
        temperature: options.temperature ?? 0.2,
        top_p:       options.top_p       ?? 0.9,
        num_ctx:     8192,   // 8k context — enough for identity + skill + files + history
      },
    };

    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new LLMError(`Request timed out after ${this.timeoutMs / 1000}s`, this.id);
      }
      throw new LLMError(`Cannot reach Ollama at ${this.host}: ${String(err)}`, this.id);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`Ollama HTTP ${res.status}: ${text}`, this.id, res.status);
    }

    const data = await res.json() as OllamaChatResponse;
    return {
      content:    data.message.content,
      tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
      model:      data.model,
      provider:   this.id,
    };
  }
}
