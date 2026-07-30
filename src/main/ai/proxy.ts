import type { BrowserWindow } from 'electron';
import type { AiChatRequest, AiConnectionProfile, AiErrorCode } from '@shared/ai/index.js';
import type {
  AiProviderAdapter,
  AiRequestPlan,
  AiStreamFrame,
  ProviderCapabilities,
} from '@shared/ai/providers/index.js';
import { providerAdapter } from '@shared/ai/providers/index.js';
import { getAiApiKey, resolveAiProfile } from './settings.js';

const requests = new Map<string, AbortController>();

/**
 * Optional request fields an endpoint has been observed to reject, remembered for the
 * session. Keyed by provider, URL *and* model: two models behind the same URL rarely
 * accept the same optional parameters.
 */
const supportedCapabilities = new Map<string, ProviderCapabilities>();

const ALL_CAPABILITIES: ProviderCapabilities = {
  reasoning: true,
  disableReasoning: true,
  temperature: true,
};

const CAPABILITY_KEYS = ['reasoning', 'disableReasoning', 'temperature'] as const;

/** A degraded retry only ever drops fields, so three attempts exhaust the ladder. */
const MAX_ATTEMPTS = 3;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}

function supportKey(profile: AiConnectionProfile): string {
  return `${profile.provider}|${profile.baseUrl}|${profile.model}`;
}

function knownSupport(profile: AiConnectionProfile): ProviderCapabilities {
  return supportedCapabilities.get(supportKey(profile)) ?? ALL_CAPABILITIES;
}

/** Records only the fields this degradation actually turned off. */
function rememberDegradation(
  profile: AiConnectionProfile,
  before: ProviderCapabilities,
  after: ProviderCapabilities,
): void {
  const next = { ...knownSupport(profile) };
  for (const key of CAPABILITY_KEYS) {
    if (before[key] && !after[key]) next[key] = false;
  }
  supportedCapabilities.set(supportKey(profile), next);
}

/**
 * What this request would ideally use, narrowed by what the endpoint has already
 * refused. `request` is absent for the connection probe, which never asks for reasoning.
 */
function effectiveCapabilities(
  profile: AiConnectionProfile,
  request?: AiChatRequest,
): ProviderCapabilities {
  const support = knownSupport(profile);
  const wantsReasoning = request
    ? request.reasoning !== 'disabled' && profile.reasoningEnabled
    : profile.reasoningEnabled;
  return {
    reasoning: wantsReasoning && support.reasoning,
    disableReasoning: request?.reasoning === 'disabled' && support.disableReasoning,
    temperature: support.temperature,
  };
}

