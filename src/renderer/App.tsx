import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import type { AppData, SidebarTab } from '@shared/appdata/index.js';
import type { AppSettings, MenuCommand } from '@shared/ipc-contract.js';
import { Editor } from './editor/Editor.js';
import { useDocumentIO } from './hooks/useDocumentIO.js';
import { useScreenplay } from './hooks/useScreenplay.js';
import { useTranslator } from './hooks/useTranslator.js';
import { Preview } from './preview/index.js';
import { Sidebar } from './sidebar/index.js';
import type { NewDocumentStrings } from './store/documents.js';
import { useDocuments } from './store/documents.js';
import { ResizeHandle } from './ui/ResizeHandle.js';

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

  // ── Startup: crash recovery, otherwise a blank tab ────────────────────────
  //
  // Any autosave snapshot still present is the trace of a session that did not end
  // normally: it is reopened as-is, marked unsaved, so the author decides whether to
  // overwrite the file.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const pending = await window.quantum.invoke('autosave:pending', undefined);
      if (cancelled) return;

      if (pending.length > 0) {
        for (const record of pending) {
          const id = store().restore(
            record.path,
            record.content,
            stringsRef.current,
            record.eol,
            record.mtimeMs,
          );
          if (record.path) {
            try {
              const appData = await window.quantum.invoke('appdata:read', { path: record.path });
              if (!cancelled && appData) store().setAppData(id, appData);
            } catch {
              if (!cancelled) setStatus(t('status.appDataFailed'));
            }
          }
        }
        setStatus(t('status.recovered', { count: pending.length }));
      }

      if (store().documents.length === 0) store().newDocument(stringsRef.current);
    })();

    return () => {
      cancelled = true;
    };
    // Startup only: re-running this on a language change would reopen the snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

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

  // ── Menu commands ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handlers: Record<MenuCommand, () => void> = {
      'file.new': () => store().newDocument(stringsRef.current),
      'file.open': () => void openDialog(),
      'file.save': () => void save({ forceDialog: false }),
      'file.saveAs': () => void save({ forceDialog: true }),
      'file.closeTab': () => {
        const id = store().activeId;
        if (id) void closeTab(id);
      },
      'edit.find': () => {
        if (editorView.current) openSearchPanel(editorView.current);
      },
      'edit.replace': () => {
        if (editorView.current) openSearchPanel(editorView.current);
      },
      'view.toggleNotes': () => void patchSettings({ showNotes: !store().settings.showNotes }),
      'view.toggleBoneyard': () =>
        void patchSettings({ showBoneyard: !store().settings.showBoneyard }),
      'view.toggleSynopses': () =>
        void patchSettings({ showSynopses: !store().settings.showSynopses }),
      'view.toggleSections': () =>
        void patchSettings({ showSections: !store().settings.showSections }),
      'view.increaseFont': () =>
        void patchSettings({ editorFontSize: Math.min(28, store().settings.editorFontSize + 1) }),
      'view.decreaseFont': () =>
        void patchSettings({ editorFontSize: Math.max(10, store().settings.editorFontSize - 1) }),
      'scene.renumber': () => setStatus(t('status.renumberPlanned')),
      'help.about': () => setStatus(t('status.about', { app: t('app.name'), version: '0.1.0' })),
    };

    return window.quantum.on('menu:command', ({ command }) => handlers[command]?.());
  }, [closeTab, openDialog, patchSettings, save, store, t]);

  // Companion metadata is written after a short quiet period. It never marks the
  // screenplay dirty because UI layout is not Fountain content.
  const activePath = active?.path ?? null;
  const activeAppData = active?.appData ?? null;
  const activeAppDataRevision = active?.appDataRevision ?? 0;
  useEffect(() => {
    if (!activePath || !activeAppData || activeAppDataRevision === 0) return;
    const timer = setTimeout(() => {
      void window.quantum
        .invoke('appdata:write', { path: activePath, data: activeAppData })
        .catch(() => {
          setStatus(t('status.appDataFailed'));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [activeAppData, activeAppDataRevision, activePath, t]);

  // ── Backup autosave ────────────────────────────────────────────────────────
  useEffect(() => {
    if (settings.autosaveSeconds <= 0) return;

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
    }, settings.autosaveSeconds * 1000);

    return () => clearInterval(timer);
  }, [settings.autosaveSeconds, store]);

  // ── Dropping a file onto the window ────────────────────────────────────────
  useEffect(() => {
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const paths: string[] = [];
      const rejected: string[] = [];

      for (const file of event.dataTransfer?.files ?? []) {
        const path = window.quantum.getPathForFile(file);
        if (path && /\.(fountain|txt)$/i.test(path)) paths.push(path);
        else rejected.push(file.name);
      }

      if (paths.length > 0) void openPaths(paths);
      if (rejected.length > 0) {
        setStatus(t('status.unsupportedFormat', { files: rejected.join(', ') }));
      }
    };
    const onDragOver = (event: DragEvent) => event.preventDefault();

    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  }, [openPaths, t]);

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

  return (
    <div className="app">
      <div className="tabbar" role="tablist">
        {documents.map((document) => (
          <div
            key={document.id}
            role="tab"
            aria-controls="workspace-panel"
            aria-selected={document.id === activeId}
            tabIndex={document.id === activeId ? 0 : -1}
            className={`tab${document.id === activeId ? ' tab-active' : ''}`}
            onClick={() => store().setActive(document.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') store().setActive(document.id);
              const currentIndex = documents.findIndex((item) => item.id === document.id);
              const nextIndex =
                event.key === 'ArrowRight'
                  ? (currentIndex + 1) % documents.length
                  : event.key === 'ArrowLeft'
                    ? (currentIndex - 1 + documents.length) % documents.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? documents.length - 1
                        : -1;
              const next = documents[nextIndex];
              if (nextIndex >= 0 && next) {
                event.preventDefault();
                store().setActive(next.id);
                const tabs =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
                tabs?.[nextIndex]?.focus();
              }
            }}
          >
            <span className="tab-name">
              {document.dirty ? '• ' : ''}
              {document.name}
            </span>
            <button
              type="button"
              className="tab-close"
              aria-label={t('tab.close', { name: document.name })}
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(document.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="tab-new"
          aria-label={t('tab.new')}
          onClick={() => store().newDocument(stringsRef.current)}
        >
          +
        </button>
      </div>

      <main
        className="workspace"
        id="workspace-panel"
        role="tabpanel"
        aria-label={active?.name ?? t('workspace.empty')}
      >
        {active ? (
          <div className="workspace-layout">
            <div className="workspace-editor">
              <Editor
                key={active.id}
                documentId={active.id}
                initialContent={active.content}
                dark={effectiveDark}
                fontSize={settings.editorFontSize}
                showNotes={settings.showNotes}
                showBoneyard={settings.showBoneyard}
                showSynopses={settings.showSynopses}
                showSections={settings.showSections}
                externalScrollOffset={
                  active.appData.preview.syncScroll &&
                  previewScrollPosition.documentId === active.id
                    ? previewScrollPosition.offset
                    : null
                }
                onChange={handleEditorChange}
                onCursorOffset={handleCursorOffset}
                onScrollOffset={handleEditorScroll}
                onViewReady={handleViewReady}
              />
            </div>

            {active.appData.preview.visible ? (
              <>
                <ResizeHandle
                  label={t('preview.resize')}
                  value={active.appData.preview.width}
                  minimum={320}
                  maximum={760}
                  onChange={resizePreview}
                />
                <div className="workspace-preview" style={{ width: active.appData.preview.width }}>
                  <Preview
                    analysis={analysis}
                    syncScroll={active.appData.preview.syncScroll}
                    externalOffset={
                      editorScrollPosition.documentId === active.id
                        ? editorScrollPosition.offset
                        : null
                    }
                    onScrollOffset={handlePreviewScroll}
                    onSyncScrollChange={setPreviewSync}
                    onClose={closePreview}
                  />
                </div>
              </>
            ) : null}

            {active.appData.sidebar.visible ? (
              <>
                <ResizeHandle
                  label={t('sidebar.resize')}
                  value={active.appData.sidebar.width}
                  minimum={220}
                  maximum={480}
                  onChange={resizeSidebar}
                />
                <div className="workspace-sidebar" style={{ width: active.appData.sidebar.width }}>
                  <Sidebar
                    analysis={analysis}
                    state={active.appData.sidebar}
                    activeSceneId={activeSceneId}
                    onTabChange={setSidebarTab}
                    onFilterChange={setSidebarFilter}
                    onShowSynopsesChange={setSidebarSynopses}
                    onSelectRange={selectEditorRange}
                    onClose={closeSidebar}
                  />
                </div>
              </>
            ) : null}

            {(!active.appData.preview.visible || !active.appData.sidebar.visible) && (
              <div className="panel-launchers">
                {!active.appData.preview.visible ? (
                  <button
                    type="button"
                    onClick={() =>
                      updateAppData((data) => ({
                        ...data,
                        preview: { ...data.preview, visible: true },
                      }))
                    }
                  >
                    {t('preview.show')}
                  </button>
                ) : null}
                {!active.appData.sidebar.visible ? (
                  <button
                    type="button"
                    onClick={() =>
                      updateAppData((data) => ({
                        ...data,
                        sidebar: { ...data.sidebar, visible: true },
                      }))
                    }
                  >
                    {t('sidebar.show')}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <div className="empty">{t('workspace.empty')}</div>
        )}
      </main>

      <footer className="statusbar">
        <span>{analysis ? t('status.scenes', { count: analysis.sceneCount }) : '—'}</span>
        <span>{analysis ? t('status.words', { count: analysis.wordCount }) : ''}</span>
        <span>{analysis ? t('status.characters', { count: analysis.characterCount }) : ''}</span>
        <span>{analysis ? t('status.locations', { count: analysis.locationCount }) : ''}</span>
        {analysis && analysis.diagnostics.length > 0 && (
          <span className="status-warning">
            {t('status.warnings', { count: analysis.diagnostics.length })}
          </span>
        )}
        <span className="status-message">{status}</span>
        {analysis && (
          <span className="status-timing">
            {t('status.analysis', { ms: analysis.durationMs.toFixed(0) })}
          </span>
        )}
      </footer>
    </div>
  );
}
