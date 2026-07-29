import { useEffect, useRef, useState } from 'react';
import type { ParseRequest, ParseResponse } from '@shared/analysis/index.js';

/**
 * Debounced screenplay analysis in a worker.
 *
 * The worker is created once for the whole session: its startup cost should not be paid
 * per tab. Responses carry the document id and revision; those that do not match the
 * last request sent are ignored, so a slow analysis cannot overwrite a newer one.
 *
 * The returned result is **derived** from state, never synchronised by an effect: one
 * tab's analysis must not flash briefly when switching to another.
 */
// The preview has a stricter <100 ms refresh target than the original M1 sidebar.
// Parsing itself takes ~17 ms on 120 pages, leaving enough room for a 50 ms debounce.
const DEBOUNCE_MS = 50;

export function useScreenplay(
  documentId: string | null,
  content: string,
  revision: number,
): ParseResponse | null {
  const [result, setResult] = useState<ParseResponse | null>(null);
  const worker = useRef<Worker | null>(null);
  /** Last request sent; updated inside the effect, never during render. */
  const expected = useRef<{ id: string | null; revision: number }>({ id: null, revision: -1 });

  useEffect(() => {
    const instance = new Worker(new URL('../../workers/parse.worker.ts', import.meta.url), {
      type: 'module',
    });

    instance.onmessage = (event: MessageEvent<ParseResponse>) => {
      const { id, revision: responseRevision } = event.data;
      if (id !== expected.current.id || responseRevision !== expected.current.revision) return;
      setResult(event.data);
    };

    worker.current = instance;
    return () => {
      instance.terminate();
      worker.current = null;
    };
  }, []);

  useEffect(() => {
    if (documentId === null) return;

    const timer = setTimeout(() => {
      expected.current = { id: documentId, revision };
      const request: ParseRequest = { id: documentId, revision, source: content };
      worker.current?.postMessage(request);
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [documentId, content, revision]);

  return result !== null && result.id === documentId ? result : null;
}
