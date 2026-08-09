import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { AppData, InconsistencyState, RewriteState } from '@shared/appdata/index.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Translator } from '@shared/i18n/index.js';
import { parse } from '@shared/fountain/index.js';
import type { CharacterNameSelection } from '../ai/CharacterNameDialog.js';
import type { RewriteSelection } from '../ai/RewriteDialog.js';
import {
  beginDocumentOperation,
  commitDocumentOperation,
  type DocumentOperationContext,
} from '@shared/documents/operations.js';
import { useDocuments } from '../store/documents.js';

/**
 * AI writing helpers that act on the live editor selection, plus the dialog openers
 * and appData persistence for findings panels.
 */
export function useAiEditorActions(
  editorView: RefObject<EditorView | null>,
  analysis: ParseResponse | null,
  selectEditorRange: (range: { from: number; to: number }) => void,
  t: Translator['t'],
  setStatus: (message: string) => void,
) {
  const store = useDocuments.getState;
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [inconsistencyOpen, setInconsistencyOpen] = useState(false);
  const [voiceConsistencyOpen, setVoiceConsistencyOpen] = useState(false);
  const [repetitionsOpen, setRepetitionsOpen] = useState(false);
  const [bibleOpen, setBibleOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfDate, setPdfDate] = useState('');
  const [, setAiSettingsRevision] = useState(0);
  const [rewriteSelection, setRewriteSelection] = useState<RewriteSelection | null>(null);
  const [characterNameSelection, setCharacterNameSelection] =
    useState<CharacterNameSelection | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(
    () =>
      useDocuments.subscribe((state, previous) => {
        if (state.activeId === previous.activeId) return;
        setPdfOpen(false);
        setSnapshotsOpen(false);
        setInconsistencyOpen(false);
        setVoiceConsistencyOpen(false);
        setRepetitionsOpen(false);
        setRewriteSelection((selection) =>
          selection?.operation.documentId === state.activeId ? selection : null,
        );
        setCharacterNameSelection((selection) =>
          selection?.operation.documentId === state.activeId ? selection : null,
        );
      }),
    [],
  );

  const openPdfDialog = useCallback(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    setPdfDate(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
    setPdfOpen(true);
  }, []);
  const openAiSettings = useCallback(() => setAiSettingsOpen(true), []);
  const openInconsistencies = useCallback(() => setInconsistencyOpen(true), []);
  const openVoiceConsistency = useCallback(() => setVoiceConsistencyOpen(true), []);
  const openRepetitions = useCallback(() => setRepetitionsOpen(true), []);
  const openBible = useCallback(() => setBibleOpen(true), []);
  const openSnapshots = useCallback(() => setSnapshotsOpen(true), []);
  const openCommandPalette = useCallback(() => setPaletteOpen(true), []);

  const openRewrite = useCallback(
    (initialTool: 'rewrite' | 'synonyms' = 'rewrite') => {
      const view = editorView.current;
      const current = store().active();
      if (!view || !current) return;
      const source = view.state.doc.toString();
      const currentAnalysis =
        analysis?.id === current.id && analysis.revision === current.revision
          ? analysis
          : parse(source);
      const selection = view.state.selection.main;
      if (selection.empty) {
        setStatus(t('rewrite.selectText'));
        return;
      }
      const element = currentAnalysis.elements.find(
        (candidate) =>
          selection.from >= candidate.range.from && selection.from <= candidate.range.to,
      );
      const scene = currentAnalysis.scenes.find(
        (candidate) =>
          selection.from >= candidate.range.from && selection.from <= candidate.range.to,
      );
      const coordinates = view.coordsAtPos(selection.from);
      setRewriteSelection({
        operation: beginDocumentOperation(current, 'rewrite-selection'),
        from: selection.from,
        to: selection.to,
        text: view.state.sliceDoc(selection.from, selection.to),
        elementKind: element?.kind ?? 'action',
        speaker: element?.speaker ?? null,
        sceneHeading: scene?.heading ?? null,
        sceneContext: scene
          ? source.slice(scene.range.from, scene.range.to)
          : source.slice(
              Math.max(0, selection.from - 1_000),
              Math.min(source.length, selection.to + 1_000),
            ),
        anchor: coordinates ? { x: coordinates.left, y: coordinates.bottom + 8 } : null,
        initialTool,
      });
    },
    [analysis, editorView, setStatus, store, t],
  );
  const openSynonyms = useCallback(() => openRewrite('synonyms'), [openRewrite]);
  const openRewriteSelection = useCallback(() => openRewrite('rewrite'), [openRewrite]);

  const openRenameCharacter = useCallback(() => {
    const view = editorView.current;
    const current = store().active();
    if (!view || !current) return;
    const source = view.state.doc.toString();
    const workerAnalysis =
      analysis?.id === current.id && analysis.revision === current.revision ? analysis : null;
    const parsed = workerAnalysis === null ? parse(source) : null;
    const elements = workerAnalysis?.elements ?? parsed?.elements ?? [];
    const scenes = workerAnalysis?.scenes ?? parsed?.scenes ?? [];
    const selection = view.state.selection.main;
    const offset = selection.from;
    const element = elements.find(
      (candidate) =>
        candidate.kind === 'character' &&
        offset >= candidate.range.from &&
        offset <= candidate.range.to,
    );
    if (!element?.character) {
      setStatus(t('characterName.selectCharacter'));
      return;
    }
    const scene = scenes.find(
      (candidate) => offset >= candidate.range.from && offset <= candidate.range.to,
    );
    const coordinates = view.coordsAtPos(offset);
    setCharacterNameSelection({
      operation: beginDocumentOperation(current, 'character-rename'),
      name: element.character,
      existingNames:
        workerAnalysis?.characters.map((character) => character.name) ??
        [...(parsed?.characters.values() ?? [])].map((character) => character.name),
      sceneContext: scene
        ? source.slice(scene.range.from, scene.range.to)
        : source.slice(Math.max(0, offset - 1_000), Math.min(source.length, offset + 1_000)),
      anchor: coordinates ? { x: coordinates.left, y: coordinates.bottom + 8 } : null,
    });
  }, [analysis, editorView, setStatus, store, t]);

  const updateDocumentAppData = useCallback(
    (documentId: string, update: (current: AppData) => AppData) => {
      const document = store().documents.find((candidate) => candidate.id === documentId);
      if (document) store().setAppData(documentId, update(document.appData), true);
    },
    [store],
  );
  const commitAppDataOperation = useCallback(
    (operation: DocumentOperationContext, update: (current: AppData) => AppData): boolean => {
      const status = commitDocumentOperation(store().documents, operation, (document) => {
        store().setAppData(document.id, update(document.appData), true);
      });
      if (status === 'current') return true;
      setStatus(t('operation.stale'));
      return false;
    },
    [setStatus, store, t],
  );
  const updateRewrite = useCallback(
    (documentId: string, rewrite: RewriteState) =>
      updateDocumentAppData(documentId, (data) => ({ ...data, rewrite })),
    [updateDocumentAppData],
  );
  const updateVoiceConsistency = useCallback(
    (documentId: string, characterName: string, state: InconsistencyState) =>
      updateDocumentAppData(documentId, (data) => ({
        ...data,
        voiceConsistency: { ...data.voiceConsistency, [characterName]: state },
      })),
    [updateDocumentAppData],
  );
  const updateRepetitions = useCallback(
    (documentId: string, repetitions: InconsistencyState) =>
      updateDocumentAppData(documentId, (data) => ({ ...data, repetitions })),
    [updateDocumentAppData],
  );
  const updateInconsistencies = useCallback(
    (documentId: string, inconsistencies: InconsistencyState) =>
      updateDocumentAppData(documentId, (data) => ({ ...data, inconsistencies })),
    [updateDocumentAppData],
  );
  const selectInconsistencyReference = useCallback(
    (reference: { sceneNumber: string; heading: string }) => {
      const view = editorView.current;
      const current = store().active();
      if (!view || !current) return;
      const currentAnalysis =
        analysis?.id === current.id && analysis.revision === current.revision
          ? analysis
          : parse(view.state.doc.toString());
      const scene = currentAnalysis.scenes.find(
        (candidate) =>
          candidate.number === reference.sceneNumber ||
          candidate.heading.toLocaleUpperCase() === reference.heading.toLocaleUpperCase(),
      );
      if (scene) selectEditorRange(scene.range);
    },
    [analysis, editorView, selectEditorRange, store],
  );
  const replaceEditorRange = useCallback(
    (selection: RewriteSelection, content: string): boolean => {
      const view = editorView.current;
      if (!view || store().activeId !== selection.operation.documentId) return false;
      const status = commitDocumentOperation(store().documents, selection.operation, () => {
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: content },
          selection: { anchor: selection.from + content.length },
          scrollIntoView: true,
        });
        view.focus();
      });
      if (status === 'current') return true;
      setStatus(t('operation.stale'));
      return false;
    },
    [editorView, setStatus, store, t],
  );
  const renameCharacter = useCallback(
    (selection: CharacterNameSelection, nextName: string): boolean => {
      const view = editorView.current;
      if (!view || store().activeId !== selection.operation.documentId) return false;
      let renamed = 0;
      const status = commitDocumentOperation(store().documents, selection.operation, () => {
        const elements = parse(view.state.doc.toString()).elements;
        const changes = elements.flatMap((element) => {
          if (element.kind !== 'character' || element.character !== selection.name) return [];
          const source = view.state.sliceDoc(element.range.from, element.range.to);
          const index = source.toLocaleUpperCase('fr-FR').indexOf(selection.name);
          return index < 0
            ? []
            : [
                {
                  from: element.range.from + index,
                  to: element.range.from + index + selection.name.length,
                  insert: nextName,
                },
              ];
        });
        if (changes.length === 0) return;
        renamed = changes.length;
        view.dispatch({ changes });
        view.focus();
      });
      if (status !== 'current') {
        setStatus(t('operation.stale'));
        return false;
      }
      if (renamed === 0) return false;
      setStatus(t('characterName.renamed', { count: renamed, name: nextName }));
      return true;
    },
    [editorView, setStatus, store, t],
  );
  const restoreSnapshot = useCallback(
    (operation: DocumentOperationContext, content: string): boolean => {
      const view = editorView.current;
      if (!view || store().activeId !== operation.documentId) return false;
      const status = commitDocumentOperation(store().documents, operation, () => {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          annotations: isolateHistory.of('full'),
        });
        view.focus();
      });
      if (status === 'current') return true;
      setStatus(t('operation.stale'));
      return false;
    },
    [editorView, setStatus, store, t],
  );

  const commitInconsistencies = useCallback(
    (operation: DocumentOperationContext, inconsistencies: InconsistencyState) =>
      commitAppDataOperation(operation, (data) => ({ ...data, inconsistencies })),
    [commitAppDataOperation],
  );
  const commitVoiceConsistency = useCallback(
    (operation: DocumentOperationContext, characterName: string, state: InconsistencyState) =>
      commitAppDataOperation(operation, (data) => ({
        ...data,
        voiceConsistency: { ...data.voiceConsistency, [characterName]: state },
      })),
    [commitAppDataOperation],
  );
  const commitRepetitions = useCallback(
    (operation: DocumentOperationContext, repetitions: InconsistencyState) =>
      commitAppDataOperation(operation, (data) => ({ ...data, repetitions })),
    [commitAppDataOperation],
  );

  return {
    aiSettingsOpen,
    setAiSettingsOpen,
    setAiSettingsRevision,
    inconsistencyOpen,
    setInconsistencyOpen,
    voiceConsistencyOpen,
    setVoiceConsistencyOpen,
    repetitionsOpen,
    setRepetitionsOpen,
    bibleOpen,
    setBibleOpen,
    snapshotsOpen,
    setSnapshotsOpen,
    pdfOpen,
    setPdfOpen,
    pdfDate,
    rewriteSelection,
    setRewriteSelection,
    characterNameSelection,
    setCharacterNameSelection,
    paletteOpen,
    setPaletteOpen,
    openPdfDialog,
    openAiSettings,
    openInconsistencies,
    openVoiceConsistency,
    openRepetitions,
    openBible,
    openSnapshots,
    openCommandPalette,
    openSynonyms,
    openRewriteSelection,
    openRenameCharacter,
    updateRewrite,
    updateVoiceConsistency,
    updateRepetitions,
    updateInconsistencies,
    selectInconsistencyReference,
    replaceEditorRange,
    renameCharacter,
    restoreSnapshot,
    commitInconsistencies,
    commitVoiceConsistency,
    commitRepetitions,
  };
}
