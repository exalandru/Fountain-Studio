import { useEffect } from 'react';
import type { RefObject } from 'react';
import { sharedDocumentPathCoordinator } from '@shared/documents/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { NewDocumentStrings } from '../store/documents.js';
import { useDocuments } from '../store/documents.js';

interface RecoveryOptions {
  stringsRef: RefObject<NewDocumentStrings>;
  /** Informational messages such as “recovered”. */
  setStatus: (message: string) => void;
  /** Error messages, displayed with the warning style. */
  setStatusError: (message: string) => void;
  t: Translator['t'];
}

/** Restores crash snapshots exactly once during renderer startup. */
export function useRecovery({ stringsRef, setStatus, setStatusError, t }: RecoveryOptions): void {
  const store = useDocuments.getState;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const pending = await window.quantum.invoke('autosave:pending', undefined);
      if (cancelled) return;

      let recovered = 0;
      for (const record of pending) {
        const strings = stringsRef.current;
        if (!strings) continue;

        const restoreOne = async () => {
          const before = store().documents.length;
          const id = store().restore(
            record.path,
            record.content,
            strings,
            record.eol,
            record.mtimeMs,
            record.id,
          );
          // An already-open path focuses the existing tab; that is not a recovery.
          if (store().documents.length === before) return null;
          recovered += 1;

          if (!record.path) return id;

          try {
            const appData = await window.quantum.invoke('appdata:read', { path: record.path });
            const current = store().documents.find((document) => document.id === id);
            if (
              !cancelled &&
              appData &&
              current?.path === record.path &&
              current.appDataRevision === 0
            ) {
              store().setAppData(id, appData);
            }
          } catch {
            if (!cancelled) setStatusError(t('status.appDataFailed'));
          }
          return id;
        };

        if (record.path) {
          await sharedDocumentPathCoordinator(window.quantum.platform).runExclusive(
            record.path,
            restoreOne,
          );
        } else {
          await restoreOne();
        }
      }

      if (recovered > 0) setStatus(t('status.recovered', { count: recovered }));
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
