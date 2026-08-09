import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Translator } from '@shared/i18n/index.js';
import type { PendingWrites } from '@shared/persistence/PendingWrites.js';
import type { OpenDocument } from '../store/documents.js';
import { useDocuments } from '../store/documents.js';

interface AutosaveOptions {
  documents: OpenDocument[];
  autosaveSeconds: number;
  pendingWrites: PendingWrites;
  /** Called when a background write fails – displays an error without clearing dirty state. */
  setStatusError: (message: string) => void;
  t: Translator['t'];
}

interface PendingAppData {
  path: string;
  data: OpenDocument['appData'];
  revision: number;
  timer: number | null;
  inFlight: Promise<void> | null;
}

interface AcknowledgedAppData {
  path: string;
  revision: number;
}

/** Persists crash snapshots and per-document metadata without involving the app shell. */
export function useAutosave({
  documents,
  autosaveSeconds,
  pendingWrites,
  setStatusError,
  t,
}: AutosaveOptions): { flushCrashRecovery: () => Promise<void> } {
  const store = useDocuments.getState;
  const pendingAppData = useRef(new Map<string, PendingAppData>());
  const acknowledgedAppData = useRef(new Map<string, AcknowledgedAppData>());
  const reportAppDataFailure = useRef(() => setStatusError(t('status.appDataFailed')));
  const reportAutosaveFailure = useRef(() => setStatusError(t('status.autosaveFailed')));
  reportAppDataFailure.current = () => setStatusError(t('status.appDataFailed'));
  reportAutosaveFailure.current = () => setStatusError(t('status.autosaveFailed'));

  const appDataPersistence = useMemo(() => {
    const schedule = (id: string) => {
      const pending = pendingAppData.current.get(id);
      if (!pending || pending.timer !== null || pending.inFlight !== null) return;
      pending.timer = window.setTimeout(() => {
        pending.timer = null;
        void writeAppData(id).catch(() => reportAppDataFailure.current());
      }, 300);
    };

    const writeAppData = async (id: string): Promise<void> => {
      const pending = pendingAppData.current.get(id);
      if (!pending) return;
      if (pending.inFlight) return pending.inFlight;
      if (pending.timer !== null) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }

      const submitted = {
        path: pending.path,
        data: pending.data,
        revision: pending.revision,
      };
      const operation = window.quantum.invoke('appdata:write', {
        path: submitted.path,
        data: submitted.data,
      });
      pending.inFlight = operation;

      try {
        await operation;
        acknowledgedAppData.current.set(id, {
          path: submitted.path,
          revision: submitted.revision,
        });
        const current = pendingAppData.current.get(id);
        if (current && current.path === submitted.path && current.revision === submitted.revision) {
          pendingAppData.current.delete(id);
        }
      } finally {
        const current = pendingAppData.current.get(id);
        if (current) {
          current.inFlight = null;
          const acknowledged = acknowledgedAppData.current.get(id);
          if (
            acknowledged &&
            (acknowledged.path !== current.path || acknowledged.revision < current.revision)
          ) {
            schedule(id);
          }
        }
      }
    };

    const flush = async () => {
      for (;;) {
        const ids = [...pendingAppData.current.keys()];
        if (ids.length === 0) return;
        const outcomes = await Promise.allSettled(
          ids.map(async (id) => {
            const pending = pendingAppData.current.get(id);
            if (!pending) return;
            if (pending.timer !== null) {
              window.clearTimeout(pending.timer);
              pending.timer = null;
            }
            if (pending.inFlight) await pending.inFlight;
            if (pendingAppData.current.has(id)) await writeAppData(id);
          }),
        );
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, 'One or more appdata writes failed');
        }
      }
    };

    return { flush, schedule };
  }, []);

  useEffect(
    () => pendingWrites.register(appDataPersistence.flush),
    [appDataPersistence, pendingWrites],
  );

  useEffect(() => {
    for (const document of documents) {
      if (document.path === null || document.appDataRevision === 0) continue;
      const acknowledged = acknowledgedAppData.current.get(document.id);
      if (
        acknowledged?.path === document.path &&
        acknowledged.revision >= document.appDataRevision
      ) {
        continue;
      }

      const existing = pendingAppData.current.get(document.id);
      if (existing) {
        if (existing.path === document.path && existing.revision >= document.appDataRevision) {
          continue;
        }
        if (existing.timer !== null) window.clearTimeout(existing.timer);
        existing.path = document.path;
        existing.data = document.appData;
        existing.revision = document.appDataRevision;
        existing.timer = null;
      } else {
        pendingAppData.current.set(document.id, {
          path: document.path,
          data: document.appData,
          revision: document.appDataRevision,
          timer: null,
          inFlight: null,
        });
      }
      appDataPersistence.schedule(document.id);
    }
  }, [appDataPersistence, documents]);

  useEffect(
    () => () => {
      for (const pending of pendingAppData.current.values()) {
        if (pending.timer !== null) window.clearTimeout(pending.timer);
      }
    },
    [],
  );

  const flushCrashRecovery = useCallback(async () => {
    const dirtyDocuments = store().documents.filter((document) => document.dirty);
    const outcomes = await Promise.allSettled(
      dirtyDocuments.map((document) =>
        window.quantum.invoke('autosave:write', {
          id: document.id,
          path: document.path,
          content: document.content,
          eol: document.eol,
          mtimeMs: document.mtimeMs,
        }),
      ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more crash-recovery writes failed');
    }
  }, [store]);

  useEffect(() => {
    if (autosaveSeconds <= 0) return;
    const timer = window.setInterval(() => {
      void flushCrashRecovery().catch(() => reportAutosaveFailure.current());
    }, autosaveSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [autosaveSeconds, flushCrashRecovery]);

  return { flushCrashRecovery };
}
