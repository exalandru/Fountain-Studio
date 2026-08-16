/**
 * Google Gemini native protocol (`generativelanguage.googleapis.com`).
 *
 * The model name is part of the URL, the conversation uses `contents`/`parts` with
 * `model` in place of `assistant`, and the key travels in an `x-goog-api-key` header.
 *
 * `includeThoughts` is deliberately never requested: without it no thought parts come
 * back at all, so every `parts[].text` is answer content. Thought parts are still
 * filtered out defensively below in case a model returns them anyway — the consequence
 * is that the « le modèle raisonne… » indicator does not fire for Google.
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

/** Dynamic thinking: the model decides its own budget. */
const DYNAMIC_THINKING_BUDGET = -1;

/**
 * Gemini grades thinking by token budget rather than by name, so each level is a number.
 * The values sit inside the range every thinking-capable Gemini accepts; a model with a
 * narrower range refuses them, and the graded rung of `degrade` falls back to dynamic.
 */
const GRADED_THINKING_BUDGETS: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 2_048,
  medium: 8_192,
  high: 24_576,
};

function headers(apiKey: string): Record<string, string> {
  return { ...JSON_HEADERS, ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) };
}

/** Accepts both `gemini-2.5-pro` and the fully qualified `models/gemini-2.5-pro`. */
function modelId(model: string): string {
  return model.replace(/^models\//, '');
}

function endpoint(baseUrl: string, path: string): string {
  return joinPath(baseUrl, '/v1beta', path);
}

function generationConfig(
  profile: AiConnectionProfile,
  capabilities: ProviderCapabilities,
  temperature: number,
): Record<string, unknown> {
  const config: Record<string, unknown> = { maxOutputTokens: profile.maxTokens };
  if (capabilities.temperature) config['temperature'] = temperature;
  if (capabilities.reasoning) {
    const graded =
      capabilities.gradedReasoning && profile.reasoningEffort !== 'auto'
        ? GRADED_THINKING_BUDGETS[profile.reasoningEffort]
        : DYNAMIC_THINKING_BUDGET;
    config['thinkingConfig'] = { thinkingBudget: graded };
  } else if (capabilities.disableReasoning) {
    config['thinkingConfig'] = { thinkingBudget: 0 };
  }
  return config;
}

export const googleAdapter: AiProviderAdapter = {
  kind: 'google',
  apiKeyRequired: true,
  framing: 'sse',

  modelsRequest(profile: AiConnectionProfile, apiKey: string): AiRequestPlan {
    return {
      method: 'GET',
      url: `${endpoint(profile.baseUrl, '/models')}?pageSize=1000`,
      headers: headers(apiKey),
    };
  },

  parseModels(json: unknown): string[] {
    const models = asRecord(json)?.['models'];
    if (!Array.isArray(models)) return [];
    return sortedUnique(
      models.flatMap((item) => {
        const record = asRecord(item);
        const methods = record?.['supportedGenerationMethods'];
        // Embedding-only models cannot serve a chat request.
        if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
        return [modelId(readString(record, 'name'))];
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
      url: endpoint(profile.baseUrl, `/models/${modelId(profile.model)}:generateContent`),
      headers: headers(apiKey),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Réponds uniquement : OK' }] }],
        generationConfig: {
          maxOutputTokens: 16,
          ...(capabilities.temperature ? { temperature: 0 } : {}),
          ...(capabilities.disableReasoning ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    };
  },

  parseProbe(json: unknown, fallbackModel: string): string {
    return readString(asRecord(json), 'modelVersion') || fallbackModel;
  },

  chatRequest(
    profile: AiConnectionProfile,
    apiKey: string,
    request: AiChatRequest,
    capabilities: ProviderCapabilities,
  ): AiRequestPlan {
    const body = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      generationConfig: generationConfig(
        profile,
        capabilities,
        request.temperature ?? modeTemperature(request.mode),
      ),
    };
    return {
      method: 'POST',
      url: `${endpoint(
        profile.baseUrl,
        `/models/${modelId(profile.model)}:streamGenerateContent`,
      )}?alt=sse`,
      headers: headers(apiKey),
      body: JSON.stringify(body),
    };
  },

  parseFrame(data: string): AiStreamFrame {
    try {
      const json = asRecord(JSON.parse(data));
      if (!json) return EMPTY_FRAME;
      const error = asRecord(json['error']);
      if (error) {
        return {
          content: '',
          reasoning: false,
          error: readString(error, 'message') || 'The endpoint reported an error.',
        };
      }
      const candidates = json['candidates'];
      const parts = asRecord(
        asRecord(Array.isArray(candidates) ? candidates[0] : null)?.['content'],
      )?.['parts'];
      if (!Array.isArray(parts)) return EMPTY_FRAME;
      let content = '';
      let reasoning = false;
      for (const part of parts) {
        const record = asRecord(part);
        if (record?.['thought'] === true) {
          reasoning = true;
          continue;
        }
        content += readString(record, 'text');
      }
      return { content, reasoning };
    } catch {
      return EMPTY_FRAME;
    }
  },

  degrade(
    current: ProviderCapabilities,
    _status: number,
    body: string,
  ): ProviderCapabilities | null {
    const droppedThinking = {
      ...current,
      reasoning: false,
      gradedReasoning: false,
      disableReasoning: false,
    };
    // Several Pro models refuse a zero budget and some refuse the block entirely. A graded
    // budget outside a model's range is refused the same way, so try dynamic before giving
    // up on thinking altogether.
    if (current.gradedReasoning && mentions(body, 'thinking')) {
      return { ...current, gradedReasoning: false };
    }
    if ((current.reasoning || current.disableReasoning) && mentions(body, 'thinking')) {
      return droppedThinking;
    }
    if (current.temperature && mentions(body, 'temperature')) {
      return { ...current, temperature: false };
    }
    if (current.gradedReasoning) return { ...current, gradedReasoning: false };
    if (current.reasoning || current.disableReasoning) return droppedThinking;
    if (current.temperature) return { ...current, temperature: false };
    return null;
  },
};
