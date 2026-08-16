import { describe, expect, it } from 'vitest';
import type {
  AiChatRequest,
  AiConnectionProfile,
  AiReasoningEffort,
} from '../../src/shared/ai/index.js';
import { DEFAULT_AI_PROFILE } from '../../src/shared/ai/index.js';
import type { AiProviderKind, ProviderCapabilities } from '../../src/shared/ai/providers/index.js';
import {
  isProviderKind,
  PROVIDER_KINDS,
  PROVIDER_PRESETS,
  providerAdapter,
} from '../../src/shared/ai/providers/index.js';

function profile(
  provider: AiProviderKind,
  overrides: Partial<AiConnectionProfile> = {},
): AiConnectionProfile {
  const preset = PROVIDER_PRESETS[provider];
  return {
    ...DEFAULT_AI_PROFILE,
    provider,
    baseUrl: preset.defaultBaseUrl,
    model: preset.defaultModel,
    maxTokens: 4_096,
    ...overrides,
  };
}

/** A profile with reasoning switched on, at a given depth. */
function reasoning(
  provider: AiProviderKind,
  effort: AiReasoningEffort = 'auto',
): AiConnectionProfile {
  return profile(provider, { reasoningEnabled: true, reasoningEffort: effort });
}

function chat(overrides: Partial<AiChatRequest> = {}): AiChatRequest {
  return {
    requestId: 'req-1',
    profileId: 'default',
    mode: 'factual',
    systemPrompt: 'Tu es un assistant.',
    messages: [{ role: 'user', content: 'Bonjour' }],
    ...overrides,
  };
}

/** Reasoning on at the provider's own depth: what an `auto` profile negotiates. */
const ALL: ProviderCapabilities = {
  reasoning: true,
  gradedReasoning: false,
  disableReasoning: false,
  temperature: true,
};
/** Reasoning on and the endpoint still believed to accept a graded depth. */
const GRADED: ProviderCapabilities = { ...ALL, gradedReasoning: true };
/** Reasoning explicitly switched off. */
const OFF: ProviderCapabilities = {
  reasoning: false,
  gradedReasoning: false,
  disableReasoning: true,
  temperature: true,
};
const NONE: ProviderCapabilities = {
  reasoning: false,
  gradedReasoning: false,
  disableReasoning: false,
  temperature: false,
};

function bodyOf(plan: { body?: string }): Record<string, unknown> {
  return JSON.parse(plan.body ?? '{}') as Record<string, unknown>;
}

describe('provider registry', () => {
  it('exposes an adapter and a preset for every declared kind', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(providerAdapter(kind).kind).toBe(kind);
      expect(PROVIDER_PRESETS[kind].defaultBaseUrl).toMatch(/^https?:\/\//);
      expect(PROVIDER_PRESETS[kind].defaultModel.length).toBeGreaterThan(0);
    }
    expect(isProviderKind('anthropic')).toBe(true);
    expect(isProviderKind('cohere')).toBe(false);
    expect(isProviderKind(undefined)).toBe(false);
  });

  it('only makes the API key optional for a local Ollama', () => {
    const optional = PROVIDER_KINDS.filter((kind) => !PROVIDER_PRESETS[kind].apiKeyRequired);
    expect(optional).toEqual(['ollama']);
  });
});

