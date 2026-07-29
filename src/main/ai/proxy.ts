import type { BrowserWindow } from 'electron';
import type { AiChatRequest, AiConnectionProfile, AiErrorCode } from '@shared/ai/index.js';
import { modeTemperature } from '@shared/ai/index.js';
import { getAiApiKey, resolveAiProfile } from './settings.js';

const requests = new Map<string, AbortController>();
const reasoningCompatibility = new Map<string, boolean>();
const nonReasoningCompatibility = new Map<string, boolean>();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}

function endpoint(baseUrl: string, path: '/v1/models' | '/v1/chat/completions'): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1')) return `${base}${path.slice(3)}`;
  return `${base}${path}`;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortController,
): Promise<Response> {
  const controller = external ?? new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response: Response): Promise<never> {
  const body = (await response.text()).slice(0, 20_000);
  throw new HttpError(response.status, body);
}

export async function listAiModels(
  profile: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<string[]> {
  const apiKey = apiKeyOverride ?? (await getAiApiKey(profile.id));
  const response = await fetchWithTimeout(
    endpoint(profile.baseUrl, '/v1/models'),
    { method: 'GET', headers: headers(apiKey) },
    profile.timeoutMs,
  );
  if (!response.ok) return responseError(response);
  const json = (await response.json()) as unknown;
  if (
    typeof json !== 'object' ||
    json === null ||
    !Array.isArray((json as { data?: unknown }).data)
  ) {
    return [];
  }
  return (json as { data: unknown[] }).data
    .flatMap((item) =>
      typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
        ? [(item as { id: string }).id]
        : [],
    )
    .sort((left, right) => left.localeCompare(right));
}

export async function testAiConnection(
  profile: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<{ latencyMs: number; model: string }> {
  const apiKey = apiKeyOverride ?? (await getAiApiKey(profile.id));
  const started = performance.now();
  const request = (reasoning: boolean) =>
    fetchWithTimeout(
      endpoint(profile.baseUrl, '/v1/chat/completions'),
      {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({
          model: profile.model,
          messages: [{ role: 'user', content: 'Réponds uniquement : OK' }],
          temperature: 0,
          max_tokens: 4,
          stream: false,
          ...(reasoning ? { reasoning_effort: 'high' } : {}),
        }),
      },
      profile.timeoutMs,
    );
  const useReasoning =
    profile.reasoningEnabled && reasoningCompatibility.get(profile.baseUrl) !== false;
  let response = await request(useReasoning);
  if (response.status === 400 && useReasoning) {
    reasoningCompatibility.set(profile.baseUrl, false);
    response = await request(false);
  }
  if (!response.ok) return responseError(response);
  const json = (await response.json()) as { model?: unknown };
  return {
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    model: typeof json.model === 'string' ? json.model : profile.model,
  };
}

function classifyError(error: unknown): { code: AiErrorCode; message: string } {
  if (error instanceof HttpError) {
    const lower = error.body.toLowerCase();
    if (error.status === 401 || error.status === 403) {
      return { code: 'unauthorized', message: 'The API key was refused by the endpoint.' };
    }
    if (error.status === 429) {
      return { code: 'rateLimit', message: 'The endpoint rate limit was reached.' };
    }
    if (
      lower.includes('context') &&
      (lower.includes('length') || lower.includes('window') || lower.includes('token'))
    ) {
      return { code: 'contextLength', message: 'The attached context is too long for this model.' };
    }
    if (error.status === 400) {
      return {
        code: 'invalidRequest',
        message: error.body || 'The endpoint rejected the request.',
      };
    }
    return {
      code: 'unknown',
      message: error.body || `The endpoint returned HTTP ${error.status}.`,
    };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'cancelled', message: 'The request was cancelled.' };
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { code: 'timeout', message: 'The endpoint did not answer before the timeout.' };
  }
  if (error instanceof TypeError) {
    return { code: 'network', message: 'The endpoint could not be reached.' };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

interface AiDelta {
  content: string;
  reasoning: boolean;
}

function extractDelta(data: string): AiDelta {
  try {
    const json = JSON.parse(data) as {
      choices?: Array<{
        delta?: { content?: unknown; reasoning?: unknown; reasoning_details?: unknown };
        message?: { content?: unknown; reasoning?: unknown; reasoning_details?: unknown };
      }>;
    };
    const choice = json.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    const reasoning = choice?.delta?.reasoning ?? choice?.message?.reasoning;
    const reasoningDetails = choice?.delta?.reasoning_details ?? choice?.message?.reasoning_details;
    return {
      content: typeof content === 'string' ? content : '',
      reasoning:
        (typeof reasoning === 'string' && reasoning.length > 0) ||
        (Array.isArray(reasoningDetails) && reasoningDetails.length > 0),
    };
  } catch {
    return { content: '', reasoning: false };
  }
}

async function readStream(
  response: Response,
  onChunk: (chunk: string) => void,
  onReasoning: () => void,
): Promise<{ contentReceived: boolean; reasoningReceived: boolean }> {
  let contentReceived = false;
  let reasoningReceived = false;
  const accept = (data: string) => {
    const delta = extractDelta(data);
    if (delta.reasoning && !reasoningReceived) {
      reasoningReceived = true;
      onReasoning();
    }
    if (delta.content) {
      contentReceived = true;
      onChunk(delta.content);
    }
  };
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    accept(await response.text());
    return { contentReceived, reasoningReceived };
  }
  if (!response.body) return { contentReceived, reasoningReceived };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) return false;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return true;
    accept(data);
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (line === '') {
        if (flush()) return { contentReceived, reasoningReceived };
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (done) {
      flush();
      return { contentReceived, reasoningReceived };
    }
  }
}

async function chatResponse(
  profile: AiConnectionProfile,
  apiKey: string,
  request: AiChatRequest,
  controller: AbortController,
  reasoning: boolean,
  disableReasoning: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages: [
      {
        role: 'system',
        content: disableReasoning ? `${request.systemPrompt}\n/no_think` : request.systemPrompt,
      },
      ...request.messages,
    ],
    temperature: request.temperature ?? modeTemperature(request.mode),
    max_tokens: profile.maxTokens,
    stream: true,
  };
  if (disableReasoning) {
    body['reasoning_effort'] = 'none';
    body['chat_template_kwargs'] = { enable_thinking: false };
  }
  if (reasoning) body['reasoning_effort'] = 'high';
  return fetchWithTimeout(
    endpoint(profile.baseUrl, '/v1/chat/completions'),
    { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) },
    profile.timeoutMs,
    controller,
  );
}

