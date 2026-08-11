import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import {
  documentPathsEqual,
  findDocumentByPath,
  sharedDocumentPathCoordinator,
} from '@shared/documents/index.js';
import type { Locale, Translator } from '@shared/i18n/index.js';
import type { DocumentSnapshot } from '@shared/ipc-contract.js';
import type { PendingWrites } from '@shared/persistence/PendingWrites.js';
import type { NewDocumentStrings } from '../store/documents.js';
import { saveFingerprintCommit, useDocuments } from '../store/documents.js';

interface DocumentIOOptions {
  locale: Locale;
  t: Translator['t'];
  stringsRef: RefObject<NewDocumentStrings>;
  /** Informational messages such as “saved”. */
  setStatus: (message: string) => void;
  /** Error messages that should appear with the warning style. */
  setStatusError: (message: string) => void;
  pendingWrites: PendingWrites;
}

function createBarrier(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  pendingWrites,
}: DocumentIOOptions) {
  const store = useDocuments.getState;
  const saving = useRef(new Set<string>());
  const saveAsTransactions = useRef(new Set<Promise<unknown>>());
  const pathCoordinator = useRef(sharedDocumentPathCoordinator(window.quantum.platform));

  const flushSaveAsTransactions = useCallback(async () => {
    const transactions = [...saveAsTransactions.current];
    if (transactions.length > 0) await Promise.all(transactions);
  }, []);

  useEffect(
    () => pendingWrites.register(flushSaveAsTransactions),
    [flushSaveAsTransactions, pendingWrites],
  );

  const adoptSnapshots = useCallback(
    async (snapshots: DocumentSnapshot[]) => {
      const platform = window.quantum.platform;
      const alreadyOpen = new Set(
        store()
          .documents.map((document) => document.path)
          .filter((path): path is string => path !== null),
      );

      for (const snapshot of snapshots) {
        if (!snapshot.path) continue;

        await pathCoordinator.current.runExclusive(snapshot.path, async () => {
          const existing = findDocumentByPath(store().documents, snapshot.path!, platform);
          if (existing) {
            store().setActive(existing.id);
            return;
          }

          store().adopt([snapshot]);
          const target = findDocumentByPath(store().documents, snapshot.path!, platform);
          if (!target) return;

          const wasAlreadyOpen = [...alreadyOpen].some((path) =>
            documentPathsEqual(path, snapshot.path!, platform),
          );
          if (wasAlreadyOpen) return;

          alreadyOpen.add(target.path!);
          try {
            const appData = await window.quantum.invoke('appdata:read', { path: snapshot.path! });
            const current = store().documents.find((document) => document.id === target.id);
            if (
              appData &&
              current?.path !== null &&
              current?.path !== undefined &&
              documentPathsEqual(current.path, snapshot.path!, platform) &&
              current.appDataRevision === target.appDataRevision
            ) {
              store().setAppData(target.id, appData);
            }
          } catch {
            setStatusError(t('status.appDataFailed'));
          }
        });
      }
    },
    [setStatusError, store, t],
  );

  const reportSaveConflict = useCallback(
    (reason: 'changed-externally' | 'missing' | 'unstable' | 'mtime' | undefined) => {
      switch (reason) {
        case 'missing':
          setStatus(t('status.conflictMissing'));
          break;
        case 'unstable':
          setStatus(t('status.conflictUnstable'));
          break;
        case 'mtime':
          // Legacy fallback reached its own mismatch: keep the historical message.
          setStatus(t('status.conflict'));
          break;
        default:
          // 'changed-externally' means the fingerprint no longer matches.
          setStatus(t('status.conflictChanged'));
      }
    },
    [setStatus, t],
  );

  const save = useCallback(
    async (options: { forceDialog: boolean }): Promise<boolean> => {
      const current = store().active();
      if (!current || saving.current.has(current.id)) return false;

      saving.current.add(current.id);
      const saveAsSession: {
        barrier: Promise<void> | null;
        release: (() => void) | null;
      } = { barrier: null, release: null };
      try {
        let path = current.path;
        let pickedDestination = false;
        if (path === null || options.forceDialog) {
          path = await window.quantum.invoke('dialog:pickSaveAs', {
            suggestedName: current.path ?? `${current.name.replace(/\.fountain$/, '')}.fountain`,
          });
          if (path === null) return false;
          pickedDestination = true;
        }

        if (pickedDestination) {
          return await pathCoordinator.current.runExclusive(path, async () => {
            const platform = window.quantum.platform;
            const owner = findDocumentByPath(store().documents, path!, platform);
            if (owner && owner.id !== current.id) {
              setStatusError(t('status.pathAlreadyOpen'));
              return false;
            }

            const barrier = createBarrier();
            saveAsSession.barrier = barrier.promise;
            saveAsSession.release = barrier.release;
            saveAsTransactions.current.add(barrier.promise);
            try {
              await pendingWrites.flush(flushSaveAsTransactions);
            } catch (error) {
              setStatusError(
                t('status.saveFailed', {
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
              return false;
            }

            const fresh = store().documents.find((document) => document.id === current.id);
            if (!fresh) return false;

            // Re-check after the flush await: another tab must still not own the destination.
            const ownerAfterFlush = findDocumentByPath(store().documents, path!, platform);
            if (ownerAfterFlush && ownerAfterFlush.id !== current.id) {
              setStatusError(t('status.pathAlreadyOpen'));
              return false;
            }

            const outcome = await window.quantum.invoke('file:saveAsBundle', {
              sourcePath: fresh.path,
              destinationPath: path!,
              content: fresh.content,
              eol: fresh.eol,
              expectedMtimeMs: fresh.mtimeMs,
              expectedHash: fresh.fileHash,
              appData: fresh.appData,
            });

            if (outcome.status === 'saved') {
              const commit = saveFingerprintCommit(outcome, current.id, fresh.revision);
              if (commit) {
                store().markSaved(
                  commit.id,
                  commit.path,
                  commit.mtimeMs,
                  commit.savedRevision,
                  commit.fileHash,
                );
              }
              const savedDocument = store().documents.find(
                (document) => document.id === current.id,
              );
              const pathBound =
                savedDocument?.path !== null &&
                savedDocument?.path !== undefined &&
                documentPathsEqual(savedDocument.path, outcome.path, platform);
              if (!pathBound) {
                setStatusError(t('status.pathAlreadyOpen'));
                return false;
              }
              if (!savedDocument.dirty) {
                void window.quantum.invoke('autosave:clear', { id: current.id });
              } else {
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
              return !savedDocument.dirty;
            }

            if (outcome.status === 'conflict') {
              reportSaveConflict(outcome.reason);
            } else if (outcome.status === 'error') {
              setStatusError(t('status.saveFailed', { error: outcome.message }));
            }
            return false;
          });
        }

        const fresh = store().documents.find((document) => document.id === current.id) ?? current;
        const outcome = await window.quantum.invoke('file:save', {
          path: path!,
          content: fresh.content,
          eol: fresh.eol,
          expectedMtimeMs: fresh.mtimeMs,
          expectedHash: fresh.fileHash,
          refuseExisting: fresh.refuseExistingOnSave,
        });

        if (outcome.status === 'saved') {
          const commit = saveFingerprintCommit(outcome, current.id, fresh.revision);
          if (commit) {
            const fullySaved = store().markSaved(
              commit.id,
              commit.path,
              commit.mtimeMs,
              commit.savedRevision,
              commit.fileHash,
            );
            const savedDocument = store().documents.find((document) => document.id === current.id);
            if (savedDocument && savedDocument.appDataRevision > 0) {
              await window.quantum.invoke('appdata:write', {
                path: commit.path,
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
        }

        if (outcome.status === 'conflict') {
          reportSaveConflict(outcome.reason);
        } else if (outcome.status === 'error') {
          setStatusError(t('status.saveFailed', { error: outcome.message }));
        }
        return false;
      } finally {
        saveAsSession.release?.();
        if (saveAsSession.barrier) saveAsTransactions.current.delete(saveAsSession.barrier);
        saving.current.delete(current.id);
      }
    },
    [
      flushSaveAsTransactions,
      locale,
      pendingWrites,
      reportSaveConflict,
      setStatus,
      setStatusError,
      store,
      t,
    ],
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

  const openDropped = useCallback(
    async (paths: string[]) => {
      const snapshots = await window.quantum.invoke('file:openDropped', { paths });
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
      if (target.path) {
        void window.quantum.invoke('document:release', { path: target.path });
      }
      store().close(id);
      if (store().documents.length === 0 && stringsRef.current) {
        store().newDocument(stringsRef.current);
      }
    },
    [save, store, stringsRef],
  );

  return { closeTab, openDialog, openDropped, openPaths, save };
}
