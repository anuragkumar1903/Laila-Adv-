/**
 * anthropic.ts — Anthropic Claude provider
 *
 * Uses Anthropic's native /v1/messages API (NOT OpenAI-compatible).
 * Supports Claude Opus, Sonnet, and Haiku families.
 */

import type { LLMProvider, LLMMessage, ChatOptions, ChatResponse, ModelInfo } from './base.js';
import { LLMError } from './base.js';

// ─── Model catalogue ──────────────────────────────────────────────────────

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-5',         name: 'Claude Sonnet 4.5',      description: 'Latest Sonnet — recommended' },
  { id: 'claude-opus-4-5',           name: 'Claude Opus 4.5',        description: 'Most powerful Claude' },
  { id: 'claude-haiku-3-5',          name: 'Claude Haiku 3.5',       description: 'Fastest & cheapest' },
  { id: 'claude-3-5-sonnet-20241022',name: 'Claude 3.5 Sonnet',      description: 'Previous Sonnet — stable' },
  { id: 'claude-3-opus-20240229',    name: 'Claude 3 Opus',          description: 'Previous Opus' },
  { id: 'claude-3-haiku-20240307',   name: 'Claude 3 Haiku',         description: 'Previous Haiku' },
];

// ─── Internal API types ───────────────────────────────────────────────────

interface AnthropicModelsResponse {
  data: Array<{
    id: string;
    display_name?: string;
    created_at?: string;
  }>;
  has_more: boolean;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  top_p?: number;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

// ─── Provider ─────────────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly id       = 'anthropic';
  readonly displayName = 'Anthropic (Claude)';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';

  constructor(opts: { apiKey: string; model?: string; timeoutMs?: number }) {
    this.apiKey    = opts.apiKey;
    this.model     = opts.model     ?? 'claude-sonnet-4-5';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async healthCheck(): Promise<boolean> {
    // Anthropic has no public ping endpoint — attempt a minimal models list
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal:  AbortSignal.timeout(5_000),
      });
      // 200 or 404 both mean the server is reachable and the key is valid-ish
      return res.status !== 401 && res.status !== 403;
    } catch { return false; }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Try Anthropic's /v1/models endpoint (added mid-2024, may expand)
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this._headers(),
        signal:  AbortSignal.timeout(5_000),
      });

      if (res.ok) {
        const data = await res.json() as AnthropicModelsResponse;
        const live = (data.data ?? []).map(m => {
          // Try to match against known preset for a better description
          const preset = ANTHROPIC_MODELS.find(p => p.id === m.id);
          return preset ?? {
            id:   m.id,
            name: m.display_name ?? m.id,
          };
        });
        if (live.length > 0) return live;
      }
    } catch { /* fall through */ }

    // Fallback: hardcoded list — always includes the known good models
    return ANTHROPIC_MODELS;
  }

  async modelExists(model: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some(m => m.id === model);
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    // Anthropic separates system messages from the conversation
    const systemMessages = messages.filter(m => m.role === 'system');
    const chatMessages   = messages.filter(m => m.role !== 'system');

    const system = systemMessages.map(m => m.content).join('\n\n') || undefined;

    // Anthropic requires alternating user/assistant turns — merge consecutive same-role messages
    const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of chatMessages) {
      const role = msg.role as 'user' | 'assistant';
      const last = merged[merged.length - 1];
      if (last && last.role === role) {
        last.content += '\n' + msg.content;
      } else {
        merged.push({ role, content: msg.content });
      }
    }

    // Must start with a user message
    if (merged.length === 0 || merged[0]?.role !== 'user') {
      merged.unshift({ role: 'user', content: 'Continue.' });
    }

    const body: AnthropicRequest = {
      model:      this.model,
      max_tokens: options.maxTokens ?? 4096,
      messages:   merged,
      temperature: options.temperature ?? 0.2,
      top_p:       options.top_p       ?? 0.9,
    };
    if (system) body.system = system;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method:  'POST',
        headers: this._headers(),
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new LLMError(`Anthropic request timed out after ${this.timeoutMs / 1000}s`, this.id);
      }
      throw new LLMError(`Cannot reach Anthropic API: ${String(err)}`, this.id);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new LLMError('Invalid Anthropic API key. Check your key at console.anthropic.com.', this.id, 401);
      if (res.status === 429) throw new LLMError('Anthropic rate limit reached. Try again shortly.', this.id, 429);
      throw new LLMError(`Anthropic HTTP ${res.status}: ${text}`, this.id, res.status);
    }

    const data = await res.json() as AnthropicResponse;
    const textBlock = data.content.find(c => c.type === 'text');
    if (!textBlock) throw new LLMError('Anthropic returned no text content', this.id);

    return {
      content:    textBlock.text,
      tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
      model:      data.model,
      provider:   this.id,
    };
  }

  private _headers(): Record<string, string> {
    return {
      'Content-Type':      'application/json',
      'x-api-key':         this.apiKey,
      'anthropic-version': this.apiVersion,
    };
  }
}
