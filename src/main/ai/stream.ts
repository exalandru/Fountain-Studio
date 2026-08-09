import type { AiRequestLimits } from '@shared/ai/limits.js';
import type { AiProviderAdapter, AiStreamFrame } from '@shared/ai/providers/index.js';
import { AiGuardError, type AiRequestGuard } from './guard.js';

export interface StreamOutcome {
  contentReceived: boolean;
  reasoningReceived: boolean;
  /** An error the provider reported inside the stream rather than by HTTP status. */
  error?: string;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function assertContentLength(response: Response, maxResponseBytes: number): void {
  const raw = response.headers.get('content-length');
  if (raw === null) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length > maxResponseBytes) {
    throw new AiGuardError('response-too-large');
  }
}

/** Reads a response body with network/content caps owned by the guard. */
export async function readResponseText(
  response: Response,
  guard: AiRequestGuard,
  limits: AiRequestLimits,
  options: { countTowardContent?: boolean } = {},
): Promise<string> {
  const countTowardContent = options.countTowardContent !== false;
  assertContentLength(response, limits.maxResponseBytes);
  guard.throwIfAborted();

  if (!response.body) {
    const text = await response.text();
    guard.noteNetworkProgress(utf8Bytes(text));
    if (countTowardContent) guard.noteContentChars(text.length);
    else if (text.length > limits.maxContentChars) throw new AiGuardError('response-too-large');
    guard.throwIfAborted();
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let joinedLength = 0;
  try {
    for (;;) {
      guard.throwIfAborted();
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        guard.noteNetworkProgress(value.byteLength);
        const piece = decoder.decode(value, { stream: !done });
        chunks.push(piece);
        joinedLength += piece.length;
        if (joinedLength > limits.maxContentChars) {
          throw new AiGuardError('response-too-large');
        }
        guard.throwIfAborted();
      }
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
          joinedLength += tail.length;
        }
        break;
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort: the transport may already be torn down.
    }
    if (guard.error) throw guard.error;
    throw error;
  }

  const text = chunks.join('');
  if (countTowardContent) guard.noteContentChars(text.length);
  guard.throwIfAborted();
  return text;
}

/**
 * Decodes a provider stream. Server-sent events are accumulated per event and flushed on
 * the blank separator line; newline-delimited JSON is one complete object per line, with
 * no prefix and no terminator.
 */
export async function readProviderStream(
  response: Response,
  framing: AiProviderAdapter['framing'],
  parseFrame: (data: string) => AiStreamFrame,
  onChunk: (chunk: string) => void,
  onReasoning: () => void,
  guard: AiRequestGuard,
  limits: AiRequestLimits,
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = { contentReceived: false, reasoningReceived: false };
  const accept = (data: string) => {
    guard.noteNetworkProgress(0);
    const frame = parseFrame(data);
    if (frame.error && outcome.error === undefined) outcome.error = frame.error;
    if (frame.reasoning && !outcome.reasoningReceived) {
      outcome.reasoningReceived = true;
      onReasoning();
    }
    if (frame.content) {
      outcome.contentReceived = true;
      guard.noteContentChars(frame.content.length);
      guard.throwIfAborted();
      onChunk(frame.content);
    }
  };

  assertContentLength(response, limits.maxResponseBytes);

  // A server that ignored `stream` answers with a single JSON body.
  if (
    framing === 'sse' &&
    !(response.headers.get('content-type') ?? '').includes('text/event-stream')
  ) {
    const text = await readResponseText(response, guard, limits);
    const frame = parseFrame(text);
    if (frame.error && outcome.error === undefined) outcome.error = frame.error;
    if (frame.reasoning && !outcome.reasoningReceived) {
      outcome.reasoningReceived = true;
      onReasoning();
    }
    if (frame.content) {
      outcome.contentReceived = true;
      guard.throwIfAborted();
      onChunk(frame.content);
    }
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

  try {
    for (;;) {
      guard.throwIfAborted();
      const { done, value } = await reader.read();
      if (value && value.byteLength > 0) {
        guard.noteNetworkProgress(value.byteLength);
      } else if (!done) {
        // Empty chunks are not progress; idle continues to count down.
      }
      buffer += decoder.decode(value, { stream: !done });
      guard.checkIncompleteBuffer(utf8Bytes(buffer));
      guard.throwIfAborted();

      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      guard.checkIncompleteBuffer(utf8Bytes(buffer));

      for (const line of lines) {
        if (framing === 'ndjson') {
          if (line.trim()) accept(line);
        } else if (line === '') {
          if (flushEvent()) {
            try {
              await reader.cancel();
            } catch {
              // Peer may already have closed after [DONE].
            }
            return outcome;
          }
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
          guard.checkIncompleteBuffer(utf8Bytes(dataLines.join('\n')));
        }
        guard.throwIfAborted();
      }
      if (done) {
        if (framing === 'sse') flushEvent();
        return outcome;
      }
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup after abort/timeout.
    }
    if (guard.error) throw guard.error;
    throw error;
  }
}
