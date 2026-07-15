/**
 * base.ts — LLMProvider interface and shared types
 *
 * Every provider (Ollama, OpenAI, Anthropic, Gemini, etc.) implements
 * this interface. Agents never import a concrete provider — they always
 * go through the provider returned by provider-factory.ts.
 */

// ─── Shared message format (OpenAI-style, used internally) ───────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Chat options ─────────────────────────────────────────────────────────

export interface ChatOptions {
  temperature?: number;   // 0.0 – 1.0
  top_p?: number;
  maxTokens?: number;
  stream?: boolean;       // reserved — streaming support coming soon
}

// ─── Response ────────────────────────────────────────────────────────────

export interface ChatResponse {
  content: string;
  tokensUsed: number;
  model: string;          // actual model name used (may differ from requested)
  provider: string;       // e.g. 'ollama', 'openai', 'anthropic'
}

// ─── Model info ───────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;             // model identifier sent to the API
  name: string;           // human-readable display name
  description?: string;
  contextWindow?: number;
}

// ─── Provider interface ───────────────────────────────────────────────────

export interface LLMProvider {
  /** Unique provider identifier — matches ProviderName union */
  readonly id: string;

  /** Human-readable display name shown in the setup wizard */
  readonly displayName: string;

  /** Check if the provider endpoint is reachable */
  healthCheck(): Promise<boolean>;

  /** List models available on this provider */
  listModels(): Promise<ModelInfo[]>;

  /** Check if a specific model is available */
  modelExists(model: string): Promise<boolean>;

  /** Send a chat request and return the full response */
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

// ─── Provider names ───────────────────────────────────────────────────────

export type ProviderName =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'groq'
  | 'gemini'
  | 'mistral'
  | 'openai-compat';    // generic — for custom endpoints and your own fine-tuned model

// ─── Provider config (what gets saved to config.yaml) ────────────────────

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;     // custom endpoint URL
  apiKey?: string;      // stored in global config only, never committed
}

// ─── LLM error ────────────────────────────────────────────────────────────

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
