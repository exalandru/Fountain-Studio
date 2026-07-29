import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import type { AppSettings, MenuCommand } from '@shared/ipc-contract.js';
import { Editor } from './editor/Editor.js';
import { useScreenplay } from './hooks/useScreenplay.js';
import { useTranslator } from './hooks/useTranslator.js';
import type { NewDocumentStrings } from './store/documents.js';
import { useDocuments } from './store/documents.js';

/**
 * Application shell: tabs, editor, status bar.
 *
 * The preview, sidebar and timeline arrive in M2/M4; the layout anticipates them
 * (central area plus reserved slots) without scaffolding them yet.
 */
export function App() {
  const documents = useDocuments((state) => state.documents);
  const activeId = useDocuments((state) => state.activeId);
  const settings = useDocuments((state) => state.settings);
  const store = useDocuments.getState;
  const { t, locale } = useTranslator();

  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [status, setStatus] = useState<string | null>(null);
  const editorView = useRef<EditorView | null>(null);
  /**
   * Documents whose save is in flight. Two concurrent writes to the same file would
   * rotate the `.bak` files twice and leave a backup identical to the current file —
   * or overwrite the most recent one.
   */
  const saving = useRef(new Set<string>());

  const active = documents.find((d) => d.id === activeId) ?? null;
  const analysis = useScreenplay(active?.id ?? null, active?.content ?? '', active?.revision ?? 0);

  const effectiveDark = settings.theme === 'dark' || (settings.theme === 'system' && dark);

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
          store().restore(record.path, record.content, stringsRef.current);
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
    if (!active) return;
    void window.quantum.invoke('window:setDirty', {
      dirty: active.dirty,
      name: active.name,
    });
  }, [active?.dirty, active?.name, active]);

  // ── Saving ─────────────────────────────────────────────────────────────────
  const save = useCallback(
    async (options: { forceDialog: boolean }): Promise<boolean> => {
      const current = store().active();
      if (!current) return false;
      if (saving.current.has(current.id)) return false;

      saving.current.add(current.id);
      try {
        let path = current.path;
        if (path === null || options.forceDialog) {
          path = await window.quantum.invoke('dialog:pickSaveAs', {
            suggestedName: current.path ?? `${current.name.replace(/\.fountain$/, '')}.fountain`,
          });
          if (path === null) return false;
        }

        // Re-read the content at the last moment: the author may have kept typing while
        // the dialog was open.
        const fresh = store().documents.find((d) => d.id === current.id) ?? current;

        const outcome = await window.quantum.invoke('file:save', {
          path,
          content: fresh.content,
          eol: fresh.eol,
          // "Save as" targets a new file: there is no mtime to compare against.
          expectedMtimeMs: options.forceDialog || fresh.path !== path ? null : fresh.mtimeMs,
        });

        if (outcome.status === 'saved') {
          store().markSaved(current.id, outcome.path, outcome.mtimeMs);
          void window.quantum.invoke('autosave:clear', { id: current.id });
          setStatus(
            t('status.saved', {
              time: new Date().toLocaleTimeString(locale),
            }),
          );
          return true;
        }

        if (outcome.status === 'conflict') {
          setStatus(t('status.conflict'));
        } else if (outcome.status === 'error') {
          setStatus(t('status.saveFailed', { error: outcome.message }));
        }
        return false;
      } finally {
        saving.current.delete(current.id);
      }
    },
    [locale, store, t],
  );

  // ── Opening ────────────────────────────────────────────────────────────────
  const openDialog = useCallback(async () => {
    const snapshots = await window.quantum.invoke('dialog:pickOpen', undefined);
    store().adopt(snapshots);
  }, [store]);

  const openPaths = useCallback(
    async (paths: string[]) => {
      const snapshots = await Promise.all(
        paths.map((path) => window.quantum.invoke('file:read', { path }).catch(() => null)),
      );
      store().adopt(snapshots.filter((s): s is NonNullable<typeof s> => s !== null));
    },
    [store],
  );

  useEffect(
    () => window.quantum.on('app:openFiles', ({ paths }) => void openPaths(paths)),
    [openPaths],
  );

  // ── Closing a tab, guarding unsaved changes ────────────────────────────────
  const closeTab = useCallback(
    async (id: string) => {
      const target = store().documents.find((d) => d.id === id);
      if (!target) return;

      if (target.dirty) {
        const answer = await window.quantum.invoke('dialog:confirmDiscard', { name: target.name });
        if (answer === 'cancel') return;
        if (answer === 'save') {
          store().setActive(id);
          const saved = await save({ forceDialog: false });
          if (!saved) return;
        }
      }

      void window.quantum.invoke('autosave:clear', { id });
      store().close(id);
      if (store().documents.length === 0) store().newDocument(stringsRef.current);
    },
    [save, store],
  );

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

  return (
    <div className="app">
      <div className="tabbar" role="tablist">
        {documents.map((document) => (
          <div
            key={document.id}
            role="tab"
            aria-selected={document.id === activeId}
            tabIndex={0}
            className={`tab${document.id === activeId ? ' tab-active' : ''}`}
            onClick={() => store().setActive(document.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') store().setActive(document.id);
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

      <main className="workspace">
        {active ? (
          <Editor
            key={active.id}
            documentId={active.id}
            initialContent={active.content}
            dark={effectiveDark}
            fontSize={settings.editorFontSize}
            showNotes={settings.showNotes}
            showSynopses={settings.showSynopses}
            showSections={settings.showSections}
            onChange={(content) => store().setContent(active.id, content)}
            onViewReady={(view) => {
              editorView.current = view;
            }}
          />
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