describe('OpenAI-compatible adapter', () => {
  const adapter = providerAdapter('openai');

  it('does not duplicate a /v1 suffix the author already pasted', () => {
    expect(adapter.modelsRequest(profile('openai', { baseUrl: 'https://host/v1' }), 'k').url).toBe(
      'https://host/v1/models',
    );
    expect(adapter.modelsRequest(profile('openai', { baseUrl: 'https://host' }), 'k').url).toBe(
      'https://host/v1/models',
    );
  });

  it('sends the key as a bearer and the prompt as a system message', () => {
    // Reasoning on, so the prompt carries no `/no_think` suffix to assert around.
    const plan = adapter.chatRequest(reasoning('openai'), 'secret', chat(), ALL);
    expect(plan.headers['Authorization']).toBe('Bearer secret');
    expect(bodyOf(plan)['messages']).toEqual([
      { role: 'system', content: 'Tu es un assistant.' },
      { role: 'user', content: 'Bonjour' },
    ]);
    expect(bodyOf(plan)).toMatchObject({ temperature: 0.2, max_tokens: 4_096, stream: true });
  });

  it('omits the Authorization header entirely without a key', () => {
    const plan = adapter.chatRequest(profile('openai'), '', chat(), ALL);
    expect(plan.headers).not.toHaveProperty('Authorization');
  });

  it('keeps the /no_think marker after the structured hints are degraded away', () => {
    const request = chat({ reasoning: 'disabled' });
    const hinted = bodyOf(adapter.chatRequest(profile('openai'), 'k', request, OFF));
    expect(hinted['reasoning_effort']).toBe('none');
    expect(hinted['chat_template_kwargs']).toEqual({ enable_thinking: false });

    const bare = bodyOf(adapter.chatRequest(profile('openai'), 'k', request, NONE));
    expect(bare).not.toHaveProperty('reasoning_effort');
    expect(bare).not.toHaveProperty('chat_template_kwargs');
    expect(bare).not.toHaveProperty('temperature');
    // The marker is inert text, so it survives — the server may still honour it.
    expect(bare['messages']).toEqual([
      { role: 'system', content: 'Tu es un assistant.\n/no_think' },
      { role: 'user', content: 'Bonjour' },
    ]);
  });

  it('sends each reasoning level verbatim and omits the field at auto', () => {
    const effortOf = (effort: AiReasoningEffort): unknown =>
      bodyOf(adapter.chatRequest(reasoning('openai', effort), 'k', chat(), GRADED))[
        'reasoning_effort'
      ];
    expect(effortOf('low')).toBe('low');
    expect(effortOf('medium')).toBe('medium');
    expect(effortOf('high')).toBe('high');
    // `auto` defers to the server, which means saying nothing rather than picking a level.
    expect(bodyOf(adapter.chatRequest(reasoning('openai'), 'k', chat(), ALL))).not.toHaveProperty(
      'reasoning_effort',
    );
  });

  it('switches reasoning off from the profile alone, with no task override', () => {
    const body = bodyOf(adapter.chatRequest(profile('openai'), 'k', chat(), OFF));
    expect(body['reasoning_effort']).toBe('none');
    expect(body['chat_template_kwargs']).toEqual({ enable_thinking: false });
  });

  it('still sends the chosen depth after an unrelated refusal', () => {
    // `reasoning` puts nothing on the wire for this protocol, so a refusal recorded against
    // it must not take the author's depth down with it.
    const body = bodyOf(
      adapter.chatRequest(reasoning('openai', 'low'), 'k', chat(), {
        ...GRADED,
        reasoning: false,
      }),
    );
    expect(body['reasoning_effort']).toBe('low');
  });

  it('parses deltas, non-streamed messages, reasoning and stream errors', () => {
    expect(adapter.parseFrame(JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }))).toEqual(
      {
        content: 'Hi',
        reasoning: false,
      },
    );
    expect(
      adapter.parseFrame(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })),
    ).toEqual({ content: 'OK', reasoning: false });
    expect(
      adapter.parseFrame(JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] })).reasoning,
    ).toBe(true);
    expect(
      adapter.parseFrame(JSON.stringify({ choices: [{ delta: { reasoning_details: [{}] } }] }))
        .reasoning,
    ).toBe(true);
    expect(adapter.parseFrame(JSON.stringify({ error: { message: 'boom' } })).error).toBe('boom');
    expect(adapter.parseFrame('not json')).toEqual({ content: '', reasoning: false });
  });

  it('drops the graded level, then reasoning, then the hints, then temperature', () => {
    const start: ProviderCapabilities = {
      reasoning: true,
      gradedReasoning: true,
      disableReasoning: true,
      temperature: true,
    };
    // The level goes first: an endpoint that refuses `reasoning_effort: 'low'` may still
    // reason at its own depth.
    const first = adapter.degrade(start, 400, 'reasoning_effort unsupported');
    expect(first).toMatchObject({ reasoning: true, gradedReasoning: false });
    // Then both reasoning hints together — `reasoning` alone changes no bytes here, so
    // dropping it on its own would resend an identical body.
    const second = adapter.degrade(first!, 422, 'extra_forbidden: chat_template_kwargs');
    expect(second).toMatchObject({ reasoning: false, disableReasoning: false, temperature: true });
    const third = adapter.degrade(second!, 400, 'unsupported parameter');
    expect(third).toMatchObject({ temperature: false });
    expect(adapter.degrade(third!, 400, 'still broken')).toBeNull();
  });

  it('attributes a rejection to temperature when the body names it', () => {
    expect(adapter.degrade(ALL, 400, 'Unsupported value: temperature')).toMatchObject({
      reasoning: true,
      temperature: false,
    });
  });
});

describe('Mistral', () => {
  it('reuses the OpenAI protocol and only differs by its presets', () => {
    const adapter = providerAdapter('mistral');
    expect(adapter.framing).toBe('sse');
    expect(adapter.chatRequest(profile('mistral'), 'k', chat(), ALL).url).toBe(
      'https://api.mistral.ai/v1/chat/completions',
    );
  });
});

