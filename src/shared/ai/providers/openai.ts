/**
 * OpenAI chat-completions protocol, shared by OpenAI itself, Mistral, and every
 * self-hosted server exposing `/v1/chat/completions` (LM Studio, vLLM, llama.cpp…).
 */

import type { AiChatRequest, AiConnectionProfile } from '../index.js';
import { modeTemperature } from '../index.js';
import type {
  AiProviderAdapter,
  AiProviderKind,
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

function headers(apiKey: string): Record<string, string> {
  return { ...JSON_HEADERS, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

function endpoint(baseUrl: string, path: '/models' | '/chat/completions'): string {
  return joinPath(baseUrl, '/v1', path);
}

function streamError(json: Record<string, unknown>): string | undefined {
  const error = asRecord(json['error']);
  if (!error) return undefined;
  return readString(error, 'message') || 'The endpoint reported an error.';
}

/** `mistral` is the same wire protocol; only its presets differ. */
export function createOpenAiAdapter(kind: AiProviderKind): AiProviderAdapter {
  return {
    kind,
    apiKeyRequired: true,
    framing: 'sse',

    modelsRequest(profile: AiConnectionProfile, apiKey: string): AiRequestPlan {
      return { method: 'GET', url: endpoint(profile.baseUrl, '/models'), headers: headers(apiKey) };
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
      return {
        method: 'POST',
        url: endpoint(profile.baseUrl, '/chat/completions'),
        headers: headers(apiKey),
        body: JSON.stringify({
          model: profile.model,
          messages: [{ role: 'user', content: 'Réponds uniquement : OK' }],
          ...(capabilities.temperature ? { temperature: 0 } : {}),
          max_tokens: 4,
          stream: false,
          ...(capabilities.reasoning ? { reasoning_effort: 'high' } : {}),
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
      // The `/no_think` marker is inert text for servers that ignore it, so it is kept
      // even after the structured hints below have been degraded away.
      const reasoningOff = request.reasoning === 'disabled';
      const body: Record<string, unknown> = {
        model: profile.model,
        messages: [
          {
            role: 'system',
            content: reasoningOff ? `${request.systemPrompt}\n/no_think` : request.systemPrompt,
          },
          ...request.messages,
        ],
        max_tokens: profile.maxTokens,
        stream: true,
      };
      if (capabilities.temperature) {
        body['temperature'] = request.temperature ?? modeTemperature(request.mode);
      }
      if (capabilities.disableReasoning) {
        body['reasoning_effort'] = 'none';
        body['chat_template_kwargs'] = { enable_thinking: false };
      }
      if (capabilities.reasoning) body['reasoning_effort'] = 'high';
      return {
        method: 'POST',
        url: endpoint(profile.baseUrl, '/chat/completions'),
        headers: headers(apiKey),
        body: JSON.stringify(body),
      };
    },

    parseFrame(data: string): AiStreamFrame {
      try {
        const json = asRecord(JSON.parse(data));
        if (!json) return EMPTY_FRAME;
        const error = streamError(json);
        if (error) return { content: '', reasoning: false, error };
        const choices = json['choices'];
        const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
        const payload = asRecord(choice?.['delta']) ?? asRecord(choice?.['message']);
        const content = payload?.['content'];
        const reasoning = payload?.['reasoning'];
        const details = payload?.['reasoning_details'];
        return {
          content: typeof content === 'string' ? content : '',
          reasoning:
            (typeof reasoning === 'string' && reasoning.length > 0) ||
            (Array.isArray(details) && details.length > 0),
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
      if (current.temperature && mentions(body, 'temperature')) {
        return { ...current, temperature: false };
      }
      if (current.reasoning) return { ...current, reasoning: false };
      if (current.disableReasoning) return { ...current, disableReasoning: false };
      if (current.temperature) return { ...current, temperature: false };
      return null;
    },
  };
}
