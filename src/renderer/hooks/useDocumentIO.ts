import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Locale, Translator } from '@shared/i18n/index.js';
import type { DocumentSnapshot } from '@shared/ipc-contract.js';
import type { NewDocumentStrings } from '../store/documents.js';
import { useDocuments } from '../store/documents.js';

interface DocumentIOOptions {
  locale: Locale;
  t: Translator['t'];
  stringsRef: RefObject<NewDocumentStrings>;
  /** Informational messages such as “saved”. */
  setStatus: (message: string) => void;
  /** Error messages that should appear with the warning style. */
  setStatusError: (message: string) => void;
}

/**
 * Owns the open/save/close lifecycle for document tabs.
 *
 * Keeping disk commands out of the application shell makes their concurrency and
 * revision invariants independently understandable before later milestones add more
 * workspace panels.
 */
export function useDocumentIO({
  locale,
  t,
  stringsRef,
  setStatus,
  setStatusError,
}: DocumentIOOptions) {
  const store = useDocuments.getState;
  const saving = useRef(new Set<string>());

  const adoptSnapshots = useCallback(
    async (snapshots: DocumentSnapshot[]) => {
      const alreadyOpen = new Set(
        store()
          .documents.map((document) => document.path)
          .filter((path): path is string => path !== null),
      );
      store().adopt(snapshots);
      const openDocuments = store().documents;

      await Promise.all(
        snapshots.map(async (snapshot) => {
          if (!snapshot.path || alreadyOpen.has(snapshot.path)) return;
          const target = openDocuments.find((document) => document.path === snapshot.path);
          if (!target) return;
          try {
            const appData = await window.quantum.invoke('appdata:read', { path: snapshot.path });
            if (appData) store().setAppData(target.id, appData);
          } catch {
            setStatusError(t('status.appDataFailed'));
          }
        }),
      );
    },
    [setStatusError, store, t],
  );

  const save = useCallback(
    async (options: { forceDialog: boolean }): Promise<boolean> => {
      const current = store().active();
      if (!current || saving.current.has(current.id)) return false;

      saving.current.add(current.id);
      try {
        let path = current.path;
        if (path === null || options.forceDialog) {
          path = await window.quantum.invoke('dialog:pickSaveAs', {
            suggestedName: current.path ?? `${current.name.replace(/\.fountain$/, '')}.fountain`,
          });
          if (path === null) return false;
        }

        const fresh = store().documents.find((document) => document.id === current.id) ?? current;
        const outcome = await window.quantum.invoke('file:save', {
          path,
          content: fresh.content,
          eol: fresh.eol,
          expectedMtimeMs: options.forceDialog || fresh.path !== path ? null : fresh.mtimeMs,
          refuseExisting: !options.forceDialog && fresh.path === path && fresh.refuseExistingOnSave,
        });

        if (outcome.status === 'saved') {
          const fullySaved = store().markSaved(
            current.id,
            outcome.path,
            outcome.mtimeMs,
            fresh.revision,
          );
          const savedDocument = store().documents.find((document) => document.id === current.id);
          if (savedDocument && savedDocument.appDataRevision > 0) {
            await window.quantum.invoke('appdata:write', {
              path: outcome.path,
              data: savedDocument.appData,
            });
          }
          if (fullySaved) {
            void window.quantum.invoke('autosave:clear', { id: current.id });
          } else if (savedDocument) {
            void window.quantum.invoke('autosave:write', {
              id: savedDocument.id,
              path: savedDocument.path,
              content: savedDocument.content,
              eol: savedDocument.eol,
              mtimeMs: savedDocument.mtimeMs,
            });
          }
          setStatus(
            t('status.saved', {
              time: new Date().toLocaleTimeString(locale),
            }),
          );
          return fullySaved;
        }

        if (outcome.status === 'conflict') {
          setStatus(t('status.conflict'));
        } else if (outcome.status === 'error') {
          setStatusError(t('status.saveFailed', { error: outcome.message }));
        }
        return false;
      } finally {
        saving.current.delete(current.id);
      }
    },
    [locale, setStatus, setStatusError, store, t],
  );

  const openDialog = useCallback(async () => {
    const snapshots = await window.quantum.invoke('dialog:pickOpen', undefined);
    await adoptSnapshots(snapshots);
  }, [adoptSnapshots]);

  const openPaths = useCallback(
    async (paths: string[]) => {
      const snapshots = await window.quantum.invoke('file:openPaths', { paths });
      await adoptSnapshots(snapshots);
    },
    [adoptSnapshots],
  );

  useEffect(
    () =>
      window.quantum.on('app:openFiles', (payload) => {
        if (payload.snapshots) void adoptSnapshots(payload.snapshots);
        else if (payload.paths) void openPaths(payload.paths);
      }),
    [adoptSnapshots, openPaths],
  );

  const closeTab = useCallback(
    async (id: string) => {
      const target = store().documents.find((document) => document.id === id);
      if (!target) return;

      if (target.dirty) {
        const answer = await window.quantum.invoke('dialog:confirmDiscard', { name: target.name });
        if (answer === 'cancel') return;
        if (answer === 'save') {
          store().setActive(id);
          if (!(await save({ forceDialog: false }))) return;
        }
      }

      void window.quantum.invoke('autosave:clear', { id });
      store().close(id);
      if (store().documents.length === 0 && stringsRef.current) {
        store().newDocument(stringsRef.current);
      }
    },
    [save, store, stringsRef],
  );

  return { closeTab, openDialog, openPaths, save };
}
