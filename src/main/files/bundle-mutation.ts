/**
 * Serialises mutations of document-owned filesystem state.
 *
 * Save As must observe one coherent source bundle while appdata, Bible assets and snapshots
 * normally have independent writers. A single queue is deliberately sufficient here: these
 * writes are short, local filesystem operations, and one authority is easier to reason about
 * than lock ordering across two paths during A -> B duplication.
 */
import { resolve } from 'node:path';
import { comparableDocumentPath } from '@shared/documents/paths.js';

let pending: Promise<unknown> = Promise.resolve();
const transitions = new Map<string, number>();

function documentKey(path: string): string {
  return comparableDocumentPath(resolve(path));
}

/**
 * Prevents a late operation that still owns A (or a concurrently open B) from entering the
 * filesystem queue while Save As is changing the bundle identity.
 */
export function beginBundleTransition(paths: readonly string[]): () => void {
  const keys = [...new Set(paths.map(documentKey))];
  for (const key of keys) transitions.set(key, (transitions.get(key) ?? 0) + 1);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const key of keys) {
      const remaining = (transitions.get(key) ?? 1) - 1;
      if (remaining === 0) transitions.delete(key);
      else transitions.set(key, remaining);
    }
  };
}

export function withBundleMutation<T>(operation: () => Promise<T>): Promise<T> {
  const current = pending.then(operation, operation);
  pending = current;
  void current.catch(() => {
    // The next mutation is chained through both success and failure and remains runnable.
  });
  return current;
}

/** A document-scoped mutation is rejected rather than writing through a Save As transition. */
export function withDocumentBundleMutation<T>(
  screenplayPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (transitions.has(documentKey(screenplayPath))) {
    return Promise.reject(new Error('The project path is changing; retry the operation'));
  }
  return withBundleMutation(operation);
}
