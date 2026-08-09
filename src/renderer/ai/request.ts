import { appendCollectedAiChunk, type AiChatRequest, type AiErrorCode } from '@shared/ai/index.js';

export interface AiRequestHandle {
  promise: Promise<string>;
  cancel: () => Promise<void>;
}

export { appendCollectedAiChunk } from '@shared/ai/index.js';

/** One-shot collector for structured M6 tasks over the same streaming IPC proxy. */
export function startCollectedAiRequest(
  request: AiChatRequest,
  onPhase?: (phase: 'reasoning' | 'answering') => void,
): AiRequestHandle {
  let output = '';
  let settled = false;
  let resolvePromise: (value: string) => void;
  let rejectPromise: (reason: Error & { code?: AiErrorCode }) => void;
  const cleanups: Array<() => void> = [];
  const cleanup = () => {
    for (const off of cleanups.splice(0)) off();
  };
  const settleError = (error: Error & { code?: AiErrorCode }) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(error);
  };
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  cleanups.push(
    window.quantum.on('ai:reasoning', ({ requestId }) => {
      if (requestId === request.requestId) onPhase?.('reasoning');
    }),
    window.quantum.on('ai:chunk', ({ requestId, chunk }) => {
      if (requestId !== request.requestId || settled) return;
      const next = appendCollectedAiChunk(output, chunk);
      output = next.text;
      if (next.overflow) {
        settleError(
          Object.assign(new Error('The endpoint response exceeded the local size limit.'), {
            code: 'responseTooLarge' as const,
          }),
        );
        void window.quantum.invoke('ai:chat:cancel', { requestId: request.requestId });
        return;
      }
      onPhase?.('answering');
    }),
    window.quantum.on('ai:done', ({ requestId }) => {
      if (requestId !== request.requestId || settled) return;
      settled = true;
      cleanup();
      resolvePromise(output);
    }),
    window.quantum.on('ai:error', ({ requestId, code, message }) => {
      if (requestId !== request.requestId || settled) return;
      settleError(Object.assign(new Error(message), { code }));
    }),
  );

  void window.quantum.invoke('ai:chat:start', request).catch((reason: unknown) => {
    settleError(reason instanceof Error ? reason : new Error(String(reason)));
  });

  return {
    promise,
    cancel: async () => {
      if (settled) return;
      await window.quantum.invoke('ai:chat:cancel', { requestId: request.requestId });
    },
  };
}
