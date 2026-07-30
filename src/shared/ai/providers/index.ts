/** Provider registry and the presets the settings dialog offers. */

import type { AiProviderAdapter, AiProviderKind, ProviderPreset } from './types.js';
import { anthropicAdapter } from './anthropic.js';
import { googleAdapter } from './google.js';
import { ollamaAdapter } from './ollama.js';
import { createOpenAiAdapter } from './openai.js';

export * from './types.js';

const ADAPTERS: Readonly<Record<AiProviderKind, AiProviderAdapter>> = {
  openai: createOpenAiAdapter('openai'),
  anthropic: anthropicAdapter,
  google: googleAdapter,
  ollama: ollamaAdapter,
  mistral: createOpenAiAdapter('mistral'),
};

export function providerAdapter(kind: AiProviderKind): AiProviderAdapter {
  return ADAPTERS[kind];
}

export const PROVIDER_PRESETS: Readonly<Record<AiProviderKind, ProviderPreset>> = {
  openai: {
    kind: 'openai',
    defaultBaseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-5',
    apiKeyRequired: true,
  },
  anthropic: {
    kind: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5',
    apiKeyRequired: true,
  },
  google: {
    kind: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-pro',
    apiKeyRequired: true,
  },
  ollama: {
    kind: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1',
    apiKeyRequired: false,
  },
  mistral: {
    kind: 'mistral',
    defaultBaseUrl: 'https://api.mistral.ai',
    defaultModel: 'mistral-large-latest',
    apiKeyRequired: true,
  },
};

/** Every base URL a preset ships, used to tell a default apart from a user's own value. */
export const PRESET_BASE_URLS: readonly string[] = Object.values(PROVIDER_PRESETS).map(
  (preset) => preset.defaultBaseUrl,
);
