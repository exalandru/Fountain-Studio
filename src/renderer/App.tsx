import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import type { AppData, SidebarTab } from '@shared/appdata/index.js';
import type { AppSettings } from '@shared/ipc-contract.js';
import { useAutosave } from './hooks/useAutosave.js';
import { useDocumentIO } from './hooks/useDocumentIO.js';
import { useFileCommands } from './hooks/useFileCommands.js';
import { useRecovery } from './hooks/useRecovery.js';
import { useScreenplay } from './hooks/useScreenplay.js';
import { useTranslator } from './hooks/useTranslator.js';
import type { NewDocumentStrings } from './store/documents.js';
import { useDocuments } from './store/documents.js';
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
  const [cursorPosition, setCursorPosition] = useState<{
    documentId: string | null;
    offset: number;
  }>({ documentId: null, offset: 0 });
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
  const analysis = useScreenplay(active?.id ?? null, active?.content ?? '', active?.revision ?? 0);

  const effectiveDark = settings.theme === 'dark' || (settings.theme === 'system' && dark);
  const cursorOffset = cursorPosition.documentId === activeId ? cursorPosition.offset : 0;
  const activeSceneId =
    analysis?.scenes.find(
      (scene) => cursorOffset >= scene.range.from && cursorOffset <= scene.range.to,
    )?.id ?? null;

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
  useFileCommands({
    closeTab,
    editorView,
    openDialog,
    openPaths,
    patchSettings,
    save,
    setStatus,
    stringsRef,
    t,
  });

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
  const newDocument = useCallback(() => store().newDocument(stringsRef.current), [store]);
  const setActive = useCallback((id: string) => store().setActive(id), [store]);

  return (
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
      onEditorChange={handleEditorChange}
      onCursorOffset={handleCursorOffset}
      onEditorScroll={handleEditorScroll}
      onPreviewScroll={handlePreviewScroll}
      onViewReady={handleViewReady}
      onResizePreview={resizePreview}
      onPreviewSync={setPreviewSync}
      onClosePreview={closePreview}
      onShowPreview={showPreview}
      onResizeSidebar={resizeSidebar}
      onSidebarTab={setSidebarTab}
      onSidebarFilter={setSidebarFilter}
      onSidebarSynopses={setSidebarSynopses}
      onSelectEditorRange={selectEditorRange}
      onCloseSidebar={closeSidebar}
      onShowSidebar={showSidebar}
    />
  );
}
