import { useEffect } from 'react';
import type { RefObject } from 'react';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import type { AppSettings, MenuCommand } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';
import type { NewDocumentStrings } from '../store/documents.js';
import { useDocuments } from '../store/documents.js';

interface FileCommandsOptions {
  closeTab: (id: string) => Promise<void>;
  editorView: RefObject<EditorView | null>;
  openDialog: () => Promise<void>;
  openPaths: (paths: string[]) => Promise<void>;
  onExportPdf: () => void;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  save: (options: { forceDialog: boolean }) => Promise<boolean>;
  setStatus: (message: string) => void;
  stringsRef: RefObject<NewDocumentStrings>;
  t: Translator['t'];
}

/** Connects native menu and drag-and-drop file commands to document operations. */
export function useFileCommands({
  closeTab,
  editorView,
  openDialog,
  openPaths,
  onExportPdf,
  patchSettings,
  save,
  setStatus,
  stringsRef,
  t,
}: FileCommandsOptions): void {
  const store = useDocuments.getState;

  useEffect(() => {
    const handlers = {
      'file.new': () => stringsRef.current && store().newDocument(stringsRef.current),
      'file.open': () => void openDialog(),
      'file.save': () => void save({ forceDialog: false }),
      'file.saveAs': () => void save({ forceDialog: true }),
      'file.exportPdf': onExportPdf,
      'file.closeTab': () => {
        const id = store().activeId;
        if (id) void closeTab(id);
      },
      'edit.find': () => editorView.current && openSearchPanel(editorView.current),
      'edit.replace': () => editorView.current && openSearchPanel(editorView.current),
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
    } satisfies Record<MenuCommand, () => void>;

    return window.quantum.on('menu:command', ({ command }) => handlers[command]());
  }, [
    closeTab,
    editorView,
    onExportPdf,
    openDialog,
    patchSettings,
    save,
    setStatus,
    store,
    stringsRef,
    t,
  ]);

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
  }, [openPaths, setStatus, t]);
}
