import { useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { AppData } from '@shared/appdata/index.js';
import { parse } from '@shared/fountain/index.js';
import type { Translator } from '@shared/i18n/index.js';
import { nextRevisionColour, planSceneNumbering } from '@shared/revision/index.js';
import { fountainLexField } from '../editor/fountain-highlight.js';
import {
  beginDocumentOperation,
  commitDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import { useDocuments } from '../store/documents.js';

/**
 * Production revision commands: lock, letter new scenes, issue a colour, unlock.
 */
export function useRevisionActions(
  editorView: RefObject<EditorView | null>,
  locked: boolean,
  updateAppData: (update: (current: AppData) => AppData) => void,
  t: Translator['t'],
  setStatus: (message: string) => void,
  setStatusError: (message: string) => void,
) {
  const store = useDocuments.getState;
  const latestByDocument = useRef(new Map<string, string>());

  const beginRevisionOperation = useCallback(
    (documentId: string, prefix: string): DocumentOperationContext | null => {
      const document = store().documents.find((candidate) => candidate.id === documentId);
      if (!document) return null;
      const operation = beginDocumentOperation(document, prefix);
      latestByDocument.current.set(documentId, operation.requestId);
      return operation;
    },
    [store],
  );

  const commitRevisionOperation = useCallback(
    (operation: DocumentOperationContext, update: (current: AppData) => AppData): boolean => {
      const status = commitDocumentOperation(
        store().documents,
        operation,
        (document) => store().setAppData(document.id, update(document.appData), true),
        latestByDocument.current.get(operation.documentId),
      );
      if (status === 'current') return true;
      setStatus(t('operation.stale'));
      return false;
    },
    [setStatus, store, t],
  );

  const snapshotReference = useCallback(async (path: string, name: string, content: string) => {
    const before = await window.quantum.invoke('snapshot:list', { path });
    if (before.status !== 'ok') {
      throw new Error('indexDamaged');
    }
    const after = await window.quantum.invoke('snapshot:create', { path, name, content });
    return (
      after.find((meta) => !before.snapshots.some((previous) => previous.id === meta.id)) ?? null
    );
  }, []);

  const numberScenes = useCallback(() => {
    const view = editorView.current;
    if (!view) return;
    const source = view.state.doc.toString();
    const mode = locked ? 'letters' : 'lock';
    const edits = planSceneNumbering(source, parse(source).scenes, mode);
    if (edits.length > 0) {
      view.dispatch({ changes: edits, annotations: isolateHistory.of('full') });
    }
    view.focus();
    setStatus(
      locked
        ? t('revision.lettered', { count: edits.length })
        : t('status.scenesRenumbered', { count: parse(source).scenes.length }),
    );
  }, [editorView, locked, setStatus, t]);

  const removeSceneNumbers = useCallback(() => {
    const view = editorView.current;
    if (!view) return;
    const changes = view.state.field(fountainLexField).lines.flatMap((heading) => {
      if (heading.kind !== 'scene_heading') return [];
      const source = view.state.sliceDoc(heading.from, heading.to);
      const unnumbered = source.replace(/\s+#[^#\r\n]+#(\s*)$/, '$1');
      return unnumbered === source
        ? []
        : [{ from: heading.from, to: heading.to, insert: unnumbered }];
    });
    if (changes.length > 0) {
      view.dispatch({ changes, annotations: isolateHistory.of('full') });
    }
    view.focus();
    setStatus(t('status.sceneNumbersRemoved', { count: changes.length }));
  }, [editorView, setStatus, t]);

  const lockForProduction = useCallback(async () => {
    const view = editorView.current;
    const current = store().active();
    if (!view || !current) return;
    if (current.path === null) {
      setStatus(t('revision.saveFirst'));
      return;
    }

    const source = view.state.doc.toString();
    const scenes = parse(source).scenes;
    const edits = planSceneNumbering(source, scenes, 'lock');
    if (edits.length > 0) {
      view.dispatch({ changes: edits, annotations: isolateHistory.of('full') });
    }
    const numbered = view.state.doc.toString();
    const operation = beginRevisionOperation(current.id, 'revision-lock');
    if (!operation) return;

    try {
      const created = await snapshotReference(current.path, t('revision.lockName'), numbered);
      if (!created) return;
      if (
        !commitRevisionOperation(operation, (data) => ({
          ...data,
          revision: { snapshotId: created.id, lockedAt: created.createdAt, colour: 'blue' },
        }))
      )
        return;
      setStatus(t('revision.locked', { count: scenes.length, colour: t('revision.colour.blue') }));
    } catch (error) {
      setStatusError(t('revision.failed', { error: error instanceof Error ? error.message : '' }));
    }
  }, [
    beginRevisionOperation,
    commitRevisionOperation,
    editorView,
    setStatus,
    setStatusError,
    snapshotReference,
    store,
    t,
  ]);

  const issueRevision = useCallback(async () => {
    const view = editorView.current;
    const current = store().active();
    if (!view || !current) return;
    if (current.path === null || current.appData.revision.snapshotId === null) {
      setStatus(t('revision.notLocked'));
      return;
    }

    const source = view.state.doc.toString();
    const edits = planSceneNumbering(source, parse(source).scenes, 'letters');
    if (edits.length > 0) {
      view.dispatch({ changes: edits, annotations: isolateHistory.of('full') });
    }
    const issued = view.state.doc.toString();
    const colour = current.appData.revision.colour;
    const operation = beginRevisionOperation(current.id, 'revision-issue');
    if (!operation) return;

    try {
      const created = await snapshotReference(
        current.path,
        t('revision.issueName', { colour: t(`revision.colour.${colour}`) }),
        issued,
      );
      if (!created) return;
      const next = nextRevisionColour(colour);
      if (
        !commitRevisionOperation(operation, (data) => ({
          ...data,
          revision: { snapshotId: created.id, lockedAt: created.createdAt, colour: next },
        }))
      )
        return;
      setStatus(
        t('revision.issued', {
          colour: t(`revision.colour.${colour}`),
          next: t(`revision.colour.${next}`),
        }),
      );
    } catch (error) {
      setStatusError(t('revision.failed', { error: error instanceof Error ? error.message : '' }));
    }
  }, [
    beginRevisionOperation,
    commitRevisionOperation,
    editorView,
    setStatus,
    setStatusError,
    snapshotReference,
    store,
    t,
  ]);

  const unlockProduction = useCallback(() => {
    updateAppData((data) => ({
      ...data,
      revision: { ...data.revision, snapshotId: null, lockedAt: null },
    }));
    setStatus(t('revision.unlocked'));
  }, [setStatus, t, updateAppData]);

  return {
    numberScenes,
    removeSceneNumbers,
    lockForProduction,
    issueRevision,
    unlockProduction,
  };
}
