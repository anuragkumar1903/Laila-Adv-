/**
 * provider-factory.ts — Build the correct LLMProvider from config
 *
 * This is the single place where provider selection happens.
 * All agents call getProvider() — they never import concrete providers.
 *
 * A singleton is cached per process so we don't re-instantiate on every turn.
 */

import type { LLMProvider, ProviderConfig } from './providers/base.js';
import { LLMError }                         from './providers/base.js';
import { OllamaProvider }                   from './providers/ollama.js';
import { AnthropicProvider }                from './providers/anthropic.js';
import { GeminiProvider }                   from './providers/gemini.js';
import {
  OpenAICompatProvider,
  makeOpenAIProvider,
  makeDeepSeekProvider,
  makeGroqProvider,
  makeMistralProvider,
  makeLMStudioProvider,
  makeCustomProvider,
} from './providers/openai-compat.js';
import { loadProviderConfig }               from '../config/config-loader.js';

// ─── Singleton ────────────────────────────────────────────────────────────

let _provider: LLMProvider | null = null;

/** Reset the cached provider (used when config changes during setup wizard) */
export function resetProvider(): void {
  _provider = null;
}

// ─── Context window limits per provider ──────────────────────────────────

/**
 * Approximate character budgets for context injection, keyed by provider.
 *
 * These are conservative but provider-appropriate:
 * - Local models (Ollama, LMStudio): small VRAM → 14k chars ≈ 3.5k tokens
 * - Cloud models: large context windows → up to 400k chars for 128k-token models
 *
 * The budget is used in chars (not tokens) to avoid a dependency on a
 * tokeniser. The conservative 4 chars-per-token estimate means we stay
 * safely below the true limit even for dense code content.
 */
const CONTEXT_LIMITS: Record<string, number> = {
  ollama:       14_000,   // local — VRAM constrained, 8k ctx window set in body.options
  lmstudio:     14_000,   // local — same reasoning
  openai:       400_000,  // gpt-4o: 128k tokens × ~4 chars ≈ 512k; use 400k conservatively
  anthropic:    600_000,  // claude-3.5-sonnet: 200k tokens × ~4 chars ≈ 800k; use 600k
  deepseek:     240_000,  // deepseek-chat: 64k tokens × ~4 chars
  groq:         120_000,  // llama-3.3-70b on Groq: 32k tokens
  gemini:       400_000,  // gemini-1.5-pro: 1M tokens; use a sane cap
  mistral:      120_000,  // mistral-large: 32k tokens
  'openai-compat': 14_000, // unknown custom endpoint — be conservative
};

const DEFAULT_CONTEXT_LIMIT = 14_000;

/**
 * Return the character budget for the currently active provider.
 * Falls back to the conservative default when the provider is not configured.
 */
export async function getContextLimit(): Promise<number> {
  try {
    const provider = await getProvider();
    return CONTEXT_LIMITS[provider.id] ?? DEFAULT_CONTEXT_LIMIT;
  } catch {
    return DEFAULT_CONTEXT_LIMIT;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Build an LLMProvider from a ProviderConfig.
 * Throws LLMError if the config is incomplete or the provider is unknown.
 */
export function buildProvider(config: ProviderConfig): LLMProvider {
  const { provider, model, apiKey = '', baseUrl } = config;

  switch (provider) {
    case 'ollama':
      return new OllamaProvider({
        host:  baseUrl ?? 'http://localhost:11434',
        model, // may be empty string — OllamaProvider.chat() will auto-fetch
      });

    case 'lmstudio':
      return makeLMStudioProvider(model, baseUrl ?? 'http://localhost:1234/v1');

    case 'openai':
      if (!apiKey) throw new LLMError('OpenAI requires an API key.', 'openai');
      return makeOpenAIProvider(apiKey, model);

    case 'anthropic':
      if (!apiKey) throw new LLMError('Anthropic requires an API key.', 'anthropic');
      return new AnthropicProvider({ apiKey, model });

    case 'deepseek':
      if (!apiKey) throw new LLMError('DeepSeek requires an API key.', 'deepseek');
      return makeDeepSeekProvider(apiKey, model);

    case 'groq':
      if (!apiKey) throw new LLMError('Groq requires an API key.', 'groq');
      return makeGroqProvider(apiKey, model);

    case 'gemini':
      if (!apiKey) throw new LLMError('Gemini requires an API key.', 'gemini');
      return new GeminiProvider({ apiKey, model });

    case 'mistral':
      if (!apiKey) throw new LLMError('Mistral requires an API key.', 'mistral');
      return makeMistralProvider(apiKey, model);

    case 'openai-compat': {
      if (!baseUrl) throw new LLMError('Custom endpoint requires a base URL.', 'openai-compat');
      return makeCustomProvider(baseUrl, model, apiKey || undefined);
    }

    default:
      throw new LLMError(`Unknown provider: ${String(provider)}`, String(provider));
  }
}

// ─── Main accessor ────────────────────────────────────────────────────────

/**
 * Return the active LLMProvider.
 * Loads config from disk/env on first call, caches for the process lifetime.
 *
 * For Ollama: if no model is set in config, auto-fetches the first available
 * model from the local Ollama instance so no hardcoded default is needed.
 *
 * @param projectPath  Optional — used to check project-level config
 * @throws LLMError    If no provider config found and wizard hasn't run yet
 */
export async function getProvider(projectPath?: string): Promise<LLMProvider> {
  if (_provider) return _provider;

  const config = await loadProviderConfig(projectPath);

  if (!config.provider) {
    throw new LLMError(
      'No LLM provider configured. Run `laila` to complete setup.',
      'none',
    );
  }

  // For Ollama: model is optional — auto-fetch from the running instance
  if (config.provider === 'ollama' && !config.model) {
    const probe = new OllamaProvider({ host: config.baseUrl ?? 'http://localhost:11434' });
    const autoModel = await probe.getDefaultModel();
    if (autoModel) {
      config.model = autoModel;
    } else {
      throw new LLMError(
        'No models found in Ollama. Pull a model first: ollama pull <model>',
        'ollama',
      );
    }
  }

  if (!config.model) {
    throw new LLMError(
      'No model configured. Run `laila` to complete setup.',
      config.provider ?? 'none',
    );
  }

  _provider = buildProvider(config as ProviderConfig);
  return _provider;
}

/**
 * Set the provider directly (used after setup wizard saves config).
 */
export function setProvider(provider: LLMProvider): void {
  _provider = provider;
}

/**
 * Convenience wrapper — same signature as the old ollama-client.chat().
 * Lets existing call sites migrate with minimal changes.
 */
export async function chat(
  messages: import('./providers/base.js').LLMMessage[],
  options?: import('./providers/base.js').ChatOptions,
): Promise<{ content: string; tokensUsed: number }> {
  const provider = await getProvider();
  const response = await provider.chat(messages, options);
  return { content: response.content, tokensUsed: response.tokensUsed };
}