describe('Anthropic adapter', () => {
  const adapter = providerAdapter('anthropic');

  it('authenticates with x-api-key and pins the API version', () => {
    const plan = adapter.chatRequest(profile('anthropic'), 'sk-ant', chat(), ALL);
    expect(plan.url).toBe('https://api.anthropic.com/v1/messages');
    expect(plan.headers['x-api-key']).toBe('sk-ant');
    expect(plan.headers['anthropic-version']).toBe('2023-06-01');
    expect(plan.headers).not.toHaveProperty('Authorization');
  });

  it('hoists the system prompt to the root and always sends max_tokens', () => {
    const body = bodyOf(adapter.chatRequest(profile('anthropic'), 'k', chat(), ALL));
    expect(body['system']).toBe('Tu es un assistant.');
    expect(body['max_tokens']).toBe(4_096);
    expect(body['messages']).toEqual([{ role: 'user', content: 'Bonjour' }]);
    expect(body['thinking']).toEqual({ type: 'adaptive' });
  });

  it('carries the level in output_config.effort, never as a token budget', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const body = bodyOf(adapter.chatRequest(reasoning('anthropic', effort), 'k', chat(), GRADED));
      expect(body['thinking']).toEqual({ type: 'adaptive' });
      expect(body['output_config']).toEqual({ effort });
      // Current Claude models reject a thinking budget outright.
      expect(body['thinking']).not.toHaveProperty('budget_tokens');
    }
    const auto = bodyOf(adapter.chatRequest(reasoning('anthropic'), 'k', chat(), ALL));
    expect(auto).not.toHaveProperty('output_config');
  });

  it('keeps thinking after the effort field alone is refused', () => {
    const dropped = adapter.degrade(GRADED, 400, 'output_config.effort: unsupported');
    expect(dropped).toMatchObject({ reasoning: true, gradedReasoning: false });
    const body = bodyOf(adapter.chatRequest(reasoning('anthropic', 'high'), 'k', chat(), dropped!));
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body).not.toHaveProperty('output_config');
  });

  it('switches thinking off explicitly, then omits it once refused', () => {
    const off = bodyOf(
      adapter.chatRequest(profile('anthropic'), 'k', chat({ reasoning: 'disabled' }), OFF),
    );
    expect(off['thinking']).toEqual({ type: 'disabled' });
    const none = bodyOf(adapter.chatRequest(profile('anthropic'), 'k', chat(), NONE));
    expect(none).not.toHaveProperty('thinking');
    expect(none).not.toHaveProperty('temperature');
  });

  it('normalises a history Claude would reject', () => {
    const body = bodyOf(
      adapter.chatRequest(
        profile('anthropic'),
        'k',
        chat({
          messages: [
            { role: 'assistant', content: 'ignoré' },
            { role: 'user', content: 'A' },
            { role: 'user', content: 'B' },
            { role: 'assistant', content: 'C' },
          ],
        }),
        ALL,
      ),
    );
    // Leading assistant turn dropped, consecutive user turns merged.
    expect(body['messages']).toEqual([
      { role: 'user', content: 'A\n\nB' },
      { role: 'assistant', content: 'C' },
    ]);
  });

  it('never asks the probe for reasoning, so a tiny budget still returns text', () => {
    const body = bodyOf(adapter.probeRequest(profile('anthropic'), 'k', GRADED));
    expect(body).not.toHaveProperty('thinking');
    expect(body['max_tokens']).toBe(16);
    expect(body['stream']).toBe(false);
  });

  it('reads the model catalogue and paginates in one page', () => {
    expect(adapter.modelsRequest(profile('anthropic'), 'k').url).toContain('limit=1000');
    expect(
      adapter.parseModels({
        data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }, { nope: true }],
        has_more: false,
      }),
    ).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('parses named events: text, thinking blocks and in-stream errors', () => {
    expect(
      adapter.parseFrame(
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Salut' },
        }),
      ),
    ).toEqual({ content: 'Salut', reasoning: false });
    expect(
      adapter.parseFrame(
        JSON.stringify({ type: 'content_block_start', content_block: { type: 'thinking' } }),
      ).reasoning,
    ).toBe(true);
    // Thinking text is empty unless summaries are requested; the block still signals it.
    expect(
      adapter.parseFrame(
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: '' },
        }),
      ).reasoning,
    ).toBe(true);
    expect(adapter.parseFrame(JSON.stringify({ type: 'message_start' }))).toEqual({
      content: '',
      reasoning: false,
    });
    expect(
      adapter.parseFrame(JSON.stringify({ type: 'error', error: { message: 'overloaded' } })).error,
    ).toBe('overloaded');
  });

  it('reads a non-streamed body, which the probe and lenient servers return', () => {
    expect(
      adapter.parseFrame(
        JSON.stringify({
          type: 'message',
          content: [
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: 'OK' },
          ],
        }),
      ),
    ).toEqual({ content: 'OK', reasoning: true });
  });

  it('drops temperature first — the field current Claude models reject', () => {
    const first = adapter.degrade(ALL, 400, 'unexpected keyword argument');
    expect(first).toMatchObject({ temperature: false, reasoning: true });
    const second = adapter.degrade(first!, 400, 'still rejected');
    expect(second).toMatchObject({ reasoning: false, disableReasoning: false });
    expect(adapter.degrade(second!, 400, 'nothing left')).toBeNull();
  });

  it('targets thinking when the body names it', () => {
    expect(
      adapter.degrade(ALL, 400, '`thinking.type: disabled` is not supported at this effort'),
    ).toMatchObject({ reasoning: false, disableReasoning: false, temperature: true });
  });
});

