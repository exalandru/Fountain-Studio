import type { BrowserWindow } from 'electron';
import type { AiChatRequest, AiConnectionProfile, AiErrorCode } from '@shared/ai/index.js';
import { sameAiEndpointOrigin } from '@shared/ai/index.js';
import { aiRequestLimits } from '@shared/ai/limits.js';
import type {
  AiProviderAdapter,
  AiRequestPlan,
  ProviderCapabilities,
} from '@shared/ai/providers/index.js';
import { providerAdapter } from '@shared/ai/providers/index.js';
import { AiGuardError, AiRequestGuard } from './guard.js';
import { getAiApiKey, resolveAiProfile } from './settings.js';
import { readProviderStream, readResponseText } from './stream.js';

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

export class AiOriginError extends Error {
  constructor(
    message = 'Stored API key cannot be used with a different endpoint origin. Re-enter the key.',
  ) {
    super(message);
    this.name = 'AiOriginError';
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}

/**
 * M4 — stored credentials only leave main against the disk profile's origin.
 * An explicit non-empty key override may probe a renderer-supplied endpoint (user typed it).
 */
export async function authorizeAiNetworkProfile(
  requested: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<{ profile: AiConnectionProfile; apiKey: string }> {
  if (apiKeyOverride !== undefined && apiKeyOverride.length > 0) {
    return { profile: requested, apiKey: apiKeyOverride };
  }

  const disk = await resolveAiProfile(requested.id);
  if (!sameAiEndpointOrigin(disk.baseUrl, requested.baseUrl)) {
    throw new AiOriginError();
  }
  // Same origin: allow unsaved provider/model edits, but keep the stored key bound to that origin.
  return { profile: requested, apiKey: await getAiApiKey(disk.id) };
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

async function fetchPlan(plan: AiRequestPlan, controller: AbortController): Promise<Response> {
  // Refuse automatic redirects so a trusted origin cannot forward Authorization /
  // provider key headers to a different host without an explicit new request plan.
  return fetch(plan.url, {
    method: plan.method,
    headers: plan.headers,
    ...(plan.body === undefined ? {} : { body: plan.body }),
    signal: controller.signal,
    redirect: 'error',
  });
}

async function responseError(response: Response, guard: AiRequestGuard): Promise<never> {
  const limits = aiRequestLimits(60_000, { maxContentChars: 20_000, maxResponseBytes: 20_000 });
  const body = (
    await readResponseText(response, guard, limits, { countTowardContent: false })
  ).slice(0, 20_000);
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
  controller: AbortController,
  guard: AiRequestGuard,
): Promise<{ response: Response; capabilities: ProviderCapabilities }> {
  let capabilities = initial;
  for (let attempt = 1; ; attempt += 1) {
    guard.throwIfAborted();
    const response = await fetchPlan(build(capabilities), controller);
    guard.noteNetworkProgress(0);
    guard.throwIfAborted();
    if (response.ok || !isParameterRejection(response) || attempt >= MAX_ATTEMPTS) {
      return { response, capabilities };
    }
    const body = (
      await readResponseText(
        response,
        guard,
        aiRequestLimits(profile.timeoutMs, { maxContentChars: 20_000, maxResponseBytes: 20_000 }),
        { countTowardContent: false },
      )
    ).slice(0, 20_000);
    const next = adapter.degrade(capabilities, response.status, body);
    // The body is already consumed, so the rejection has to be raised here.
    if (!next) throw new HttpError(response.status, body);
    rememberDegradation(profile, capabilities, next);
    capabilities = next;
  }
}

async function withGuardedRequest<T>(
  timeoutMs: number,
  run: (controller: AbortController, guard: AiRequestGuard) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const limits = aiRequestLimits(timeoutMs);
  const guard = new AiRequestGuard(controller, limits);
  try {
    return await run(controller, guard);
  } finally {
    guard.dispose();
  }
}

export async function listAiModels(
  profile: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<string[]> {
  return withGuardedRequest(profile.timeoutMs, async (controller, guard) => {
    const authorized = await authorizeAiNetworkProfile(profile, apiKeyOverride);
    const adapter = providerAdapter(authorized.profile.provider);
    const response = await fetchPlan(
      adapter.modelsRequest(authorized.profile, authorized.apiKey),
      controller,
    );
    guard.noteNetworkProgress(0);
    if (!response.ok) await responseError(response, guard);
    const limits = aiRequestLimits(authorized.profile.timeoutMs);
    const text = await readResponseText(response, guard, limits);
    return adapter.parseModels(JSON.parse(text) as unknown);
  });
}

export async function testAiConnection(
  profile: AiConnectionProfile,
  apiKeyOverride?: string,
): Promise<{ latencyMs: number; model: string }> {
  return withGuardedRequest(profile.timeoutMs, async (controller, guard) => {
    const authorized = await authorizeAiNetworkProfile(profile, apiKeyOverride);
    const adapter = providerAdapter(authorized.profile.provider);
    const started = performance.now();
    const { response } = await sendWithDegradation(
      adapter,
      authorized.profile,
      (capabilities) => adapter.probeRequest(authorized.profile, authorized.apiKey, capabilities),
      effectiveCapabilities(authorized.profile),
      controller,
      guard,
    );
    if (!response.ok) await responseError(response, guard);
    const limits = aiRequestLimits(authorized.profile.timeoutMs);
    const text = await readResponseText(response, guard, limits);
    return {
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      model: adapter.parseProbe(JSON.parse(text) as unknown, authorized.profile.model),
    };
  });
}

function classifyError(error: unknown): { code: AiErrorCode; message: string } {
  const candidate =
    error instanceof Error &&
    'cause' in error &&
    (error as { cause: unknown }).cause instanceof AiGuardError
      ? ((error as { cause: unknown }).cause as AiGuardError)
      : error;

  if (candidate instanceof AiGuardError) {
    return { code: candidate.code, message: candidate.message };
  }
  if (candidate instanceof AiOriginError) {
    return { code: 'unauthorized', message: candidate.message };
  }
  if (candidate instanceof HttpError) {
    const lower = candidate.body.toLowerCase();
    if (candidate.status === 401 || candidate.status === 403) {
      return { code: 'unauthorized', message: 'The API key was refused by the endpoint.' };
    }
    // 529 is Anthropic's overload status; both mean « come back shortly ».
    if (candidate.status === 429 || candidate.status === 529) {
      return { code: 'rateLimit', message: 'The endpoint rate limit was reached.' };
    }
    if (
      lower.includes('context') &&
      (lower.includes('length') || lower.includes('window') || lower.includes('token'))
    ) {
      return { code: 'contextLength', message: 'The attached context is too long for this model.' };
    }
    if (candidate.status === 400 || candidate.status === 422) {
      return {
        code: 'invalidRequest',
        message: candidate.body || 'The endpoint rejected the request.',
      };
    }
    return {
      code: 'unknown',
      message: candidate.body || `The endpoint returned HTTP ${candidate.status}.`,
    };
  }
  if (candidate instanceof DOMException && candidate.name === 'AbortError') {
    return { code: 'cancelled', message: 'The request was cancelled.' };
  }
  if (candidate instanceof DOMException && candidate.name === 'TimeoutError') {
    return { code: 'timeout', message: 'The endpoint did not answer before the timeout.' };
  }
  if (candidate instanceof TypeError) {
    return { code: 'network', message: 'The endpoint could not be reached.' };
  }
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'name' in candidate &&
    (candidate as { name: string }).name === 'AbortError'
  ) {
    return { code: 'cancelled', message: 'The request was cancelled.' };
  }
  return {
    code: 'unknown',
    message: candidate instanceof Error ? candidate.message : String(candidate),
  };
}

export function startAiChat(window: BrowserWindow, request: AiChatRequest): void {
  requests.get(request.requestId)?.abort();
  const controller = new AbortController();
  requests.set(request.requestId, controller);

  const send = <T>(channel: string, payload: T) => {
    if (!window.isDestroyed() && requests.get(request.requestId) === controller) {
      window.webContents.send(channel, payload);
    }
  };

  void (async () => {
    let guard: AiRequestGuard | null = null;
    try {
      const profile = await resolveAiProfile(request.profileId);
      const limits = aiRequestLimits(profile.timeoutMs);
      guard = new AiRequestGuard(controller, limits);
      const adapter = providerAdapter(profile.provider);
      const apiKey = await getAiApiKey(profile.id);
      guard.throwIfAborted();
      const { response, capabilities } = await sendWithDegradation(
        adapter,
        profile,
        (current) => adapter.chatRequest(profile, apiKey, request, current),
        effectiveCapabilities(profile, request),
        controller,
        guard,
      );
      if (!response.ok) await responseError(response, guard);

      let finished = false;
      const stream = await readProviderStream(
        response,
        adapter.framing,
        (data) => adapter.parseFrame(data),
        (chunk) => {
          if (finished || requests.get(request.requestId) !== controller) return;
          send('ai:chunk', { requestId: request.requestId, chunk });
        },
        () => {
          if (finished || requests.get(request.requestId) !== controller) return;
          send('ai:reasoning', { requestId: request.requestId });
        },
        guard,
        limits,
      );
      finished = true;
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
      guard?.dispose();
      if (requests.get(request.requestId) === controller) {
        requests.delete(request.requestId);
      }
    }
  })();
}

export function cancelAiChat(requestId: string): boolean {
  const request = requests.get(requestId);
  if (!request) return false;
  request.abort();
  return true;
}
