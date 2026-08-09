import { comparableDocumentPath, detectPathPlatform, type PathPlatform } from './paths.js';

/**
 * Serialises open/Save-As claims for one document path inside a renderer instance.
 *
 * Ownership itself lives in the open-document store. This coordinator only closes the
 * check → await → commit race between two events that both want to bind the same path.
 */
export class DocumentPathCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly platform: PathPlatform = detectPathPlatform()) {}

  runExclusive<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const key = comparableDocumentPath(path, this.platform);
    const previous = this.queues.get(key) ?? Promise.resolve();
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.queues.set(key, gate);

    const run = previous.then(operation, operation);
    void run.finally(() => {
      settle();
      if (this.queues.get(key) === gate) this.queues.delete(key);
    });
    return run;
  }
}

/** One coordinator per renderer instance so Open, Save As and recovery share the same queue. */
let sharedCoordinator: DocumentPathCoordinator | null = null;

export function sharedDocumentPathCoordinator(
  platform: PathPlatform = detectPathPlatform(),
): DocumentPathCoordinator {
  sharedCoordinator ??= new DocumentPathCoordinator(platform);
  return sharedCoordinator;
}

/** Test-only: drop the shared instance between isolated cases. */
export function resetSharedDocumentPathCoordinator(): void {
  sharedCoordinator = null;
}