describe('Google adapter', () => {
  const adapter = providerAdapter('google');

  it('puts the model in the path and asks for SSE framing', () => {
    const plan = adapter.chatRequest(profile('google'), 'AIza', chat(), ALL);
    expect(plan.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(plan.headers['x-goog-api-key']).toBe('AIza');
  });

  it('accepts a fully qualified model name without doubling the prefix', () => {
    const plan = adapter.chatRequest(
      profile('google', { model: 'models/gemini-2.5-flash' }),
      'k',
      chat(),
      ALL,
    );
    expect(plan.url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
    expect(plan.url).not.toContain('models/models/');
  });

  it('does not duplicate a /v1beta suffix the author already pasted', () => {
    expect(
      adapter.modelsRequest(profile('google', { baseUrl: 'https://host/v1beta' }), 'k').url,
    ).toBe('https://host/v1beta/models?pageSize=1000');
  });

  it('maps the conversation to contents/parts with model in place of assistant', () => {
    const body = bodyOf(
      adapter.chatRequest(
        profile('google'),
        'k',
        chat({
          messages: [
            { role: 'user', content: 'A' },
            { role: 'assistant', content: 'B' },
          ],
        }),
        ALL,
      ),
    );
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'Tu es un assistant.' }] });
    expect(body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'A' }] },
      { role: 'model', parts: [{ text: 'B' }] },
    ]);
    expect(body['generationConfig']).toEqual({
      maxOutputTokens: 4_096,
      temperature: 0.2,
      thinkingConfig: { thinkingBudget: -1 },
    });
  });

  it('grades thinking by budget, and falls back to dynamic once a budget is refused', () => {
    const budgetOf = (effort: AiReasoningEffort): unknown =>
      (
        bodyOf(adapter.chatRequest(reasoning('google', effort), 'k', chat(), GRADED))[
          'generationConfig'
        ] as Record<string, unknown>
      )['thinkingConfig'];
    expect(budgetOf('low')).toEqual({ thinkingBudget: 2_048 });
    expect(budgetOf('medium')).toEqual({ thinkingBudget: 8_192 });
    expect(budgetOf('high')).toEqual({ thinkingBudget: 24_576 });
    expect(budgetOf('auto')).toEqual({ thinkingBudget: -1 });

    // A model with a narrower range refuses the number; dynamic thinking survives.
    const dropped = adapter.degrade(GRADED, 400, 'thinkingBudget out of range');
    expect(dropped).toMatchObject({ reasoning: true, gradedReasoning: false });
    const body = bodyOf(adapter.chatRequest(reasoning('google', 'high'), 'k', chat(), dropped!));
    expect((body['generationConfig'] as Record<string, unknown>)['thinkingConfig']).toEqual({
      thinkingBudget: -1,
    });
  });

  it('uses a zero thinking budget to switch reasoning off', () => {
    const body = bodyOf(
      adapter.chatRequest(profile('google'), 'k', chat({ reasoning: 'disabled' }), {
        ...OFF,
        temperature: false,
      }),
    );
    expect(body['generationConfig']).toEqual({
      maxOutputTokens: 4_096,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('strips the models/ prefix and skips models that cannot chat', () => {
    expect(
      adapter.parseModels({
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash' },
        ],
      }),
    ).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('concatenates text parts and keeps thought parts out of the answer', () => {
    expect(
      adapter.parseFrame(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Bon' }, { text: 'jour' }] } }],
        }),
      ),
    ).toEqual({ content: 'Bonjour', reasoning: false });
    expect(
      adapter.parseFrame(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'réflexion', thought: true }, { text: 'OK' }] } },
          ],
        }),
      ),
    ).toEqual({ content: 'OK', reasoning: true });
    expect(adapter.parseFrame(JSON.stringify({ error: { message: 'quota' } })).error).toBe('quota');
  });

  it('reports the responding model version from the probe', () => {
    expect(adapter.parseProbe({ modelVersion: 'gemini-2.5-pro-001' }, 'fallback')).toBe(
      'gemini-2.5-pro-001',
    );
    expect(adapter.parseProbe({}, 'fallback')).toBe('fallback');
  });

  it('drops the thinking config first, since some Pro models refuse a zero budget', () => {
    expect(adapter.degrade(ALL, 400, 'thinkingBudget is not supported')).toMatchObject({
      reasoning: false,
      temperature: true,
    });
  });
});

