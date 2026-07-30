/**
 * Ollama native protocol.
 *
 * Unlike every other provider the stream is newline-delimited JSON rather than
 * server-sent events: one complete JSON object per line, no `data:` prefix and no
 * sentinel. Going native also gives access to `think` and to `options.num_predict`,
 * which the OpenAI-compatible shim does not expose consistently.
 */

import type { AiChatRequest, AiConnectionProfile } from '../index.js';
import { modeTemperature } from '../index.js';
import type {
  AiProviderAdapter,
  AiRequestPlan,
  AiStreamFrame,
  ProviderCapabilities,
} from './types.js';
import {
  asRecord,
  EMPTY_FRAME,
  JSON_HEADERS,
  joinPath,
  mentions,
  readString,
  sortedUnique,
} from './types.js';

/** A local Ollama needs no key; a bearer is still forwarded for reverse-proxied setups. */
function headers(apiKey: string): Record<string, string> {
  return { ...JSON_HEADERS, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

function endpoint(baseUrl: string, path: '/chat' | '/tags'): string {
  return joinPath(baseUrl, '/api', path);
}

function think(capabilities: ProviderCapabilities): Record<string, unknown> {
  if (capabilities.reasoning) return { think: true };
  if (capabilities.disableReasoning) return { think: false };
  return {};
}

function options(
  maxTokens: number,
  capabilities: ProviderCapabilities,
  temperature: number,
): Record<string, unknown> {
  return {
    num_predict: maxTokens,
    ...(capabilities.temperature ? { temperature } : {}),
  };
}

export const ollamaAdapter: AiProviderAdapter = {
  kind: 'ollama',
  apiKeyRequired: false,
  framing: 'ndjson',

  modelsRequest(profile: AiConnectionProfile, apiKey: string): AiRequestPlan {
    return { method: 'GET', url: endpoint(profile.baseUrl, '/tags'), headers: headers(apiKey) };
  },

  parseModels(json: unknown): string[] {
    const models = asRecord(json)?.['models'];
    if (!Array.isArray(models)) return [];
    return sortedUnique(
      models.map((item) => {
        const record = asRecord(item);
        return readString(record, 'model') || readString(record, 'name');
      }),
    );
  },

  probeRequest(
    profile: AiConnectionProfile,
    apiKey: string,
    capabilities: ProviderCapabilities,
  ): AiRequestPlan {
    return {
      method: 'POST',
      url: endpoint(profile.baseUrl, '/chat'),
      headers: headers(apiKey),
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: 'user', content: 'Réponds uniquement : OK' }],
        stream: false,
        options: options(16, capabilities, 0),
      }),
    };
  },

  parseProbe(json: unknown, fallbackModel: string): string {
    return readString(asRecord(json), 'model') || fallbackModel;
  },

  chatRequest(
    profile: AiConnectionProfile,
    apiKey: string,
    request: AiChatRequest,
    capabilities: ProviderCapabilities,
  ): AiRequestPlan {
    return {
      method: 'POST',
      url: endpoint(profile.baseUrl, '/chat'),
      headers: headers(apiKey),
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: 'system', content: request.systemPrompt }, ...request.messages],
        stream: true,
        options: options(
          profile.maxTokens,
          capabilities,
          request.temperature ?? modeTemperature(request.mode),
        ),
        ...think(capabilities),
      }),
    };
  },

  parseFrame(data: string): AiStreamFrame {
    try {
      const json = asRecord(JSON.parse(data));
      if (!json) return EMPTY_FRAME;
      const error = readString(json, 'error');
      if (error) return { content: '', reasoning: false, error };
      const message = asRecord(json['message']);
      return {
        content: readString(message, 'content'),
        reasoning: readString(message, 'thinking').length > 0,
      };
    } catch {
      return EMPTY_FRAME;
    }
  },

  degrade(
    current: ProviderCapabilities,
    _status: number,
    body: string,
  ): ProviderCapabilities | null {
    const droppedThink = { ...current, reasoning: false, disableReasoning: false };
    // Ollama releases before 0.9 reject `think` outright; non-reasoning models reject it
    // for their own reasons.
    if ((current.reasoning || current.disableReasoning) && mentions(body, 'think')) {
      return droppedThink;
    }
    if (current.reasoning || current.disableReasoning) return droppedThink;
    if (current.temperature) return { ...current, temperature: false };
    return null;
  },
};
