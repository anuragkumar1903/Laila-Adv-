/**
 * setup-wizard.ts — Interactive LLM provider setup wizard
 *
 * Runs when no valid provider config is found at startup.
 * Flow:
 *   1. Scan local ports for Ollama / LM Studio
 *   2. Show provider menu (local detected first, cloud second)
 *   3. For local: show model picker
 *   4. For cloud: prompt for API key, validate it, show model picker
 *   5. For custom: prompt for URL, test it, prompt for model + optional key
 *   6. Save config and return a ready LLMProvider
 */

import readline from 'readline';
import chalk    from 'chalk';
import type { LLMProvider, ProviderConfig, ModelInfo } from './providers/base.js';
import { detectLocalProviders, probeCustomEndpoint } from './provider-detector.js';
import { buildProvider }    from './provider-factory.js';
import { saveWizardConfig, saveProjectConfig } from '../config/config-writer.js';
import {
  OPENAI_COMPAT_PRESETS,
  OpenAICompatProvider,
} from './providers/openai-compat.js';
import { ANTHROPIC_MODELS } from './providers/anthropic.js';
import { GEMINI_MODELS }    from './providers/gemini.js';

// ─── UI helpers ───────────────────────────────────────────────────────────

// Module-level external rl — set by switchProvider when called from the REPL
let _externalRl: import('readline').Interface | undefined;