describe('Ollama adapter', () => {
  const adapter = providerAdapter('ollama');

  it('streams newline-delimited JSON rather than server-sent events', () => {
    expect(adapter.framing).toBe('ndjson');
  });

  it('targets the native chat endpoint and needs no key', () => {
    const plan = adapter.chatRequest(profile('ollama'), '', chat(), ALL);
    expect(plan.url).toBe('http://localhost:11434/api/chat');
    expect(plan.headers).not.toHaveProperty('Authorization');
  });

  it('still forwards a bearer for a reverse-proxied instance', () => {
    expect(
      adapter.chatRequest(profile('ollama'), 'proxy-token', chat(), ALL).headers['Authorization'],
    ).toBe('Bearer proxy-token');
  });

  it('sends the level as a string, and falls back to the boolean once refused', () => {
    const thinkOf = (effort: AiReasoningEffort): unknown =>
      bodyOf(adapter.chatRequest(reasoning('ollama', effort), '', chat(), GRADED))['think'];
    expect(thinkOf('low')).toBe('low');
    expect(thinkOf('medium')).toBe('medium');
    expect(thinkOf('high')).toBe('high');
    expect(thinkOf('auto')).toBe(true);

    // A release that only knows the boolean refuses the string but still reasons.
    const dropped = adapter.degrade(GRADED, 400, 'think: invalid value');
    expect(dropped).toMatchObject({ reasoning: true, gradedReasoning: false });
    expect(
      bodyOf(adapter.chatRequest(reasoning('ollama', 'high'), '', chat(), dropped!))['think'],
    ).toBe(true);
  });

  it('maps output tokens to options.num_predict and reasoning to think', () => {
    const body = bodyOf(adapter.chatRequest(reasoning('ollama'), '', chat(), ALL));
    expect(body['options']).toEqual({ num_predict: 4_096, temperature: 0.2 });
    expect(body['think']).toBe(true);
    const off = bodyOf(
      adapter.chatRequest(profile('ollama'), '', chat({ reasoning: 'disabled' }), OFF),
    );
    expect(off['think']).toBe(false);
    expect(bodyOf(adapter.chatRequest(profile('ollama'), '', chat(), NONE))).not.toHaveProperty(
      'think',
    );
  });

  it('reads installed tags, preferring the model identifier over the display name', () => {
    expect(adapter.modelsRequest(profile('ollama'), '').url).toBe(
      'http://localhost:11434/api/tags',
    );
    expect(
      adapter.parseModels({
        models: [
          { name: 'llama3.1:8b', model: 'llama3.1:8b' },
          { name: 'qwen3:4b' },
          { nope: true },
        ],
      }),
    ).toEqual(['llama3.1:8b', 'qwen3:4b']);
  });

  it('parses a chat line, a thinking line and a bare error string', () => {
    expect(
      adapter.parseFrame(JSON.stringify({ message: { role: 'assistant', content: 'Salut' } })),
    ).toEqual({ content: 'Salut', reasoning: false });
    expect(
      adapter.parseFrame(JSON.stringify({ message: { content: '', thinking: 'hmm' } })).reasoning,
    ).toBe(true);
    expect(adapter.parseFrame(JSON.stringify({ error: 'model not found' })).error).toBe(
      'model not found',
    );
    expect(adapter.parseFrame(JSON.stringify({ done: true }))).toEqual({
      content: '',
      reasoning: false,
    });
  });

  it('drops think before temperature, which Ollama always accepts', () => {
    const first = adapter.degrade(ALL, 400, 'unknown field think');
    expect(first).toMatchObject({ reasoning: false, temperature: true });
    expect(adapter.degrade(first!, 400, 'still broken')).toMatchObject({ temperature: false });
  });
});