export function startAiChat(window: BrowserWindow, request: AiChatRequest): void {
  requests.get(request.requestId)?.abort();
  const controller = new AbortController();
  requests.set(request.requestId, controller);

  void (async () => {
    try {
      const profile = await resolveAiProfile(request.profileId);
      const apiKey = await getAiApiKey(profile.id);
      const compatibility = reasoningCompatibility.get(profile.baseUrl);
      let useReasoning =
        request.reasoning !== 'disabled' && profile.reasoningEnabled && compatibility !== false;
      let disableReasoning =
        request.reasoning === 'disabled' &&
        nonReasoningCompatibility.get(profile.baseUrl) !== false;
      let response = await chatResponse(
        profile,
        apiKey,
        request,
        controller,
        useReasoning,
        disableReasoning,
      );
      if (response.status === 400 && useReasoning) {
        reasoningCompatibility.set(profile.baseUrl, false);
        useReasoning = false;
        response = await chatResponse(
          profile,
          apiKey,
          request,
          controller,
          false,
          disableReasoning,
        );
      } else if (response.status === 400 && disableReasoning) {
        nonReasoningCompatibility.set(profile.baseUrl, false);
        disableReasoning = false;
        response = await chatResponse(profile, apiKey, request, controller, false, false);
      }
      if (!response.ok) await responseError(response);

      const stream = await readStream(
        response,
        (chunk) => {
          if (!window.isDestroyed()) {
            window.webContents.send('ai:chunk', { requestId: request.requestId, chunk });
          }
        },
        () => {
          if (!window.isDestroyed()) {
            window.webContents.send('ai:reasoning', { requestId: request.requestId });
          }
        },
      );
      if (!stream.contentReceived) {
        if (!window.isDestroyed()) {
          window.webContents.send('ai:error', {
            requestId: request.requestId,
            code: 'emptyResponse',
            message: stream.reasoningReceived
              ? 'The model used its generation budget for reasoning without producing a final answer. Increase max_tokens and try again.'
              : 'The endpoint completed the request without returning any text.',
          });
        }
        return;
      }
      if (!window.isDestroyed()) {
        window.webContents.send('ai:done', {
          requestId: request.requestId,
          reasoningUsed: useReasoning,
        });
      }
    } catch (error) {
      const classified = classifyError(error);
      if (!window.isDestroyed()) {
        window.webContents.send('ai:error', { requestId: request.requestId, ...classified });
      }
    } finally {
      requests.delete(request.requestId);
    }
  })();
}

export function cancelAiChat(requestId: string): boolean {
  const request = requests.get(requestId);
  if (!request) return false;
  request.abort();
  return true;
}
