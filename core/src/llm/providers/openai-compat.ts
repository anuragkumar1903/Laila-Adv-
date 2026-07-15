/**
 * openai-compat.ts — OpenAI-compatible provider
 *
 * Handles any endpoint that speaks the OpenAI /v1/chat/completions format:
 *   - OpenAI (api.openai.com)
 *   - DeepSeek (api.deepseek.com)
 *   - Groq (api.groq.com/openai)
 *   - Mistral (api.mistral.ai)
 *   - LM Studio (localhost:1234)
 *   - Your own fine-tuned model served via vLLM / llama.cpp / text-gen-webui
 */

import type { LLMProvider, LLMMessage, ChatOptions, ChatResponse, ModelInfo } from './base.js';
import { LLMError } from './base.js';

// ─── Well-known provider configs ─────────────────────────────────────────

export const OPENAI_COMPAT_PRESETS = {
  openai: {
    baseUrl:     'https://api.openai.com/v1',
    displayName: 'OpenAI',
    models: [
      { id: 'gpt-4o',          name: 'GPT-4o',          description: 'Most capable, multimodal' },
      { id: 'gpt-4o-mini',     name: 'GPT-4o mini',     description: 'Fast & cheap — recommended' },
      { id: 'gpt-4-turbo',     name: 'GPT-4 Turbo',     description: '128k context' },
      { id: 'gpt-3.5-turbo',   name: 'GPT-3.5 Turbo',   description: 'Legacy, very cheap' },
      { id: 'o1',              name: 'o1',               description: 'Deep reasoning' },
      { id: 'o1-mini',         name: 'o1-mini',         description: 'Fast reasoning' },
      { id: 'o3-mini',         name: 'o3-mini',         description: 'Latest reasoning model' },
    ] as ModelInfo[],
  },
  deepseek: {
    baseUrl:     'https://api.deepseek.com/v1',
    displayName: 'DeepSeek',
    models: [
      { id: 'deepseek-chat',     name: 'DeepSeek Chat',     description: 'General purpose' },
      { id: 'deepseek-coder',    name: 'DeepSeek Coder',    description: 'Code focused' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1',       description: 'Deep reasoning (slow)' },
    ] as ModelInfo[],
  },
  groq: {
    baseUrl:     'https://api.groq.com/openai/v1',
    displayName: 'Groq',
    models: [
      { id: 'llama-3.1-70b-versatile',  name: 'Llama 3.1 70B',  description: 'Most capable on Groq' },
      { id: 'llama-3.1-8b-instant',     name: 'Llama 3.1 8B',   description: 'Ultra fast' },
      { id: 'mixtral-8x7b-32768',       name: 'Mixtral 8x7B',   description: '32k context' },
      { id: 'gemma2-9b-it',             name: 'Gemma 2 9B',     description: 'Google model' },
    ] as ModelInfo[],
  },
  mistral: {
    baseUrl:     'https://api.mistral.ai/v1',
    displayName: 'Mistral',
    models: [
      { id: 'mistral-large-latest',  name: 'Mistral Large',  description: 'Most capable' },
      { id: 'mistral-medium-latest', name: 'Mistral Medium', description: 'Balanced' },
      { id: 'codestral-latest',      name: 'Codestral',      description: 'Code specialist' },
      { id: 'mistral-small-latest',  name: 'Mistral Small',  description: 'Fast & cheap' },
    ] as ModelInfo[],
  },
  lmstudio: {
    baseUrl:     'http://localhost:1234/v1',
    displayName: 'LM Studio (local)',
    models: [] as ModelInfo[], // fetched live from LM Studio
  },
} as const;

export type OpenAICompatPreset = keyof typeof OPENAI_COMPAT_PRESETS;

// ─── Internal API types ───────────────────────────────────────────────────

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelsResponse {
  data: Array<{ id: string; owned_by?: string }>;
}

// ─── Provider ─────────────────────────────────────────────────────────────

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly presetModels: ModelInfo[];

  constructor(opts: {
    id?: string;
    displayName?: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs?: number;
    presetModels?: ModelInfo[];
  }) {
    this.id           = opts.id          ?? 'openai-compat';
    this.displayName  = opts.displayName ?? 'OpenAI Compatible';
    this.baseUrl      = opts.baseUrl.replace(/\/$/, '');
    this.apiKey       = opts.apiKey      ?? '';
    this.model        = opts.model;
    this.timeoutMs    = opts.timeoutMs   ?? 120_000;
    this.presetModels = opts.presetModels ?? [];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const res = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch { return false; }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Always try live fetch first — picks up new models automatically
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const res = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });

      if (res.ok) {
        const data = await res.json() as OpenAIModelsResponse;
        const live = (data.data ?? [])
          // Filter to chat-capable models only — exclude embedding/audio/image models
          .filter(m => {
            const id = m.id.toLowerCase();
            return (
              id.includes('gpt')       ||
              id.includes('o1')        ||
              id.includes('o3')        ||
              id.includes('o4')        ||
              id.includes('deepseek')  ||
              id.includes('llama')     ||
              id.includes('mixtral')   ||
              id.includes('gemma')     ||
              id.includes('mistral')   ||
              id.includes('codestral') ||
              // For local / custom servers — include everything
              this.id === 'lmstudio'   ||
              this.id === 'openai-compat'
            );
          })
          .map(m => {
            // Try to find a matching preset entry for a richer description
            const preset = this.presetModels.find(p => p.id === m.id);
            return preset ?? { id: m.id, name: m.id };
          });

        if (live.length > 0) return live;
      }
    } catch { /* network error or provider down — fall through to preset */ }

    // Fallback: hardcoded preset list (works offline / before first API call)
    return this.presetModels;
  }

  async modelExists(model: string): Promise<boolean> {
    const models = await this.listModels();
    if (models.length === 0) return true; // assume it exists if we can't list
    return models.some(m => m.id === model);
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model:       this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      top_p:       options.top_p       ?? 0.9,
      stream:      false,
    };
    if (options.maxTokens) body['max_tokens'] = options.maxTokens;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    // Attempt with one automatic retry on 429 (rate limit)
    for (let attempt = 0; attempt <= 1; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method:  'POST',
          headers,
          body:    JSON.stringify(body),
          signal:  AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new LLMError(`Request timed out after ${this.timeoutMs / 1000}s`, this.id);
        }
        throw new LLMError(`Cannot reach ${this.displayName} at ${this.baseUrl}: ${String(err)}`, this.id);
      }

      if (!res.ok) {
        // Surface helpful messages for common auth errors
        if (res.status === 401) {
          throw new LLMError(`Invalid API key for ${this.displayName}. Check your key and try again.`, this.id, 401);
        }
        if (res.status === 429) {
          // Parse Retry-After header — OpenAI sets this on rate limit responses
          const retryAfterRaw = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-requests');
          const waitSecs = retryAfterRaw ? parseFloat(retryAfterRaw) : 10;
          const waitMs   = isNaN(waitSecs) ? 10_000 : Math.min(waitSecs * 1000, 60_000);

          if (attempt === 0) {
            // First hit — wait and retry once automatically
            process.stdout.write(`\n  ⏳ Rate limit hit on ${this.displayName}. Waiting ${Math.ceil(waitMs / 1000)}s then retrying…`);
            await new Promise(r => setTimeout(r, waitMs));
            process.stdout.write(' retrying\n');
            continue;
          }

          // Second hit — give up with a helpful message
          throw new LLMError(
            `Rate limit reached on ${this.displayName}. Waited ${Math.ceil(waitMs / 1000)}s but still limited.\n` +
            `  Tips:\n` +
            `  • Switch to a cheaper model: /model → GPT-4o mini or GPT-3.5 Turbo\n` +
            `  • Check your usage limits at platform.openai.com/account/limits\n` +
            `  • Consider switching provider: /provider`,
            this.id, 429,
          );
        }
        const text = await res.text().catch(() => '');
        throw new LLMError(`${this.displayName} HTTP ${res.status}: ${text}`, this.id, res.status);
      }

      const data = await res.json() as OpenAIChatResponse;
      const choice = data.choices[0];
      if (!choice) throw new LLMError(`${this.displayName} returned no choices`, this.id);

      return {
        content:    choice.message.content,
        tokensUsed: data.usage?.total_tokens ?? 0,
        model:      data.model,
        provider:   this.id,
      };
    }

    // Should never reach here
    throw new LLMError(`Unexpected retry loop exit in ${this.displayName}`, this.id);
  }
}

