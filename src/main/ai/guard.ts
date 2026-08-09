import type { AiRequestLimits } from '@shared/ai/limits.js';

export type AiGuardReason = 'deadline' | 'idle' | 'response-too-large' | 'frame-too-large';

/** Abort reason that survives Node/Electron fetch signal propagation. */
export class AiGuardError extends Error {
  readonly code: 'timeout' | 'responseTooLarge';

  constructor(readonly reason: AiGuardReason) {
    const message =
      reason === 'deadline'
        ? 'The endpoint did not finish before the timeout.'
        : reason === 'idle'
          ? 'The endpoint stopped sending data before the timeout.'
          : 'The endpoint response exceeded the local size limit.';
    super(message);
    this.name = 'AiGuardError';
    this.code = reason === 'deadline' || reason === 'idle' ? 'timeout' : 'responseTooLarge';
  }
}

/**
 * Owns deadline + idle timers and byte counters for one AI HTTP exchange.
 *
 * Timers are cleared only on dispose(). Abort is idempotent: the first reason wins.
 */
export class AiRequestGuard {
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private bytes = 0;
  private contentChars = 0;
  private disposed = false;
  private failure: AiGuardError | null = null;

  constructor(
    private readonly controller: AbortController,
    private readonly limits: AiRequestLimits,
  ) {
    this.deadlineTimer = setTimeout(() => this.fail('deadline'), this.limits.deadlineMs);
    this.armIdle();
  }

  get aborted(): boolean {
    return this.failure !== null || this.controller.signal.aborted;
  }

  get error(): AiGuardError | null {
    return this.failure;
  }

  /** Headers or any received network bytes count as activity. */
  noteNetworkProgress(byteLength = 0): void {
    if (this.disposed || this.failure) return;
    if (byteLength > 0) {
      this.bytes += byteLength;
      if (this.bytes > this.limits.maxResponseBytes) {
        this.fail('response-too-large');
        return;
      }
    }
    this.armIdle();
  }

  noteContentChars(charCount: number): void {
    if (this.disposed || this.failure || charCount <= 0) return;
    this.contentChars += charCount;
    if (this.contentChars > this.limits.maxContentChars) {
      this.fail('response-too-large');
    }
  }

  checkIncompleteBuffer(byteLength: number): void {
    if (this.disposed || this.failure) return;
    if (byteLength > this.limits.maxFrameBytes) {
      this.fail('frame-too-large');
    }
  }

  throwIfAborted(): void {
    if (this.failure) throw this.failure;
    if (this.controller.signal.aborted) {
      const reason = this.controller.signal.reason;
      if (reason instanceof AiGuardError) throw reason;
      throw reason instanceof Error
        ? reason
        : new DOMException('The request was cancelled.', 'AbortError');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private armIdle(): void {
    if (this.disposed || this.failure) return;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fail('idle'), this.limits.idleMs);
  }

  private fail(reason: AiGuardReason): void {
    if (this.disposed || this.failure) return;
    this.failure = new AiGuardError(reason);
    this.clearTimers();
    try {
      this.controller.abort(this.failure);
    } catch {
      // Aborting an already-aborted controller is a no-op in supported runtimes.
    }
  }

  private clearTimers(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
