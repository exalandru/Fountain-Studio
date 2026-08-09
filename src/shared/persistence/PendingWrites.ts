export type PendingWriter = () => Promise<void>;

/**
 * Writers whose state still lives in the renderer.
 *
 * A writer remains active while its component is mounted. When that component unmounts,
 * the coordinator starts one flush and keeps the writer detached until that flush succeeds.
 * This is what lets an appdata or Bible write survive a document switch without moving the
 * sidecar's ownership into the application shell.
 */
export class PendingWrites {
  private readonly active = new Set<PendingWriter>();
  private readonly detached = new Set<PendingWriter>();
  private readonly inFlight = new Map<PendingWriter, Promise<void>>();
  private generation = 0;

  register(writer: PendingWriter): () => void {
    this.active.add(writer);
    this.detached.delete(writer);
    this.generation += 1;
    let registered = true;

    return () => {
      if (!registered) return;
      registered = false;
      this.active.delete(writer);
      this.detached.add(writer);
      this.generation += 1;
      void this.run(writer).catch(() => {
        // The writer owns user-facing error reporting. Keeping it detached is the retry state.
      });
    };
  }

  /** Attempts every writer and fails only after all of them have settled. */
  async flush(exclude?: PendingWriter): Promise<void> {
    for (;;) {
      const observedGeneration = this.generation;
      const writers = new Set([...this.active, ...this.detached]);
      if (exclude) writers.delete(exclude);
      const outcomes = await Promise.allSettled([...writers].map((writer) => this.run(writer)));
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'One or more pending writes failed');
      }
      if (observedGeneration === this.generation) return;
    }
  }

  private run(writer: PendingWriter): Promise<void> {
    const existing = this.inFlight.get(writer);
    if (existing) return existing;

    const operation = Promise.resolve().then(writer);
    this.inFlight.set(writer, operation);
    void operation.then(
      () => {
        this.inFlight.delete(writer);
        if (!this.active.has(writer)) this.detached.delete(writer);
      },
      () => {
        this.inFlight.delete(writer);
        // A detached failure stays registered so the next close attempt can retry it.
      },
    );
    return operation;
  }
}
