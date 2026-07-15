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
        model,
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
 * @param projectPath  Optional — used to check project-level config
 * @throws LLMError    If no provider config found and wizard hasn't run yet
 */
export async function getProvider(projectPath?: string): Promise<LLMProvider> {
  if (_provider) return _provider;

  const config = await loadProviderConfig(projectPath);

  if (!config.provider || !config.model) {
    throw new LLMError(
      'No LLM provider configured. Run `laila-cli` to complete setup.',
      'none',
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
