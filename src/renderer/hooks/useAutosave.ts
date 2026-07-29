import { useEffect } from 'react';
import type { Translator } from '@shared/i18n/index.js';
import type { AppData } from '@shared/appdata/index.js';
import { useDocuments } from '../store/documents.js';

interface AutosaveOptions {
  activePath: string | null;
  activeAppData: AppData | null;
  activeAppDataRevision: number;
  autosaveSeconds: number;
  setStatus: (message: string) => void;
  t: Translator['t'];
}

/** Persists crash snapshots and per-document layout without involving the app shell. */
export function useAutosave({
  activePath,
  activeAppData,
  activeAppDataRevision,
  autosaveSeconds,
  setStatus,
  t,
}: AutosaveOptions): void {
  const store = useDocuments.getState;

  useEffect(() => {
    if (!activePath || !activeAppData || activeAppDataRevision === 0) return;
    const timer = setTimeout(() => {
      void window.quantum
        .invoke('appdata:write', { path: activePath, data: activeAppData })
        .catch(() => setStatus(t('status.appDataFailed')));
    }, 300);
    return () => clearTimeout(timer);
  }, [activeAppData, activeAppDataRevision, activePath, setStatus, t]);

  useEffect(() => {
    if (autosaveSeconds <= 0) return;

    const timer = setInterval(() => {
      for (const document of store().documents) {
        if (!document.dirty) continue;
        void window.quantum.invoke('autosave:write', {
          id: document.id,
          path: document.path,
          content: document.content,
          eol: document.eol,
          mtimeMs: document.mtimeMs,
        });
      }
    }, autosaveSeconds * 1000);

    return () => clearInterval(timer);
  }, [autosaveSeconds, store]);
}