// ─── Factory helpers for each preset ──────────────────────────────────────

export function makeOpenAIProvider(apiKey: string, model: string): OpenAICompatProvider {
  const p = OPENAI_COMPAT_PRESETS.openai;
  return new OpenAICompatProvider({ id: 'openai', displayName: p.displayName, baseUrl: p.baseUrl, apiKey, model, presetModels: [...p.models] });
}

export function makeDeepSeekProvider(apiKey: string, model: string): OpenAICompatProvider {
  const p = OPENAI_COMPAT_PRESETS.deepseek;
  return new OpenAICompatProvider({ id: 'deepseek', displayName: p.displayName, baseUrl: p.baseUrl, apiKey, model, presetModels: [...p.models] });
}

export function makeGroqProvider(apiKey: string, model: string): OpenAICompatProvider {
  const p = OPENAI_COMPAT_PRESETS.groq;
  return new OpenAICompatProvider({ id: 'groq', displayName: p.displayName, baseUrl: p.baseUrl, apiKey, model, presetModels: [...p.models] });
}

export function makeMistralProvider(apiKey: string, model: string): OpenAICompatProvider {
  const p = OPENAI_COMPAT_PRESETS.mistral;
  return new OpenAICompatProvider({ id: 'mistral', displayName: p.displayName, baseUrl: p.baseUrl, apiKey, model, presetModels: [...p.models] });
}

export function makeLMStudioProvider(model: string, baseUrl = 'http://localhost:1234/v1'): OpenAICompatProvider {
  return new OpenAICompatProvider({ id: 'lmstudio', displayName: 'LM Studio (local)', baseUrl, model });
}

export function makeCustomProvider(baseUrl: string, model: string, apiKey?: string): OpenAICompatProvider {
  return new OpenAICompatProvider({ id: 'openai-compat', displayName: 'Custom endpoint', baseUrl, model, apiKey });
}
