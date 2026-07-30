/**
 * Anthropic Messages protocol.
 *
 * Three differences drive this adapter: the system prompt is a root field rather than a
 * message, `max_tokens` is mandatory, and the SSE stream is made of named event objects
 * with no `[DONE]` sentinel. Current Claude models also reject `temperature` outright,
 * which `degrade()` recovers from.
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

const ANTHROPIC_VERSION = '2023-06-01';

function headers(apiKey: string): Record<string, string> {
  return {
    ...JSON_HEADERS,
    'anthropic-version': ANTHROPIC_VERSION,
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  };
}

function endpoint(baseUrl: string, path: '/models' | '/messages'): string {
  return joinPath(baseUrl, '/v1', path);
}

/**
 * Anthropic requires a user-led, strictly alternating conversation. The application's
 * structured tasks always send a single user turn, so this only ever matters for a
 * hand-built history, but a rejected request would be far more confusing than a merge.
 */
function alternating(
  messages: AiChatRequest['messages'],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (result.length === 0 && message.role !== 'user') continue;
    const previous = result[result.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
}

function thinking(capabilities: ProviderCapabilities): Record<string, unknown> {
  if (capabilities.reasoning) return { thinking: { type: 'adaptive' } };
  if (capabilities.disableReasoning) return { thinking: { type: 'disabled' } };
  return {};
}

export const anthropicAdapter: AiProviderAdapter = {
  kind: 'anthropic',
  apiKeyRequired: true,
  framing: 'sse',

  modelsRequest(profile: AiConnectionProfile, apiKey: string): AiRequestPlan {
    // The catalogue is far below the 1000 maximum, so a single page always suffices.
    return {
      method: 'GET',
      url: `${endpoint(profile.baseUrl, '/models')}?limit=1000`,
      headers: headers(apiKey),
    };
  },

  parseModels(json: unknown): string[] {
    const data = asRecord(json)?.['data'];
    if (!Array.isArray(data)) return [];
    return sortedUnique(data.map((item) => readString(asRecord(item), 'id')));
  },

  probeRequest(
    profile: AiConnectionProfile,
    apiKey: string,
    capabilities: ProviderCapabilities,
  ): AiRequestPlan {
    // Reasoning is deliberately left out: a 16-token budget would be spent thinking and
    // the probe would report an empty answer instead of a working connection.
    return {
      method: 'POST',
      url: endpoint(profile.baseUrl, '/messages'),
      headers: headers(apiKey),
      body: JSON.stringify({
        model: profile.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Réponds uniquement : OK' }],
        stream: false,
        ...(capabilities.temperature ? { temperature: 0 } : {}),
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
    const body: Record<string, unknown> = {
      model: profile.model,
      max_tokens: profile.maxTokens,
      system: request.systemPrompt,
      messages: alternating(request.messages),
      stream: true,
      ...thinking(capabilities),
    };
    if (capabilities.temperature) {
      body['temperature'] = request.temperature ?? modeTemperature(request.mode);
    }
    return {
      method: 'POST',
      url: endpoint(profile.baseUrl, '/messages'),
      headers: headers(apiKey),
      body: JSON.stringify(body),
    };
  },

  parseFrame(data: string): AiStreamFrame {
    try {
      const json = asRecord(JSON.parse(data));
      if (!json) return EMPTY_FRAME;
      const type = readString(json, 'type');
      if (type === 'error') {
        const error = asRecord(json['error']);
        return {
          content: '',
          reasoning: false,
          error: readString(error, 'message') || 'The endpoint reported an error.',
        };
      }
      if (type === 'content_block_start') {
        const block = asRecord(json['content_block']);
        return { content: '', reasoning: readString(block, 'type') === 'thinking' };
      }
      if (type === 'content_block_delta') {
        const delta = asRecord(json['delta']);
        const deltaType = readString(delta, 'type');
        if (deltaType === 'text_delta') {
          return { content: readString(delta, 'text'), reasoning: false };
        }
        // Thinking text is empty unless summaries are requested, but the block itself
        // still signals that the model is reasoning.
        if (deltaType === 'thinking_delta') return { content: '', reasoning: true };
        return EMPTY_FRAME;
      }
      // A non-streaming body (probe, or a server that ignored `stream`) carries content
      // blocks directly.
      const content = json['content'];
      if (Array.isArray(content)) {
        return {
          content: content
            .map((block) => {
              const record = asRecord(block);
              return readString(record, 'type') === 'text' ? readString(record, 'text') : '';
            })
            .join(''),
          reasoning: content.some((block) => readString(asRecord(block), 'type') === 'thinking'),
        };
      }
      return EMPTY_FRAME;
    } catch {
      return EMPTY_FRAME;
    }
  },

  degrade(
    current: ProviderCapabilities,
    _status: number,
    body: string,
  ): ProviderCapabilities | null {
    const droppedThinking = { ...current, reasoning: false, disableReasoning: false };
    if (current.temperature && mentions(body, 'temperature')) {
      return { ...current, temperature: false };
    }
    if ((current.reasoning || current.disableReasoning) && mentions(body, 'thinking')) {
      return droppedThinking;
    }
    // Blind ladder: `temperature` is the field current Claude models reject.
    if (current.temperature) return { ...current, temperature: false };
    if (current.reasoning || current.disableReasoning) return droppedThinking;
    return null;
  },
};