async function fetchPlan(
  plan: AiRequestPlan,
  timeoutMs: number,
  external?: AbortController,
): Promise<Response> {
  const controller = external ?? new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      ...(plan.body === undefined ? {} : { body: plan.body }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseError(response: Response): Promise<never> {
  const body = (await response.text()).slice(0, 20_000);
  throw new HttpError(response.status, body);
}

/** Endpoints use both statuses to refuse an unsupported optional parameter. */
function isParameterRejection(response: Response): boolean {
  return response.status === 400 || response.status === 422;
}

/**
 * Sends a request, and on a parameter rejection asks the adapter which optional field to
 * drop before retrying. The surviving capability set is returned so the caller can report
 * what was actually used.
 */
async function sendWithDegradation(
  adapter: AiProviderAdapter,
  profile: AiConnectionProfile,
  build: (capabilities: ProviderCapabilities) => AiRequestPlan,
  initial: ProviderCapabilities,
  controller?: AbortController,
): Promise<{ response: Response; capabilities: ProviderCapabilities }> {
  let capabilities = initial;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchPlan(build(capabilities), profile.timeoutMs, controller);
    if (response.ok || !isParameterRejection(response) || attempt >= MAX_ATTEMPTS) {
      return { response, capabilities };
    }
    const body = (await response.text()).slice(0, 20_000);
    const next = adapter.degrade(capabilities, response.status, body);
    // The body is already consumed, so the rejection has to be raised here.
    if (!next) throw new HttpError(response.status, body);
    rememberDegradation(profile, capabilities, next);
    capabilities = next;
  }
}

export async function listAiModels(
  profile: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<string[]> {
  const adapter = providerAdapter(profile.provider);
  const apiKey = apiKeyOverride ?? (await getAiApiKey(profile.id));
  const response = await fetchPlan(adapter.modelsRequest(profile, apiKey), profile.timeoutMs);
  if (!response.ok) return responseError(response);
  return adapter.parseModels((await response.json()) as unknown);
}

export async function testAiConnection(
  profile: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<{ latencyMs: number; model: string }> {
  const adapter = providerAdapter(profile.provider);
  const apiKey = apiKeyOverride ?? (await getAiApiKey(profile.id));
  const started = performance.now();
  const { response } = await sendWithDegradation(
    adapter,
    profile,
    (capabilities) => adapter.probeRequest(profile, apiKey, capabilities),
    effectiveCapabilities(profile),
  );
  if (!response.ok) return responseError(response);
  return {
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    model: adapter.parseProbe((await response.json()) as unknown, profile.model),
  };
}

function classifyError(error: unknown): { code: AiErrorCode; message: string } {
  if (error instanceof HttpError) {
    const lower = error.body.toLowerCase();
    if (error.status === 401 || error.status === 403) {
      return { code: 'unauthorized', message: 'The API key was refused by the endpoint.' };
    }
    // 529 is Anthropic's overload status; both mean « come back shortly ».
    if (error.status === 429 || error.status === 529) {
      return { code: 'rateLimit', message: 'The endpoint rate limit was reached.' };
    }
    if (
      lower.includes('context') &&
      (lower.includes('length') || lower.includes('window') || lower.includes('token'))
    ) {
      return { code: 'contextLength', message: 'The attached context is too long for this model.' };
    }
    if (error.status === 400 || error.status === 422) {
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

interface StreamOutcome {
  contentReceived: boolean;
  reasoningReceived: boolean;
  /** An error the provider reported inside the stream rather than by HTTP status. */
  error?: string;
}

/**
 * Decodes a provider stream. Server-sent events are accumulated per event and flushed on
 * the blank separator line; newline-delimited JSON is one complete object per line, with
 * no prefix and no terminator.
 */
async function readStream(
  response: Response,
  framing: AiProviderAdapter['framing'],
  parseFrame: (data: string) => AiStreamFrame,
  onChunk: (chunk: string) => void,
  onReasoning: () => void,
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = { contentReceived: false, reasoningReceived: false };
  const accept = (data: string) => {
    const frame = parseFrame(data);
    if (frame.error && outcome.error === undefined) outcome.error = frame.error;
    if (frame.reasoning && !outcome.reasoningReceived) {
      outcome.reasoningReceived = true;
      onReasoning();
    }
    if (frame.content) {
      outcome.contentReceived = true;
      onChunk(frame.content);
    }
  };

  // A server that ignored `stream` answers with a single JSON body.
  if (
    framing === 'sse' &&
    !(response.headers.get('content-type') ?? '').includes('text/event-stream')
  ) {
    accept(await response.text());
    return outcome;
  }
  if (!response.body) return outcome;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  const flushEvent = () => {
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
      if (framing === 'ndjson') {
        if (line.trim()) accept(line);
      } else if (line === '') {
        if (flushEvent()) return outcome;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (done) {
      if (framing === 'sse') flushEvent();
      return outcome;
    }
  }
}

export function startAiChat(window: BrowserWindow, request: AiChatRequest): void {
  requests.get(request.requestId)?.abort();
  const controller = new AbortController();
  requests.set(request.requestId, controller);

  const send = <T>(channel: string, payload: T) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  void (async () => {
    try {
      const profile = await resolveAiProfile(request.profileId);
      const adapter = providerAdapter(profile.provider);
      const apiKey = await getAiApiKey(profile.id);
      const { response, capabilities } = await sendWithDegradation(
        adapter,
        profile,
        (current) => adapter.chatRequest(profile, apiKey, request, current),
        effectiveCapabilities(profile, request),
        controller,
      );
      if (!response.ok) await responseError(response);

      const stream = await readStream(
        response,
        adapter.framing,
        (data) => adapter.parseFrame(data),
        (chunk) => send('ai:chunk', { requestId: request.requestId, chunk }),
        () => send('ai:reasoning', { requestId: request.requestId }),
      );
      if (stream.error !== undefined) {
        send('ai:error', {
          requestId: request.requestId,
          code: 'unknown' satisfies AiErrorCode,
          message: stream.error,
        });
        return;
      }
      if (!stream.contentReceived) {
        send('ai:error', {
          requestId: request.requestId,
          code: 'emptyResponse' satisfies AiErrorCode,
          message: stream.reasoningReceived
            ? 'The model used its generation budget for reasoning without producing a final answer. Increase max_tokens and try again.'
            : 'The endpoint completed the request without returning any text.',
        });
        return;
      }
      send('ai:done', { requestId: request.requestId, reasoningUsed: capabilities.reasoning });
    } catch (error) {
      send('ai:error', { requestId: request.requestId, ...classifyError(error) });
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
