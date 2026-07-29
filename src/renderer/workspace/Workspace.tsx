import type { AppSettings } from '@shared/ipc-contract.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { OpenDocument } from '../store/documents.js';
import { Editor } from '../editor/Editor.js';
import { Preview } from '../preview/index.js';
import { Sidebar } from '../sidebar/index.js';
import { ResizeHandle } from '../ui/ResizeHandle.js';

const EMPTY_COMPLETIONS = { characters: [], locations: [], times: [] };

interface ScrollPosition {
  documentId: string | null;
  offset: number;
}

interface WorkspaceProps {
  active: OpenDocument | null;
  activeId: string | null;
  activeSceneId: string | null;
  analysis: ParseResponse | null;
  documents: OpenDocument[];
  editorScrollPosition: ScrollPosition;
  effectiveDark: boolean;
  previewScrollPosition: ScrollPosition;
  settings: AppSettings;
  status: string | null;
  t: Translator['t'];
  onCloseTab: (id: string) => void;
  onNewDocument: () => void;
  onSetActive: (id: string) => void;
  onEditorChange: (content: string) => void;
  onCursorOffset: (offset: number) => void;
  onEditorScroll: (offset: number) => void;
  onPreviewScroll: (offset: number) => void;
  onViewReady: EditorParameters['onViewReady'];
  onResizePreview: (width: number) => void;
  onPreviewSync: (enabled: boolean) => void;
  onClosePreview: () => void;
  onShowPreview: () => void;
  onResizeSidebar: (width: number) => void;
  onSidebarTab: Parameters<typeof Sidebar>[0]['onTabChange'];
  onSidebarFilter: (filter: string) => void;
  onSidebarSynopses: (visible: boolean) => void;
  onSelectEditorRange: (range: { from: number; to: number }) => void;
  onCloseSidebar: () => void;
  onShowSidebar: () => void;
}

type EditorParameters = Parameters<typeof Editor>[0];

/** Pure visual composition of tabs, editor panels and status information. */
export function Workspace({
  active,
  activeId,
  activeSceneId,
  analysis,
  documents,
  editorScrollPosition,
  effectiveDark,
  previewScrollPosition,
  settings,
  status,
  t,
  onCloseTab,
  onNewDocument,
  onSetActive,
  onEditorChange,
  onCursorOffset,
  onEditorScroll,
  onPreviewScroll,
  onViewReady,
  onResizePreview,
  onPreviewSync,
  onClosePreview,
  onShowPreview,
  onResizeSidebar,
  onSidebarTab,
  onSidebarFilter,
  onSidebarSynopses,
  onSelectEditorRange,
  onCloseSidebar,
  onShowSidebar,
}: WorkspaceProps) {
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
            onClick={() => onSetActive(document.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSetActive(document.id);
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
                onSetActive(next.id);
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
                onCloseTab(document.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="tab-new" aria-label={t('tab.new')} onClick={onNewDocument}>
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
            {active.appData.sidebar.visible ? (
              <>
                <div className="workspace-sidebar" style={{ width: active.appData.sidebar.width }}>
                  <Sidebar
                    analysis={analysis}
                    state={active.appData.sidebar}
                    activeSceneId={activeSceneId}
                    onTabChange={onSidebarTab}
                    onFilterChange={onSidebarFilter}
                    onShowSynopsesChange={onSidebarSynopses}
                    onSelectRange={onSelectEditorRange}
                    onClose={onCloseSidebar}
                  />
                </div>
                <ResizeHandle
                  label={t('sidebar.resize')}
                  value={active.appData.sidebar.width}
                  minimum={220}
                  maximum={480}
                  paneSide="left"
                  onChange={onResizeSidebar}
                />
              </>
            ) : null}

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
                completionIndex={analysis?.completions ?? EMPTY_COMPLETIONS}
                externalScrollOffset={
                  active.appData.preview.syncScroll &&
                  previewScrollPosition.documentId === active.id
                    ? previewScrollPosition.offset
                    : null
                }
                onChange={onEditorChange}
                onCursorOffset={onCursorOffset}
                onScrollOffset={onEditorScroll}
                onViewReady={onViewReady}
              />
            </div>

            {active.appData.preview.visible ? (
              <>
                <ResizeHandle
                  label={t('preview.resize')}
                  value={active.appData.preview.width}
                  minimum={320}
                  maximum={760}
                  onChange={onResizePreview}
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
                    onScrollOffset={onPreviewScroll}
                    onSyncScrollChange={onPreviewSync}
                    onClose={onClosePreview}
                  />
                </div>
              </>
            ) : null}

            {!active.appData.sidebar.visible ? (
              <div className="panel-launchers panel-launchers-left">
                <button type="button" onClick={onShowSidebar}>
                  {t('sidebar.show')}
                </button>
              </div>
            ) : null}
            {!active.appData.preview.visible ? (
              <div className="panel-launchers panel-launchers-right">
                <button type="button" onClick={onShowPreview}>
                  {t('preview.show')}
                </button>
              </div>
            ) : null}
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
