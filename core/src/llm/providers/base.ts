/**
 * base.ts — LLMProvider interface and shared types
 */

// ─── Shared message format ───────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string; // Required for 'tool' role
}

// ─── Tool Definitions ─────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: any; // Parsed JSON object
}

// ─── Chat options ─────────────────────────────────────────────────────────

export interface ChatOptions {
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
}

// ─── Response ────────────────────────────────────────────────────────────

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  tokensUsed: number;
  model: string;
  provider: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
}

export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  healthCheck(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  modelExists(model: string): Promise<boolean>;
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

export type ProviderName =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'groq'
  | 'gemini'
  | 'mistral'
  | 'openai-compat';

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

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
