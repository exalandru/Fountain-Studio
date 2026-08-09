import { describe, expect, it, vi } from 'vitest';
import { PendingWrites } from '../../src/shared/persistence/PendingWrites.js';

describe('pending write coordination', () => {
  it('attempts every writer before reporting a failure', async () => {
    const writes = new PendingWrites();
    const first = vi.fn(async () => {
      throw new Error('disk full');
    });
    const second = vi.fn(async () => undefined);
    writes.register(first);
    writes.register(second);

    await expect(writes.flush()).rejects.toThrow('pending writes failed');
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('retains a detached failed writer and removes it only after acknowledgement', async () => {
    const writes = new PendingWrites();
    let attempts = 0;
    const writer = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('permission denied');
    });
    const unregister = writes.register(writer);

    unregister();
    await expect.poll(() => writer.mock.calls.length).toBe(1);
    await writes.flush();
    await writes.flush();

    expect(writer).toHaveBeenCalledTimes(2);
  });

  it('awaits an in-flight detached writer without starting a duplicate', async () => {
    const writes = new PendingWrites();
    let acknowledge: (() => void) | undefined;
    const writer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const unregister = writes.register(writer);

    unregister();
    await expect.poll(() => writer.mock.calls.length).toBe(1);
    const flushing = writes.flush();
    expect(writer).toHaveBeenCalledOnce();
    acknowledge?.();
    await flushing;
  });

  it('drains a writer registered while a close flush is already in flight', async () => {
    const writes = new PendingWrites();
    let acknowledge: (() => void) | undefined;
    let firstPending = true;
    const first = vi.fn(() => {
      if (!firstPending) return Promise.resolve();
      return new Promise<void>((resolve) => {
        acknowledge = () => {
          firstPending = false;
          resolve();
        };
      });
    });
    const late = vi.fn(async () => undefined);
    writes.register(first);

    const flushing = writes.flush();
    await expect.poll(() => first.mock.calls.length).toBe(1);
    writes.register(late);
    acknowledge?.();
    await flushing;

    expect(late).toHaveBeenCalledOnce();
  });

  it('can exclude the lifecycle barrier owned by the operation performing the flush', async () => {
    const writes = new PendingWrites();
    const sidecar = vi.fn(async () => undefined);
    const lifecycleBarrier = vi.fn(() => new Promise<void>(() => undefined));
    writes.register(sidecar);
    writes.register(lifecycleBarrier);

    await writes.flush(lifecycleBarrier);

    expect(sidecar).toHaveBeenCalledOnce();
    expect(lifecycleBarrier).not.toHaveBeenCalled();
  });
});
