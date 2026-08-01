import { useCallback, useState } from 'react';
import type { RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import type { AppData, InconsistencyState, RewriteState } from '@shared/appdata/index.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { CharacterNameSelection } from '../ai/CharacterNameDialog.js';
import type { RewriteSelection } from '../ai/RewriteDialog.js';
import { useDocuments } from '../store/documents.js';

/**
 * AI writing helpers that act on the live editor selection, plus the dialog openers
 * and appData persistence for findings panels.
 */
export function useAiEditorActions(
  editorView: RefObject<EditorView | null>,
  analysis: ParseResponse | null,
  updateAppData: (update: (current: AppData) => AppData) => void,
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
      if (!view || !current || !analysis) return;
      const selection = view.state.selection.main;
      if (selection.empty) {
        setStatus(t('rewrite.selectText'));
        return;
      }
      const element = analysis.elements.find(
        (candidate) =>
          selection.from >= candidate.range.from && selection.from <= candidate.range.to,
      );
      const scene = analysis.scenes.find(
        (candidate) =>
          selection.from >= candidate.range.from && selection.from <= candidate.range.to,
      );
      const coordinates = view.coordsAtPos(selection.from);
      setRewriteSelection({
        from: selection.from,
        to: selection.to,
        text: view.state.sliceDoc(selection.from, selection.to),
        elementKind: element?.kind ?? 'action',
        speaker: element?.speaker ?? null,
        sceneHeading: scene?.heading ?? null,
        sceneContext: scene
          ? current.content.slice(scene.range.from, scene.range.to)
          : current.content.slice(
              Math.max(0, selection.from - 1_000),
              Math.min(current.content.length, selection.to + 1_000),
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
    if (!view || !current || !analysis) return;
    const selection = view.state.selection.main;
    const offset = selection.from;
    const element = analysis.elements.find(
      (candidate) =>
        candidate.kind === 'character' &&
        offset >= candidate.range.from &&
        offset <= candidate.range.to,
    );
    if (!element?.character) {
      setStatus(t('characterName.selectCharacter'));
      return;
    }
    const scene = analysis.scenes.find(
      (candidate) => offset >= candidate.range.from && offset <= candidate.range.to,
    );
    const coordinates = view.coordsAtPos(offset);
    setCharacterNameSelection({
      name: element.character,
      existingNames: analysis.characters.map((character) => character.name),
      sceneContext: scene
        ? current.content.slice(scene.range.from, scene.range.to)
        : current.content.slice(
            Math.max(0, offset - 1_000),
            Math.min(current.content.length, offset + 1_000),
          ),
      anchor: coordinates ? { x: coordinates.left, y: coordinates.bottom + 8 } : null,
    });
  }, [analysis, editorView, setStatus, store, t]);

  const updateRewrite = useCallback(
    (rewrite: RewriteState) => updateAppData((data) => ({ ...data, rewrite })),
    [updateAppData],
  );
  const updateVoiceConsistency = useCallback(
    (characterName: string, state: InconsistencyState) =>
      updateAppData((data) => ({
        ...data,
        voiceConsistency: { ...data.voiceConsistency, [characterName]: state },
      })),
    [updateAppData],
  );
  const updateRepetitions = useCallback(
    (repetitions: InconsistencyState) => updateAppData((data) => ({ ...data, repetitions })),
    [updateAppData],
  );
  const updateInconsistencies = useCallback(
    (inconsistencies: InconsistencyState) =>
      updateAppData((data) => ({ ...data, inconsistencies })),
    [updateAppData],
  );
  const selectInconsistencyReference = useCallback(
    (reference: { sceneNumber: string; heading: string }) => {
      const scene = analysis?.scenes.find(
        (candidate) =>
          candidate.number === reference.sceneNumber ||
          candidate.heading.toLocaleUpperCase() === reference.heading.toLocaleUpperCase(),
      );
      if (scene) selectEditorRange(scene.range);
    },
    [analysis, selectEditorRange],
  );
  const replaceEditorRange = useCallback(
    (from: number, to: number, content: string) => {
      const view = editorView.current;
      if (!view) return;
      view.dispatch({
        changes: { from, to, insert: content },
        selection: { anchor: from + content.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    [editorView],
  );
  const renameCharacter = useCallback(
    (nextName: string) => {
      const view = editorView.current;
      const currentName = characterNameSelection?.name;
      if (!view || !analysis || !currentName) return;
      const changes = analysis.elements.flatMap((element) => {
        if (element.kind !== 'character' || element.character !== currentName) return [];
        const source = view.state.sliceDoc(element.range.from, element.range.to);
        const index = source.toLocaleUpperCase('fr-FR').indexOf(currentName);
        return index < 0
          ? []
          : [
              {
                from: element.range.from + index,
                to: element.range.from + index + currentName.length,
                insert: nextName,
              },
            ];
      });
      if (changes.length === 0) return;
      view.dispatch({ changes });
      view.focus();
      setStatus(t('characterName.renamed', { count: changes.length, name: nextName }));
    },
    [analysis, characterNameSelection?.name, editorView, setStatus, t],
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
  };
}
