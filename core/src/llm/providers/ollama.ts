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
  message: { role: string; content: string | null; tool_calls?: any[] };
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
    // No hardcoded default model — callers must pass a model or use getDefaultModel()
    // to dynamically fetch the first available model from the Ollama instance.
    this.model     = opts.model     ?? '';
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

  /**
   * Return the first locally available model name.
   * Used by provider-factory when no model is configured so the user
   * doesn't have to hardcode a model name in config.
   */
  async getDefaultModel(): Promise<string | null> {
    const models = await this.listModels();
    return models[0]?.id ?? null;
  }

  async modelExists(model: string): Promise<boolean> {
    const models = await this.listModels();
    const target = model.toLowerCase();
    // FIX (Low #31): Use exact match first, then fall back to tag-aware prefix match.
    // Old code used startsWith(name.split(':')[0]) which made `llama3` match
    // `llama3.1`, `llama3-uncensored`, etc. — selecting the wrong model.
    // New logic: exact id match OR (id without tag) === (model without tag).
    return models.some(m => {
      const mId = m.id.toLowerCase();
      if (mId === target) return true;
      // Allow matching by name without the version tag (e.g. "llama3" matches "llama3:latest")
      const mBase = mId.split(':')[0] ?? mId;
      const tBase = target.split(':')[0] ?? target;
      return mBase === tBase; // must be exact base match, not just startsWith
    });
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const modelToUse = this.model || await this.getDefaultModel();
    if (!modelToUse) {
      throw new LLMError('No models available in Ollama. Pull a model first: ollama pull <model>', this.id);
    }

    const body: Record<string, unknown> = {
      model:   modelToUse,
      messages,
      stream:  false,
      options: {
        temperature: options.temperature ?? 0.2,
        top_p:       options.top_p       ?? 0.9,
        num_ctx:     8192,   // 8k context — enough for identity + skill + files + history
      },
    };
    
    // Wire up Native Tool Calling!
    if (options.tools && options.tools.length > 0) {
      body['tools'] = options.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
    }

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
      content:    data.message.content || '',
      toolCalls:  data.message.tool_calls?.map((tc: any) => ({
        id: tc.id || tc.function.name, // Ollama sometimes omits ID
        name: tc.function.name,
        arguments: (typeof tc.function.arguments === 'string' && tc.function.arguments) ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {})
      })),
      tokensUsed: (data.eval_count ?? 0) + (data.prompt_eval_count ?? 0),
      model:      data.model,
      provider:   this.id,
    };
  }

  async embed(text: string, embedModel = 'nomic-embed-text'): Promise<number[]> {
    const res = await fetch(`${this.host}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: text }),
    });
    if (!res.ok) throw new Error('Ollama embed failed: ' + await res.text());
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }
}
