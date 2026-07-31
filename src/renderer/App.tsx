import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type {
  AppData,
  InconsistencyState,
  RewriteState,
  RightPanelTab,
  SidebarTab,
  TimelineState,
} from '@shared/appdata/index.js';
import type { AppSettings } from '@shared/ipc-contract.js';
import { statisticsToCsv, statisticsToJson } from '@shared/stats/index.js';
import { useAutosave } from './hooks/useAutosave.js';
import { useDocumentIO } from './hooks/useDocumentIO.js';
import { useFileCommands } from './hooks/useFileCommands.js';
import { useRecovery } from './hooks/useRecovery.js';
import { useScreenplay } from './hooks/useScreenplay.js';
import { useTranslator } from './hooks/useTranslator.js';
import { PdfExportDialog } from './pdf/PdfExportDialog.js';
import { AiSettingsDialog } from './ai/AiSettingsDialog.js';
import { SnapshotDialog } from './snapshots/SnapshotDialog.js';
import { RewriteDialog } from './ai/RewriteDialog.js';
import type { RewriteSelection } from './ai/RewriteDialog.js';
import { CharacterNameDialog } from './ai/CharacterNameDialog.js';
import type { CharacterNameSelection } from './ai/CharacterNameDialog.js';
import { InconsistencyPanel } from './ai/InconsistencyPanel.js';
import { VoiceConsistencyPanel } from './ai/VoiceConsistencyPanel.js';
import { RepetitionPanel } from './repetition/RepetitionPanel.js';
import { BiblePanel } from './bible/BiblePanel.js';
import { fountainLexField } from './editor/fountain-highlight.js';
import type { NewDocumentStrings } from './store/documents.js';
import { useDocuments } from './store/documents.js';
import { CommandPalette } from './ui/CommandPalette.js';
import type { PaletteCommand } from './ui/CommandPalette.js';
import { EditorContextMenu } from './ui/EditorContextMenu.js';
import { Workspace } from './workspace/Workspace.js';

/**
 * Application shell: tabs, editor, live preview, AST sidebar and status bar.
 */
