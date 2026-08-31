/**
 * gemini.ts — Google Gemini provider
 *
 * Uses Google's Generative Language API (not OpenAI-compatible).
 * Supports Gemini 1.5 Pro, Flash, and Gemini 2.0 Flash.
 */

import type { LLMProvider, LLMMessage, ChatOptions, ChatResponse, ModelInfo } from './base.js';
import { LLMError } from './base.js';

// ─── Model catalogue ──────────────────────────────────────────────────────

export const GEMINI_MODELS: ModelInfo[] = [
  { id: 'gemini-2.0-flash',        name: 'Gemini 2.0 Flash',    description: 'Latest, fast & capable — recommended', contextWindow: 1_048_576 },
  { id: 'gemini-1.5-pro',          name: 'Gemini 1.5 Pro',      description: '2M context window, most capable',      contextWindow: 2_097_152 },
  { id: 'gemini-2.5-flash-preview',  name: 'Gemini 2.5 Flash Preview', description: 'Fast & cheap',                          contextWindow: 1_048_576 },
  { id: 'gemini-1.5-flash-8b',     name: 'Gemini 1.5 Flash 8B', description: 'Fastest, lightest',                    contextWindow: 1_048_576 },
];

// ─── Internal API types ───────────────────────────────────────────────────

interface GeminiPart   { text: string }
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

interface GeminiModelsResponse {
  models: Array<{
    name: string;           // e.g. "models/gemini-2.0-flash"
    displayName?: string;
    description?: string;
    supportedGenerationMethods?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
  }>;
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
  };
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: GeminiPart[]; role: string };
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
}

// ─── Provider ─────────────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
  readonly id          = 'gemini';
  readonly displayName = 'Google Gemini';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  constructor(opts: { apiKey: string; model?: string; timeoutMs?: number }) {
    this.apiKey    = opts.apiKey;
    this.model     = opts.model     ?? 'gemini-2.0-flash';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/${this.model}`,
        {
          headers: { 'x-goog-api-key': this.apiKey },
          signal:  AbortSignal.timeout(5_000),
        },
      );
      return res.ok; // 2xx only — 404 means invalid model or key, not healthy
    } catch { return false; }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Fetch live from Google's models endpoint — always up to date
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`,
        { signal: AbortSignal.timeout(5_000) },
      );

      if (res.ok) {
        const data = await res.json() as GeminiModelsResponse;
        const live = (data.models ?? [])
          // Only include models that support generateContent (chat-capable)
          .filter(m =>
            m.supportedGenerationMethods?.includes('generateContent') &&
            // Exclude vision-only, embedding, and legacy models
            !m.name.includes('embedding') &&
            !m.name.includes('aqa'),
          )
          .map(m => {
            // Strip "models/" prefix from name → clean model id
            const id = m.name.replace(/^models\//, '');
            // Match against preset for richer description
            const preset = GEMINI_MODELS.find(p => p.id === id);
            return preset ?? {
              id,
              name:        m.displayName ?? id,
              description: m.description,
              contextWindow: m.inputTokenLimit,
            };
          });

        if (live.length > 0) return live;
      }
    } catch { /* fall through */ }

    // Fallback: hardcoded list
    return GEMINI_MODELS;
  }

  async modelExists(model: string): Promise<boolean> {
    const models = await this.listModels();
    return models.some(m => m.id === model);
  }

  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<ChatResponse> {
    // Separate system messages
    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs   = messages.filter(m => m.role !== 'system');

    // Build Gemini contents (user/model alternation, role 'assistant' → 'model')
    const contents: GeminiContent[] = [];
    for (const msg of chatMsgs) {
      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        // Merge consecutive same-role messages
        last.parts.push({ text: msg.content });
      } else {
        contents.push({ role, parts: [{ text: msg.content }] });
      }
    }

    // Must start with user turn
    if (contents.length === 0 || contents[0]?.role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
    }

    const systemInstruction = systemMsgs.length > 0
      ? { parts: [{ text: systemMsgs.map(m => m.content).join('\n\n') }] }
      : undefined;

    const body: GeminiRequest = {
      contents,
      generationConfig: {
        temperature:     options.temperature ?? 0.2,
        topP:            options.top_p       ?? 0.9,
        maxOutputTokens: options.maxTokens   ?? 4096,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new LLMError(`Gemini request timed out after ${this.timeoutMs / 1000}s`, this.id);
      }
      throw new LLMError(`Cannot reach Gemini API: ${String(err)}`, this.id);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 400 && text.includes('API_KEY')) {
        throw new LLMError('Invalid Gemini API key. Get one at aistudio.google.com.', this.id, 400);
      }
      if (res.status === 429) throw new LLMError('Gemini rate limit reached. Try again shortly.', this.id, 429);
      throw new LLMError(`Gemini HTTP ${res.status}: ${text}`, this.id, res.status);
    }

    const data     = await res.json() as GeminiResponse;
    const candidate = data.candidates[0];
    if (!candidate) throw new LLMError('Gemini returned no candidates', this.id);

    const text = candidate.content.parts.map(p => p.text).join('');
    return {
      content:    text,
      tokensUsed: data.usageMetadata?.totalTokenCount ?? 0,
      model:      data.modelVersion ?? this.model,
      provider:   this.id,
    };
  }
}
