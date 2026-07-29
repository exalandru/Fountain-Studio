import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Translator } from '@shared/i18n/index.js';
import type { NewDocumentStrings } from '../store/documents.js';
import { useDocuments } from '../store/documents.js';

interface RecoveryOptions {
  stringsRef: RefObject<NewDocumentStrings>;
  setStatus: (message: string) => void;
  t: Translator['t'];
}

/** Restores crash snapshots exactly once during renderer startup. */
export function useRecovery({ stringsRef, setStatus, t }: RecoveryOptions): void {
  const store = useDocuments.getState;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const pending = await window.quantum.invoke('autosave:pending', undefined);
      if (cancelled) return;

      for (const record of pending) {
        const strings = stringsRef.current;
        if (!strings) continue;
        const id = store().restore(
          record.path,
          record.content,
          strings,
          record.eol,
          record.mtimeMs,
        );
        if (!record.path) continue;

        try {
          const appData = await window.quantum.invoke('appdata:read', { path: record.path });
          if (!cancelled && appData) store().setAppData(id, appData);
        } catch {
          if (!cancelled) setStatus(t('status.appDataFailed'));
        }
      }

      if (pending.length > 0) setStatus(t('status.recovered', { count: pending.length }));
      if (store().documents.length === 0 && stringsRef.current) {
        store().newDocument(stringsRef.current);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Recovery is a startup transaction. Locale changes must not replay snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
}