export function App() {
  const documents = useDocuments((state) => state.documents);
  const activeId = useDocuments((state) => state.activeId);
  const settings = useDocuments((state) => state.settings);
  const store = useDocuments.getState;
  const { t, locale } = useTranslator();

  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [status, setStatus] = useState<string | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [inconsistencyOpen, setInconsistencyOpen] = useState(false);



  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [voiceConsistencyOpen, setVoiceConsistencyOpen] = useState(false);
  const [repetitionsOpen, setRepetitionsOpen] = useState(false);
  const [bibleOpen, setBibleOpen] = useState(false);
  const [, setAiSettingsRevision] = useState(0);
  const [rewriteSelection, setRewriteSelection] = useState<RewriteSelection | null>(null);
  const [characterNameSelection, setCharacterNameSelection] =
    useState<CharacterNameSelection | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });
  const [editorSelection, setEditorSelection] = useState<{
    documentId: string | null;
    from: number;
    to: number;
  }>({ documentId: null, from: 0, to: 0 });
  const [editorScrollPosition, setEditorScrollPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });
  const [previewScrollPosition, setPreviewScrollPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });
  const editorView = useRef<EditorView | null>(null);
  const closing = useRef(false);

  const active = documents.find((d) => d.id === activeId) ?? null;
  const anyDirty = documents.some((document) => document.dirty);
  const activeName = active?.name ?? null;
  const analysis = useScreenplay(
    active?.id ?? null,
    active?.content ?? '',
    active?.revision ?? 0,
    settings.minutesPerPage,
  );

  const effectiveDark = settings.theme === 'dark' || (settings.theme === 'system' && dark);
  const cursorOffset = cursorPosition.documentId === activeId ? cursorPosition.offset : 0;
  const activeSceneId =
    analysis?.scenes.find(
      (scene) => cursorOffset >= scene.range.from && cursorOffset <= scene.range.to,
    )?.id ?? null;
  const formattingActive = useMemo(() => {
    const range =
      editorSelection.documentId === activeId
        ? editorSelection
        : { documentId: activeId, from: cursorOffset, to: cursorOffset };
    const spans =
      analysis?.elements.flatMap((element) =>
        element.inline.filter((span) =>
          range.from === range.to
            ? range.from >= span.from && range.from <= span.to
            : span.from <= range.from && span.to >= range.to,
        ),
      ) ?? [];
    return {
      bold: spans.some((span) => span.bold),
      italic: spans.some((span) => span.italic),
      underline: spans.some((span) => span.underline),
    };
  }, [activeId, analysis?.elements, cursorOffset, editorSelection]);

  const updateAppData = useCallback(
    (update: (current: AppData) => AppData) => {
      const current = store().active();
      if (!current) return;
      store().setAppData(current.id, update(current.appData), true);
    },
    [store],
  );

  /**
   * Localised strings the store needs. Kept here because the store must not depend on
   * the translator: it holds data, not presentation.
   */
  const documentStrings = useMemo<NewDocumentStrings>(
    () => ({
      untitled: t('document.untitled'),
      titleValue: t('template.titleValue'),
      creditValue: t('template.creditValue'),
      recovered: t('document.recovered'),
    }),
    [t],
  );
  // Read inside callbacks that must not be re-created on every language change.
  const stringsRef = useRef(documentStrings);
  useEffect(() => {
    stringsRef.current = documentStrings;
  }, [documentStrings]);
  const { closeTab, openDialog, openPaths, save } = useDocumentIO({
    locale,
    t,
    stringsRef,
    setStatus,
  });
  const openPdfDialog = useCallback(() => setPdfOpen(true), []);
  const openAiSettings = useCallback(() => setAiSettingsOpen(true), []);
  const openInconsistencies = useCallback(() => setInconsistencyOpen(true), []);
  const openVoiceConsistency = useCallback(() => setVoiceConsistencyOpen(true), []);
  const openRepetitions = useCallback(() => setRepetitionsOpen(true), []);
  const openBible = useCallback(() => setBibleOpen(true), []);
  const openSnapshots = useCallback(() => setSnapshotsOpen(true), []);
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
    [analysis, store, t],
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
  }, [analysis, store, t]);

  // ── Settings and theme ─────────────────────────────────────────────────────
  useEffect(() => {
    void window.quantum.invoke('settings:get', undefined).then(store().setSettings);
    const offTheme = window.quantum.on('app:themeChanged', ({ dark: isDark }) => setDark(isDark));
    // The language can also be changed from the native menu, in the main process.
    const offSettings = window.quantum.on('app:settingsChanged', ({ settings: next }) =>
      store().setSettings(next),
    );
    return () => {
      offTheme();
      offSettings();
    };
  }, [store]);

  useEffect(() => {
    document.body.dataset['theme'] = effectiveDark ? 'dark' : 'light';
  }, [effectiveDark]);

  // The document language drives hyphenation and, more importantly, which dictionary
  // Chromium uses to spell-check the editor's contenteditable.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // The updated state comes back through `app:settingsChanged`, subscribed to above:
  // one single path, whether the change came from here or from the native menu.
  const patchSettings = useCallback(async (patch: Partial<AppSettings>) => {
    await window.quantum.invoke('settings:patch', patch);
  }, []);

  useRecovery({ stringsRef, setStatus, t });

  // ── Window title ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeName) return;
    void window.quantum.invoke('window:setDirty', {
      dirty: anyDirty,
      name: activeName,
    });
  }, [activeName, anyDirty]);

  // ── Closing the native window, guarding every dirty tab ───────────────────
  useEffect(() => {
    return window.quantum.on('app:willQuit', () => {
      if (closing.current) return;
      closing.current = true;

      void (async () => {
        let proceed = false;
        try {
          // A close signal can arrive before the periodic autosave. Snapshot everything
          // first so even a crash while a native confirmation is open remains recoverable.
          const dirtyDocuments = store().documents.filter((document) => document.dirty);
          await Promise.all(
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

          proceed = true;
          for (const snapshot of dirtyDocuments) {
            const current = store().documents.find((document) => document.id === snapshot.id);
            if (!current?.dirty) continue;

            const answer = await window.quantum.invoke('dialog:confirmDiscard', {
              name: current.name,
            });
            if (answer === 'cancel') {
              proceed = false;
              break;
            }
            if (answer === 'save') {
              store().setActive(current.id);
              if (!(await save({ forceDialog: false }))) {
                proceed = false;
                break;
              }
            } else {
              await window.quantum.invoke('autosave:clear', { id: current.id });
            }
          }
        } finally {
          try {
            await window.quantum.invoke('window:closeDecision', { proceed });
          } finally {
            closing.current = false;
          }
        }
      })();
    });
  }, [save, store]);

  const activePath = active?.path ?? null;
  const activeAppData = active?.appData ?? null;
  const activeAppDataRevision = active?.appDataRevision ?? 0;
  useAutosave({
    activePath,
    activeAppData,
    activeAppDataRevision,
    autosaveSeconds: settings.autosaveSeconds,
    setStatus,
    t,
  });
  const toggleTimeline = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        timeline: { ...data.timeline, visible: !data.timeline.visible },
      })),
    [updateAppData],
  );
  const executeCommand = useFileCommands({
    closeTab,
    editorView,
    openDialog,
    openPaths,
    onExportPdf: openPdfDialog,
    onOpenSnapshots: openSnapshots,
    onOpenBible: openBible,
    onOpenAiSettings: openAiSettings,
    onOpenInconsistencies: openInconsistencies,
    onOpenVoiceConsistency: openVoiceConsistency,
    onOpenRepetitions: openRepetitions,
    onRewrite: openRewriteSelection,
    onSynonyms: openSynonyms,
    onRenameCharacter: openRenameCharacter,
    onRenumberScenes: () => {
      const view = editorView.current;
      if (!view) return;
      const headings = view.state
        .field(fountainLexField)
        .lines.filter((line) => line.kind === 'scene_heading');
      const changes = headings.flatMap((heading, index) => {
        const source = view.state.sliceDoc(heading.from, heading.to);
        const numbered = /\s+#[^#\r\n]+#\s*$/.test(source)
          ? source.replace(/\s+#[^#\r\n]+#(\s*)$/, ` #${index + 1}#$1`)
          : `${source.replace(/\s+$/, '')} #${index + 1}#${source.match(/\s+$/)?.[0] ?? ''}`;
        return numbered === source
          ? []
          : [{ from: heading.from, to: heading.to, insert: numbered }];
      });
      if (changes.length > 0) {
        view.dispatch({ changes, annotations: isolateHistory.of('full') });
      }
      view.focus();
      setStatus(t('status.scenesRenumbered', { count: headings.length }));
    },
    onRemoveSceneNumbers: () => {
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
    },
    onToggleTimeline: toggleTimeline,
    onCommandPalette: () => setPaletteOpen(true),
    patchSettings,
    save,
    setStatus,
    stringsRef,
    t,
  });
  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'file.new', label: t('menu.file.new'), shortcut: '⌘N' },
      { id: 'file.open', label: t('menu.file.open'), shortcut: '⌘O' },
      { id: 'file.save', label: t('menu.file.save'), shortcut: '⌘S' },
      { id: 'file.exportPdf', label: t('menu.file.exportPdf'), shortcut: '⇧⌘E' },
      { id: 'file.snapshots', label: t('menu.file.snapshots') },
      { id: 'file.bible', label: t('menu.file.bible') },


      { id: 'edit.find', label: t('menu.edit.find'), shortcut: '⌘F' },
      { id: 'view.toggleTimeline', label: t('menu.view.showTimeline') },
      { id: 'view.toggleFocus', label: t('menu.view.focusMode'), shortcut: '⇧⌘F' },
      { id: 'view.toggleTypewriter', label: t('menu.view.typewriterMode'), shortcut: '⇧⌘T' },
      { id: 'view.toggleSceneNumbers', label: t('menu.view.showSceneNumbers') },
      { id: 'view.toggleNotes', label: t('menu.view.showNotes') },
      { id: 'view.toggleBoneyard', label: t('menu.view.showBoneyard') },
      { id: 'view.toggleSynopses', label: t('menu.view.showSynopses') },
      { id: 'view.toggleSections', label: t('menu.view.showSections') },
      { id: 'ai.openSettings', label: t('menu.ai.settings') },
      { id: 'ai.rewrite', label: t('menu.ai.rewrite'), shortcut: '⌥⌘R' },
      { id: 'ai.renameCharacter', label: t('menu.ai.renameCharacter') },
      { id: 'ai.openInconsistencies', label: t('menu.ai.inconsistencies') },
      { id: 'ai.openVoiceConsistency', label: t('menu.ai.voiceConsistency') },
      { id: 'ai.openRepetitions', label: t('menu.ai.repetitions') },
      { id: 'view.toggleFormattedMode', label: t('menu.view.formattedMode') },
    ],
    [t],
  );

  // Stable UI callbacks keep the memoised preview/sidebar from rendering on every
  // keystroke while their worker analysis is unchanged.
  const handleEditorChange = useCallback(
    (content: string) => {
      const id = store().activeId;
      if (id) store().setContent(id, content);
    },
    [store],
  );
  const handleCursorOffset = useCallback(
    (offset: number) => setCursorPosition({ documentId: store().activeId, offset }),
    [store],
  );
  const handleSelectionRange = useCallback(
    (range: { from: number; to: number }) =>
      setEditorSelection({ documentId: store().activeId, ...range }),
    [store],
  );
  const handleEditorScroll = useCallback(
    (offset: number) => {
      const current = store().active();
      if (current?.appData.preview.syncScroll) {
        setEditorScrollPosition({ documentId: current.id, offset });
      }
    },
    [store],
  );
  const handlePreviewScroll = useCallback(
    (offset: number) => setPreviewScrollPosition({ documentId: store().activeId, offset }),
    [store],
  );
  const handleViewReady = useCallback((view: EditorView | null) => {
    editorView.current = view;
  }, []);
  const resizePreview = useCallback(
    (width: number) => updateAppData((data) => ({ ...data, preview: { ...data.preview, width } })),
    [updateAppData],
  );
  const setPreviewSync = useCallback(
    (syncScroll: boolean) =>
      updateAppData((data) => ({ ...data, preview: { ...data.preview, syncScroll } })),
    [updateAppData],
  );
  const closePreview = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        preview: { ...data.preview, visible: false },
      })),
    [updateAppData],
  );
  const setRightPanelTab = useCallback(
    (activeTab: RightPanelTab) =>
      updateAppData((data) => ({
        ...data,
        preview: { ...data.preview, activeTab },
      })),
    [updateAppData],
  );
  const exportStats = useCallback(
    async (format: 'csv' | 'json') => {
      const current = store().active();
      if (!current || !analysis) return;
      const content =
        format === 'csv'
          ? statisticsToCsv(analysis.statistics)
          : statisticsToJson(analysis.statistics);
      const base = current.name.replace(/\.(fountain|txt)$/i, '');
      const outcome = await window.quantum.invoke('file:exportText', {
        suggestedName: `${base}-statistics.${format}`,
        content,
        format,
      });
      if (outcome.status === 'exported') {
        setStatus(t('status.exported', { path: outcome.path }));
      } else if (outcome.status === 'error') {
        setStatus(t('status.exportFailed', { error: outcome.message }));
      }
    },
    [analysis, store, t],
  );
  const resizeSidebar = useCallback(
    (width: number) => updateAppData((data) => ({ ...data, sidebar: { ...data.sidebar, width } })),
    [updateAppData],
  );
  const setSidebarTab = useCallback(
    (activeTab: SidebarTab) =>
      updateAppData((data) => ({ ...data, sidebar: { ...data.sidebar, activeTab } })),
    [updateAppData],
  );
  const setSidebarFilter = useCallback(
    (filter: string) =>
      updateAppData((data) => ({ ...data, sidebar: { ...data.sidebar, filter } })),
    [updateAppData],
  );
  const setSidebarSynopses = useCallback(
    (showSynopses: boolean) =>
      updateAppData((data) => ({
        ...data,
        sidebar: { ...data.sidebar, showSynopses },
      })),
    [updateAppData],
  );
  const selectEditorRange = useCallback((range: { from: number; to: number }) => {
    const view = editorView.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: range.from },
      effects: EditorView.scrollIntoView(range.from, { y: 'center' }),
    });
    view.focus();
  }, []);
  const closeSidebar = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        sidebar: { ...data.sidebar, visible: false },
      })),
    [updateAppData],
  );
  const showPreview = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        preview: { ...data.preview, visible: true },
      })),
    [updateAppData],
  );
  const showSidebar = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        sidebar: { ...data.sidebar, visible: true },
      })),
    [updateAppData],
  );
  const updateTimeline = useCallback(
    (patch: Partial<TimelineState>) =>
      updateAppData((data) => ({
        ...data,
        timeline: { ...data.timeline, ...patch },
      })),
    [updateAppData],
  );
  const closeTimeline = useCallback(() => updateTimeline({ visible: false }), [updateTimeline]);
  const showTimeline = useCallback(() => updateTimeline({ visible: true }), [updateTimeline]);
  const updateRewrite = useCallback(
    (rewrite: RewriteState) => updateAppData((data) => ({ ...data, rewrite })),
    [updateAppData],
  );

  // Each voice keeps its own findings, so the character is a key inside voiceConsistency —
  // not a key of the companion file itself.
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
  const replaceEditorRange = useCallback((from: number, to: number, content: string) => {
    const view = editorView.current;
    if (!view) return;
    view.dispatch({
      changes: { from, to, insert: content },
      selection: { anchor: from + content.length },
      scrollIntoView: true,
    });
    view.focus();
  }, []);
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
    [analysis, characterNameSelection?.name, t],
  );
  const formatSelection = useCallback(
    (marker: '*' | '**' | '_') => {
      const view = editorView.current;
      if (!view) return;
      const selection = view.state.selection.main;
      if (selection.empty) {
        setStatus(t('formatting.selectText'));
        return;
      }
      const text = view.state.sliceDoc(selection.from, selection.to);
      const before = view.state.sliceDoc(
        Math.max(0, selection.from - marker.length),
        selection.from,
      );
      const after = view.state.sliceDoc(
        selection.to,
        Math.min(view.state.doc.length, selection.to + marker.length),
      );
      if (before === marker && after === marker) {
        view.dispatch({
          changes: [
            { from: selection.from - marker.length, to: selection.from, insert: '' },
            { from: selection.to, to: selection.to + marker.length, insert: '' },
          ],
          selection: {
            anchor: selection.from - marker.length,
            head: selection.to - marker.length,
          },
        });
        view.focus();
        return;
      }
      const insert = `${marker}${text}${marker}`;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert },
        selection: {
          anchor: selection.from + marker.length,
          head: selection.from + marker.length + text.length,
        },
      });
      view.focus();
    },
    [t],
  );
  const newDocument = useCallback(() => store().newDocument(stringsRef.current), [store]);
  const setActive = useCallback((id: string) => store().setActive(id), [store]);

  return (
    <>
      <Workspace
        active={active}
        activeId={activeId}
        activeSceneId={activeSceneId}
        analysis={analysis}
        documents={documents}
        editorScrollPosition={editorScrollPosition}
        effectiveDark={effectiveDark}
        previewScrollPosition={previewScrollPosition}
        settings={settings}
        status={status}
        t={t}
        onCloseTab={(id) => void closeTab(id)}
        onNewDocument={newDocument}
        onSetActive={setActive}
        onSettingsChange={(patch) => void patchSettings(patch)}
        onEditorChange={handleEditorChange}
        onCursorOffset={handleCursorOffset}
        onSelectionRange={handleSelectionRange}
        onEditorScroll={handleEditorScroll}
        onPreviewScroll={handlePreviewScroll}
        onViewReady={handleViewReady}
        onResizePreview={resizePreview}
        onPreviewSync={setPreviewSync}
        onRightPanelTab={setRightPanelTab}
        formattingActive={formattingActive}
        onFormatSelection={formatSelection}
        onOpenInconsistencies={openInconsistencies}
        onOpenVoiceConsistency={openVoiceConsistency}
        onOpenRepetitions={openRepetitions}
        onOpenBible={openBible}
        onExportStats={(format) => void exportStats(format)}
        onMinutesPerPage={(value) => void patchSettings({ minutesPerPage: value })}
        onClosePreview={closePreview}
        onShowPreview={showPreview}
        onResizeSidebar={resizeSidebar}
        onSidebarTab={setSidebarTab}
        onSidebarFilter={setSidebarFilter}
        onSidebarSynopses={setSidebarSynopses}
        onSelectEditorRange={selectEditorRange}
        onCloseSidebar={closeSidebar}
        onShowSidebar={showSidebar}
        onTimelineState={updateTimeline}
        onCloseTimeline={closeTimeline}
        onShowTimeline={showTimeline}
      />
      {pdfOpen && active ? (
        <PdfExportDialog
          source={active.content}
          suggestedName={`${active.name.replace(/\.(fountain|txt)$/i, '')}.pdf`}
          onExported={(path) => {
            setStatus(t('status.exported', { path }));
            setPdfOpen(false);
          }}
          onError={(error) => setStatus(t('status.exportFailed', { error }))}
          onClose={() => setPdfOpen(false)}
        />
      ) : null}
      {bibleOpen && active ? (
        <BiblePanel
          // Keyed by document: switching tabs unmounts the panel, which cancels a running
          // draft. Without it the request outlives the switch and its result is written to
          // whichever bible is on screen when it lands — the wrong screenplay's.
          key={active.id}
          path={active.path}
          analysis={analysis}
          t={t}
          onClose={() => setBibleOpen(false)}
        />
      ) : null}

      {snapshotsOpen && active ? (
        <SnapshotDialog
          path={active.path}
          currentContent={active.content}
          t={t}
          onRestore={(content, name) => {
            const view = editorView.current;
            if (!view) return;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: content },
              // Restoring must be its own undo step. Without this the history groups it
              // with whatever edit came just before, so undoing appears to do nothing:
              // it reverts both at once and lands on the very text the restore produced.
              annotations: isolateHistory.of('full'),
            });
            view.focus();
            setSnapshotsOpen(false);
            setStatus(t('snapshots.restored', { name }));
          }}
          onClose={() => setSnapshotsOpen(false)}
        />
      ) : null}
      {aiSettingsOpen ? (
        <AiSettingsDialog
          onSaved={() => setAiSettingsRevision((revision) => revision + 1)}
          onClose={() => setAiSettingsOpen(false)}
        />
      ) : null}
      {inconsistencyOpen && active ? (
        <InconsistencyPanel
          screenplay={active.content}
          analysis={analysis}
          state={active.appData.inconsistencies}
          t={t}
          onStateChange={updateInconsistencies}
          onSelectReference={(reference) => {
            selectInconsistencyReference(reference);
            setInconsistencyOpen(false);
          }}
          onClose={() => setInconsistencyOpen(false)}
        />
      ) : null}

      {voiceConsistencyOpen && active ? (
        <VoiceConsistencyPanel
          analysis={analysis}
          state={active.appData.voiceConsistency}
          t={t}
          onStateChange={updateVoiceConsistency}
          onSelectReference={(reference) => {
            selectInconsistencyReference(reference);
            setVoiceConsistencyOpen(false);
          }}
          onClose={() => setVoiceConsistencyOpen(false)}
        />
      ) : null}

      {repetitionsOpen && active ? (
        <RepetitionPanel
          analysis={analysis}
          state={active.appData.repetitions}
          t={t}
          onStateChange={updateRepetitions}
          onSelectRange={(range) => {
            selectEditorRange(range);
            setRepetitionsOpen(false);
          }}
          onSelectReference={(reference) => {
            selectInconsistencyReference(reference);
            setRepetitionsOpen(false);
          }}
          onClose={() => setRepetitionsOpen(false)}
        />
      ) : null}
      {rewriteSelection && active ? (
        <RewriteDialog
          selection={rewriteSelection}
          state={active.appData.rewrite}
          onStateChange={updateRewrite}
          onReplace={replaceEditorRange}
          onClose={() => setRewriteSelection(null)}
        />
      ) : null}
      {characterNameSelection ? (
        <CharacterNameDialog
          selection={characterNameSelection}
          onRename={renameCharacter}
          onClose={() => setCharacterNameSelection(null)}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          commands={paletteCommands}
          onRun={executeCommand}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      <EditorContextMenu
        t={t}
        onSynonyms={openSynonyms}
        onRewrite={openRewriteSelection}
        onRenameCharacter={openRenameCharacter}
      />
    </>
  );
}