function ask(prompt: string): Promise<string> {
  if (_externalRl) {
    return new Promise(resolve => {
      _externalRl!.question(chalk.magenta(`  ${prompt}`), answer => resolve(answer.trim()));
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(chalk.magenta(`  ${prompt}`), answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function askSecret(prompt: string): Promise<string> {
  // Node readline doesn't support masking natively, but we signal it's sensitive
  const answer = await ask(`${prompt} (input hidden in logs): `);
  return answer;
}

function menu(
  title: string,
  items: Array<{ label: string; hint?: string; badge?: string }>,
): void {
  console.log('');
  console.log(chalk.bold(`  ${title}`));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  items.forEach((item, i) => {
    const num   = chalk.cyan(`  ${String(i + 1).padStart(2)}.`);
    const label = chalk.white(item.label.padEnd(28));
    const hint  = item.hint  ? chalk.dim(item.hint)            : '';
    const badge = item.badge ? chalk.green(` ${item.badge}`)   : '';
    console.log(`${num} ${label}${badge}${hint}`);
  });
  console.log('');
}

function section(title: string): void {
  console.log('');
  console.log(chalk.bold.cyan(`  ── ${title} ${'─'.repeat(Math.max(0, 42 - title.length))}`));
}

// ─── Model picker ─────────────────────────────────────────────────────────

async function pickModel(models: ModelInfo[], defaultIdx = 0): Promise<ModelInfo> {
  if (models.length === 0) {
    const id = await ask('Enter model name: ');
    return { id, name: id };
  }

  if (models.length === 1) {
    console.log(chalk.dim(`  Using only available model: ${models[0]!.name}`));
    return models[0]!;
  }

  menu('Select a model:', models.map((m, i) => ({
    label: m.name,
    hint:  m.description ? `  ${m.description}` : '',
    badge: i === defaultIdx ? '← recommended' : undefined,
  })));

  const answer = await ask(`Select model [${defaultIdx + 1}]: `);
  if (answer === '') return models[defaultIdx]!;

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= models.length) {
    console.log(chalk.yellow(`  Invalid selection: "${answer}". Enter a number between 1 and ${models.length}. Using default.`));
    return models[defaultIdx]!;
  }
  return models[idx]!;
}

// ─── Provider setup flows ─────────────────────────────────────────────────

async function setupOllama(models: ModelInfo[]): Promise<ProviderConfig> {
  section('Ollama Setup');

  if (models.length === 0) {
    console.log(chalk.yellow('  No models found. Pull one with: ollama pull qwen2.5-coder:7b'));
    const id = await ask('Enter model name: ');
    return { provider: 'ollama', model: id };
  }

  const model = await pickModel(models, 0);
  return { provider: 'ollama', model: model.id };
}

async function setupLMStudio(models: ModelInfo[], baseUrl: string): Promise<ProviderConfig> {
  section('LM Studio Setup');

  if (models.length === 0) {
    console.log(chalk.yellow('  No models detected. Make sure a model is loaded in LM Studio.'));
    const id = await ask('Enter model name: ');
    return { provider: 'lmstudio', model: id, baseUrl };
  }

  const model = await pickModel(models, 0);
  return { provider: 'lmstudio', model: model.id, baseUrl };
}

async function setupCloudProvider(
  id: ProviderConfig['provider'],
  displayName: string,
  models: ModelInfo[],
  apiKeyHint: string,
  defaultModelIdx = 0,
): Promise<ProviderConfig> {
  section(`${displayName} Setup`);

  const apiKey = await askSecret(`Enter your ${displayName} API key (${apiKeyHint})`);
  if (!apiKey) throw new Error('API key cannot be empty.');

  // Validate key by doing a quick health check
  process.stdout.write(chalk.dim('  Validating key…'));
  let valid = false;
  try {
    const testProvider = buildProvider({ provider: id, model: models[defaultModelIdx]?.id ?? '', apiKey });
    valid = await testProvider.healthCheck();
  } catch { /* treat as invalid */ }

  if (valid) {
    console.log(chalk.green(' ✔'));
  } else {
    console.log(chalk.yellow(' ⚠  Could not validate key (offline or wrong key). Continuing anyway.'));
  }

  const model = await pickModel(models, defaultModelIdx);
  return { provider: id, model: model.id, apiKey };
}

async function setupCustomEndpoint(): Promise<ProviderConfig> {
  section('Custom Endpoint Setup');
  console.log(chalk.dim('  Use this for your own fine-tuned model, vLLM, llama.cpp server, etc.'));
  console.log('');

  const rawUrl = await ask('Base URL (e.g. http://192.168.1.100:8080/v1): ');
  const baseUrl = rawUrl.replace(/\/$/, '');

  if (!baseUrl) throw new Error('Base URL cannot be empty.');

  process.stdout.write(chalk.dim('  Testing connection…'));
  const reachable = await probeCustomEndpoint(baseUrl);
  if (reachable) {
    console.log(chalk.green(' ✔'));
  } else {
    console.log(chalk.yellow(' ⚠  Could not reach endpoint. Make sure your server is running.'));
    const cont = await ask('Continue anyway? [y/N]: ');
    if (!['y', 'yes'].includes(cont.toLowerCase())) throw new Error('Setup cancelled.');
  }

  // Try to list models from the endpoint
  let models: ModelInfo[] = [];
  try {
    const tempProvider = new OpenAICompatProvider({ id: 'openai-compat', baseUrl, model: '' });
    models = await tempProvider.listModels();
  } catch { /* ignore */ }

  const model     = await pickModel(models, 0);
  const apiKeyRaw = await ask('API key or token (leave blank if not required): ');

  return {
    provider: 'openai-compat',
    model:    model.id,
    baseUrl,
    apiKey:   apiKeyRaw || undefined,
  };
}

// ─── Main wizard ──────────────────────────────────────────────────────────

/**
 * Run the full interactive setup wizard.
 * Returns a ready-to-use LLMProvider and saves the config to disk.
 */
export async function runSetupWizard(projectPath?: string): Promise<LLMProvider> {
  console.log('');
  console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║      Laila — First Time Setup                ║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════════╝'));
  console.log('');
  console.log(chalk.dim('  Scanning for local LLM providers…'));

  const detected = await detectLocalProviders();

  // Build provider menu
  const menuItems: Array<{
    label:   string;
    hint?:   string;
    badge?:  string;
    action:  () => Promise<ProviderConfig>;
  }> = [];

  // ── Local section ──
  if (detected.ollama.running) {
    menuItems.push({
      label:  'Ollama (local)',
      badge:  `✔ Running — ${detected.ollama.models.length} model(s)`,
      action: () => setupOllama(detected.ollama.models),
    });
  } else {
    menuItems.push({
      label:  'Ollama (local)',
      hint:   '  Not running — start with: ollama serve',
      action: () => setupOllama([]),
    });
  }

  if (detected.lmstudio.running) {
    menuItems.push({
      label:  'LM Studio (local)',
      badge:  `✔ Running — ${detected.lmstudio.models.length} model(s)`,
      action: () => setupLMStudio(detected.lmstudio.models, detected.lmstudio.baseUrl),
    });
  } else {
    menuItems.push({
      label:  'LM Studio (local)',
      hint:   '  Not detected',
      action: () => setupLMStudio([], 'http://localhost:1234/v1'),
    });
  }

  // ── Cloud section ──
  menuItems.push(
    {
      label:  'OpenAI',
      hint:   '  GPT-4o, o1, o3-mini',
      action: () => setupCloudProvider(
        'openai', 'OpenAI',
        [...OPENAI_COMPAT_PRESETS.openai.models],
        'platform.openai.com', 1,  // default: gpt-4o-mini (index 1)
      ),
    },
    {
      label:  'Anthropic',
      hint:   '  Claude Opus, Sonnet, Haiku',
      action: () => setupCloudProvider(
        'anthropic', 'Anthropic',
        ANTHROPIC_MODELS,
        'console.anthropic.com', 0,  // default: claude-sonnet-4-5
      ),
    },
    {
      label:  'DeepSeek',
      hint:   '  deepseek-chat, deepseek-coder, R1',
      action: () => setupCloudProvider(
        'deepseek', 'DeepSeek',
        [...OPENAI_COMPAT_PRESETS.deepseek.models],
        'platform.deepseek.com', 0,
      ),
    },
    {
      label:  'Groq',
      hint:   '  Llama 3.1, Mixtral — very fast',
      action: () => setupCloudProvider(
        'groq', 'Groq',
        [...OPENAI_COMPAT_PRESETS.groq.models],
        'console.groq.com', 0,
      ),
    },
    {
      label:  'Google Gemini',
      hint:   '  Gemini 2.0 Flash, 1.5 Pro',
      action: () => setupCloudProvider(
        'gemini', 'Google Gemini',
        GEMINI_MODELS,
        'aistudio.google.com', 0,
      ),
    },
    {
      label:  'Mistral',
      hint:   '  mistral-large, codestral',
      action: () => setupCloudProvider(
        'mistral', 'Mistral',
        [...OPENAI_COMPAT_PRESETS.mistral.models],
        'console.mistral.ai', 0,
      ),
    },
    {
      label:  'Custom endpoint',
      hint:   '  Your own model (vLLM, llama.cpp, fine-tune…)',
      action: setupCustomEndpoint,
    },
  );

  // Print the menu with section dividers
  console.log('');
  console.log(chalk.bold('  Select a provider:'));
  console.log('');
  console.log(chalk.dim('  ── Local (free & offline) ─────────────────────────'));
  menuItems.slice(0, 2).forEach((item, i) => {
    const num   = chalk.cyan(`  ${String(i + 1).padStart(2)}.`);
    const label = chalk.white(item.label.padEnd(22));
    const badge = item.badge ? chalk.green(` ${item.badge}`)  : '';
    const hint  = item.hint  ? chalk.dim(item.hint)           : '';
    console.log(`${num} ${label}${badge}${hint}`);
  });
  console.log('');
  console.log(chalk.dim('  ── Cloud (API key required) ───────────────────────'));
  menuItems.slice(2, menuItems.length - 1).forEach((item, i) => {
    const num   = chalk.cyan(`  ${String(i + 3).padStart(2)}.`);
    const label = chalk.white(item.label.padEnd(22));
    const hint  = item.hint ? chalk.dim(item.hint) : '';
    console.log(`${num} ${label}${hint}`);
  });
  console.log('');
  console.log(chalk.dim('  ── Custom ─────────────────────────────────────────'));
  const lastIdx = menuItems.length;
  console.log(`${chalk.cyan(`  ${String(lastIdx).padStart(2)}.`)} ${chalk.white('Custom endpoint'.padEnd(22))}${chalk.dim('  Your own model (vLLM, fine-tune…)')}`);
  console.log('');

  // Get user choice
  const answer = await ask(`Select provider [1–${menuItems.length}]: `);
  const idx    = parseInt(answer, 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= menuItems.length) {
    throw new Error('Invalid selection.');
  }

  const selectedAction = menuItems[idx]!.action;
  const config = await selectedAction();

  // Save config
  await saveWizardConfig(config, projectPath);
  console.log('');
  console.log(chalk.green('  ✔  Configuration saved.'));
  if (config.apiKey) {
    console.log(chalk.dim('     API key stored in ~/.laila/config.yaml (never committed to git)'));
  }

  // Build and return the provider
  const provider = buildProvider(config);
  return provider;
}

/**
 * Ask user if they want to change provider (shown when config already exists)
 */
export async function askChangeProvider(): Promise<boolean> {
  const answer = await ask('Change provider/model? [y/N]: ');
  return ['y', 'yes'].includes(answer.toLowerCase());
}

// ─── Mid-session provider switch ─────────────────────────────────────────

/**
 * switchProvider() — minimal mid-session wizard.
 *
 * Shows a compact provider menu, prompts for API key if needed,
 * validates it with up to 3 retries, then lets the user choose
 * whether to save the config or use it for this session only.
 *
 * Returns a ready LLMProvider, or null if the user cancels.
 */
export async function switchProvider(
  currentProviderName: string,
  projectPath?: string,
  rl?: import('readline').Interface,
): Promise<LLMProvider | null> {
  _externalRl = rl;
  try {
    return await _switchProviderImpl(currentProviderName, projectPath);
  } finally {
    _externalRl = undefined;
  }
}

async function _switchProviderImpl(
  currentProviderName: string,
  projectPath?: string,
): Promise<LLMProvider | null> {
  console.log('');
  console.log(chalk.bold.cyan('  ── Switch Provider ────────────────────────────────'));
  console.log(chalk.dim(`  Current: ${currentProviderName}`));
  console.log('');

  // Scan local providers in parallel
  process.stdout.write(chalk.dim('  Scanning local providers…'));
  const detected = await detectLocalProviders();
  console.log(chalk.dim(' done'));

  // Build compact menu
  const options: Array<{
    label:    string;
    hint?:    string;
    badge?:   string;
    action:   () => Promise<ProviderConfig | null>;
  }> = [
    {
      label:  'Ollama (local)',
      badge:  detected.ollama.running  ? `✔ ${detected.ollama.models.length} model(s)`  : undefined,
      hint:   !detected.ollama.running ? '  not running'                                : undefined,
      action: async () => {
        if (detected.ollama.models.length === 0) {
          const id = await ask('Model name: ');
          return id ? { provider: 'ollama', model: id } : null;
        }
        const model = await pickModel(detected.ollama.models, 0);
        return { provider: 'ollama', model: model.id };
      },
    },
    {
      label:  'LM Studio (local)',
      badge:  detected.lmstudio.running  ? `✔ ${detected.lmstudio.models.length} model(s)` : undefined,
      hint:   !detected.lmstudio.running ? '  not detected'                                 : undefined,
      action: async () => {
        const models = detected.lmstudio.running ? detected.lmstudio.models : [];
        const model  = await pickModel(models, 0);
        return { provider: 'lmstudio', model: model.id, baseUrl: detected.lmstudio.baseUrl };
      },
    },
    {
      label:  'OpenAI',
      hint:   '  GPT-4o, o1, o3-mini',
      action: () => _switchCloud('openai', 'OpenAI', [...OPENAI_COMPAT_PRESETS.openai.models], 'platform.openai.com', 1),
    },
    {
      label:  'Anthropic',
      hint:   '  Claude Opus, Sonnet, Haiku',
      action: () => _switchCloud('anthropic', 'Anthropic', ANTHROPIC_MODELS, 'console.anthropic.com', 0),
    },
    {
      label:  'DeepSeek',
      hint:   '  deepseek-chat, R1',
      action: () => _switchCloud('deepseek', 'DeepSeek', [...OPENAI_COMPAT_PRESETS.deepseek.models], 'platform.deepseek.com', 0),
    },
    {
      label:  'Groq',
      hint:   '  Llama 3.1, Mixtral — very fast',
      action: () => _switchCloud('groq', 'Groq', [...OPENAI_COMPAT_PRESETS.groq.models], 'console.groq.com', 0),
    },
    {
      label:  'Google Gemini',
      hint:   '  Gemini 2.0 Flash, 1.5 Pro',
      action: () => _switchCloud('gemini', 'Google Gemini', GEMINI_MODELS, 'aistudio.google.com', 0),
    },
    {
      label:  'Mistral',
      hint:   '  mistral-large, codestral',
      action: () => _switchCloud('mistral', 'Mistral', [...OPENAI_COMPAT_PRESETS.mistral.models], 'console.mistral.ai', 0),
    },
    {
      label:  'Custom endpoint',
      hint:   '  Your own model',
      action: async () => {
        const url    = await ask('Base URL: ');
        if (!url) return null;
        const model  = await ask('Model name: ');
        if (!model) return null;
        const apiKey = await ask('API key (blank if none): ');
        return { provider: 'openai-compat' as const, model, baseUrl: url, apiKey: apiKey || undefined };
      },
    },
    {
      label:  'Cancel',
      action: async () => null,
    },
  ];

  // Print menu
  options.forEach((opt, i) => {
    const num   = chalk.cyan(`  ${String(i + 1).padStart(2)}.`);
    const label = chalk.white(opt.label.padEnd(22));
    const badge = opt.badge ? chalk.green(` ${opt.badge}`) : '';
    const hint  = opt.hint  ? chalk.dim(opt.hint)          : '';
    console.log(`${num} ${label}${badge}${hint}`);
  });
  console.log('');

  const answer = await ask(`Select [1-${options.length}] or Enter to cancel: `);
  if (!answer) {
    console.log(chalk.dim('  Cancelled — keeping current provider.'));
    return null;
  }

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= options.length) {
    console.log(chalk.dim('  Invalid selection — keeping current provider.'));
    return null;
  }

  const config = await options[idx]!.action();
  if (!config) {
    console.log(chalk.dim('  Cancelled — keeping current provider.'));
    return null;
  }

  // Ask how to save
  console.log('');
  console.log(chalk.bold('  Save this configuration?'));
  console.log(`  ${chalk.cyan('  1.')} ${chalk.white('Save globally')}       ${chalk.dim('~/.laila/config.yaml')}`);
  console.log(`  ${chalk.cyan('  2.')} ${chalk.white('Save for project')}    ${chalk.dim('.laila/config.yaml (no API key)')}`);
  console.log(`  ${chalk.cyan('  3.')} ${chalk.white('This session only')}   ${chalk.dim('forgotten on exit')}`);
  console.log('');

  const saveAnswer = await ask('Choose [1-3] (default: 3): ');
  const saveChoice = saveAnswer === '' ? 3 : parseInt(saveAnswer, 10);

  if (saveChoice === 1) {
    await saveWizardConfig(config);
    console.log(chalk.green('  ✔  Saved to ~/.laila/config.yaml'));
  } else if (saveChoice === 2 && projectPath) {
    await saveProjectConfig(projectPath, config);
    console.log(chalk.green('  ✔  Saved to .laila/config.yaml'));
  } else {
    console.log(chalk.dim('  Session only — will revert on restart.'));
  }

  const provider = buildProvider(config);
  console.log(chalk.green(`  ✔  Switched to ${config.provider} / ${config.model}`));
  return provider;
}

// ─── Internal helper for cloud switch ────────────────────────────────────

async function _switchCloud(
  id: ProviderConfig['provider'],
  displayName: string,
  models: ModelInfo[],
  keyHint: string,
  defaultModelIdx: number,
): Promise<ProviderConfig | null> {
  console.log('');

  // Check if we already have a saved key
  const { loadProviderConfig } = await import('../config/config-loader.js');
  const saved = await loadProviderConfig();
  const hasSavedKey = saved.provider === id && !!saved.apiKey;

  let apiKey = hasSavedKey ? saved.apiKey! : '';

  if (!hasSavedKey) {
    console.log(chalk.dim(`  No API key found for ${displayName}.`));
    console.log(chalk.dim(`  Get one at: ${keyHint}`));
    console.log('');
    apiKey = await _promptApiKeyWithRetry(displayName, id, models[defaultModelIdx]?.id ?? '', 3);
    if (!apiKey) return null; // user cancelled
  } else {
    console.log(chalk.dim(`  Using saved API key for ${displayName}.`));
  }

  // Fetch live models (may include new ones since last update)
  let liveModels = models;
  try {
    const tempProvider = buildProvider({ provider: id, model: models[defaultModelIdx]?.id ?? '', apiKey });
    const fetched = await tempProvider.listModels();
    if (fetched.length > 0) liveModels = fetched;
  } catch { /* use preset */ }

  const model = await pickModel(liveModels, defaultModelIdx);
  return { provider: id, model: model.id, apiKey };
}

/** Prompt for API key with retry logic. Returns empty string if cancelled. */
async function _promptApiKeyWithRetry(
  displayName: string,
  id: ProviderConfig['provider'],
  testModel: string,
  maxRetries: number,
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const key = await ask(`Enter ${displayName} API key: `);

    if (!key) {
      console.log(chalk.dim('  No key entered — switch cancelled.'));
      return '';
    }

    // Validate
    process.stdout.write(chalk.dim('  Validating…'));
    let valid = false;
    try {
      const testProvider = buildProvider({ provider: id, model: testModel, apiKey: key });
      valid = await testProvider.healthCheck();
    } catch { /* treat as invalid */ }

    if (valid) {
      console.log(chalk.green(' ✔'));
      return key;
    }

    console.log(chalk.yellow(' ✖  Invalid or unreachable.'));

    if (attempt < maxRetries) {
      const retry = await ask(`Retry? [Y/n] (attempt ${attempt}/${maxRetries}): `);
      if (['n', 'no'].includes(retry.toLowerCase())) {
        // Allow continuing with unvalidated key (might be network issue)
        const force = await ask('Continue anyway with this key? [y/N]: ');
        if (['y', 'yes'].includes(force.toLowerCase())) return key;
        return '';
      }
    } else {
      console.log(chalk.yellow(`  Max retries reached.`));
      const force = await ask('Continue anyway? [y/N]: ');
      if (['y', 'yes'].includes(force.toLowerCase())) return key;
      return '';
    }
  }
  return '';
}
