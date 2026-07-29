import type { AiChatRequest, AiErrorCode } from '@shared/ai/index.js';

export interface AiRequestHandle {
  promise: Promise<string>;
  cancel: () => Promise<void>;
}

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
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  cleanups.push(
    window.quantum.on('ai:reasoning', ({ requestId }) => {
      if (requestId === request.requestId) onPhase?.('reasoning');
    }),
    window.quantum.on('ai:chunk', ({ requestId, chunk }) => {
      if (requestId !== request.requestId) return;
      output += chunk;
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
      settled = true;
      cleanup();
      const error = Object.assign(new Error(message), { code });
      rejectPromise(error);
    }),
  );

  void window.quantum.invoke('ai:chat:start', request).catch((reason: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(reason instanceof Error ? reason : new Error(String(reason)));
  });

  return {
    promise,
    cancel: async () => {
      if (settled) return;
      await window.quantum.invoke('ai:chat:cancel', { requestId: request.requestId });
    },
  };
}
