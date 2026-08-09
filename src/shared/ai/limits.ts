/**
 * Local safety limits for AI transport.
 *
 * These are independent of provider `max_tokens`: that field is a request preference,
 * not a bound on bytes Fountain Studio will accept or keep in memory.
 */

export interface AiRequestLimits {
  /** Wall-clock limit covering connect, headers and the entire body. */
  deadlineMs: number;
  /** Reset whenever network progress or a parsed frame arrives. */
  idleMs: number;
  /** Hard cap on bytes read from the network for one response. */
  maxResponseBytes: number;
  /** Hard cap on an incomplete SSE/NDJSON buffer waiting for a delimiter. */
  maxFrameBytes: number;
  /** Hard cap on concatenated assistant text kept for the caller. */
  maxContentChars: number;
}

/** Defaults chosen above realistic screenplay-AI payloads and below DoS sizes. */
export const AI_REQUEST_LIMIT_DEFAULTS = {
  /** Silence after headers/chunks: shorter of 30s or the profile deadline. */
  idleMsCap: 30_000,
  /** ~2 MiB of wire data (SSE framing + reasoning + answer). */
  maxResponseBytes: 2 * 1024 * 1024,
  /** One unfinished event/line must not grow without bound. */
  maxFrameBytes: 512 * 1024,
  /**
   * Profile maxTokens can reach 200_000 (~0.7–1M characters). Stay slightly above that
   * so a legitimate full-budget answer still fits, while rejecting pathological streams.
   */
  maxContentChars: 1_000_000,
} as const;

export function aiRequestLimits(
  timeoutMs: number,
  overrides: Partial<AiRequestLimits> = {},
): AiRequestLimits {
  const deadlineMs = Math.max(1, Math.floor(overrides.deadlineMs ?? timeoutMs));
  const idleMs = overrides.idleMs ?? Math.min(AI_REQUEST_LIMIT_DEFAULTS.idleMsCap, deadlineMs);
  return {
    deadlineMs,
    idleMs,
    maxResponseBytes: overrides.maxResponseBytes ?? AI_REQUEST_LIMIT_DEFAULTS.maxResponseBytes,
    maxFrameBytes: overrides.maxFrameBytes ?? AI_REQUEST_LIMIT_DEFAULTS.maxFrameBytes,
    maxContentChars: overrides.maxContentChars ?? AI_REQUEST_LIMIT_DEFAULTS.maxContentChars,
  };
}

/** Renderer-side bound for concatenating streamed assistant text. */
export function appendCollectedAiChunk(
  current: string,
  chunk: string,
  maxChars: number = AI_REQUEST_LIMIT_DEFAULTS.maxContentChars,
): { text: string; overflow: boolean } {
  const text = current + chunk;
  return { text, overflow: text.length > maxChars };
}
