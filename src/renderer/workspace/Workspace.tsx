import type { AppSettings } from '@shared/ipc-contract.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { RightPanelTab } from '@shared/appdata/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { OpenDocument } from '../store/documents.js';
import { Editor } from '../editor/Editor.js';
import { Preview } from '../preview/index.js';
import { Sidebar } from '../sidebar/index.js';
import { SyntaxMemo } from '../sidebar/SyntaxMemo.js';
import { StatsPanel } from '../stats/index.js';
import { Timeline } from '../timeline/index.js';
import { ResizeHandle } from '../ui/ResizeHandle.js';
import { TopToolbar } from './TopToolbar.js';

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
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  onEditorChange: (content: string) => void;
  onCursorOffset: (offset: number) => void;
  onSelectionRange: (range: { from: number; to: number }) => void;
  onEditorScroll: (offset: number) => void;
  onPreviewScroll: (offset: number) => void;
  onViewReady: EditorParameters['onViewReady'];
  onResizePreview: (width: number) => void;
  onPreviewSync: (enabled: boolean) => void;
  onRightPanelTab: (tab: RightPanelTab) => void;
  formattingActive: { bold: boolean; italic: boolean; underline: boolean };
  onFormatSelection: (marker: '*' | '**' | '_') => void;
  onOpenInconsistencies: () => void;
  onExportStats: (format: 'csv' | 'json') => void;
  onMinutesPerPage: (value: number) => void;
  onClosePreview: () => void;
  onShowPreview: () => void;
  onResizeSidebar: (width: number) => void;
  onSidebarTab: Parameters<typeof Sidebar>[0]['onTabChange'];
  onSidebarFilter: (filter: string) => void;
  onSidebarSynopses: (visible: boolean) => void;
  onSelectEditorRange: (range: { from: number; to: number }) => void;
  onCloseSidebar: () => void;
  onShowSidebar: () => void;
  onTimelineState: (patch: Partial<OpenDocument['appData']['timeline']>) => void;
  onCloseTimeline: () => void;
  onShowTimeline: () => void;
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
  onSettingsChange,
  onEditorChange,
  onCursorOffset,
  onSelectionRange,
  onEditorScroll,
  onPreviewScroll,
  onViewReady,
  onResizePreview,
  onPreviewSync,
  onRightPanelTab,
  formattingActive,
  onFormatSelection,
  onOpenInconsistencies,
  onExportStats,
  onMinutesPerPage,
  onClosePreview,
  onShowPreview,
  onResizeSidebar,
  onSidebarTab,
  onSidebarFilter,
  onSidebarSynopses,
  onSelectEditorRange,
  onCloseSidebar,
  onShowSidebar,
  onTimelineState,
  onCloseTimeline,
  onShowTimeline,
}: WorkspaceProps) {
  return (
    <div className={`app${settings.focusMode ? ' focus-mode' : ''}`}>
      <div className="tabbar">
        <div className="tab-strip">
          <div className="tabs" role="tablist">
            {documents.map((document) => (
              <div
                key={document.id}
                role="presentation"
                className={`tab${document.id === activeId ? ' tab-active' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-controls="workspace-panel"
                  aria-selected={document.id === activeId}
                  tabIndex={document.id === activeId ? 0 : -1}
                  className="tab-select"
                  onClick={() => onSetActive(document.id)}
                  onKeyDown={(event) => {
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
                      const tabs = event.currentTarget
                        .closest('[role="tablist"]')
                        ?.querySelectorAll<HTMLElement>('[role="tab"]');
                      tabs?.[nextIndex]?.focus();
                    }
                  }}
                >
                  <span className="tab-name">
                    {document.dirty ? '• ' : ''}
                    {document.name}
                  </span>
                </button>
                <button
                  type="button"
                  className="tab-close"
                  aria-label={t('tab.close', { name: document.name })}
                  onClick={() => onCloseTab(document.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="tab-new"
            aria-label={t('tab.new')}
            title={t('tab.new')}
            onClick={onNewDocument}
          >
            +
          </button>
        </div>

        <TopToolbar
          settings={settings}
          t={t}
          onSettingsChange={onSettingsChange}
          onOpenInconsistencies={onOpenInconsistencies}
        />
      </div>

      {settings.focusMode ? (
        <button
          type="button"
          className="focus-mode-exit"
          onClick={() => onSettingsChange({ focusMode: false })}
        >
          {t('toolbar.exitFocus')}
        </button>
      ) : null}

      <main
        className="workspace"
        id="workspace-panel"
        role="tabpanel"
        aria-label={active?.name ?? t('workspace.empty')}
      >
        {active ? (
          <div className="workspace-document">
            <div className="workspace-layout">
              {active.appData.sidebar.visible ? (
                <>
                  <div
                    className="workspace-sidebar"
                    style={{ width: active.appData.sidebar.width }}
                  >
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
                  showSceneNumbers={settings.showSceneNumbers}
                  typewriterMode={settings.typewriterMode}
                  formattedMode={settings.formattedMode}
                  completionIndex={analysis?.completions ?? EMPTY_COMPLETIONS}
                  externalScrollOffset={
                    active.appData.preview.syncScroll &&
                    previewScrollPosition.documentId === active.id
                      ? previewScrollPosition.offset
                      : null
                  }
                  onChange={onEditorChange}
                  onCursorOffset={onCursorOffset}
                  onSelectionRange={onSelectionRange}
                  onScrollOffset={onEditorScroll}
                  onViewReady={onViewReady}
                />
                {settings.formattedMode ? (
                  <div
                    className="formatting-toolbar"
                    role="toolbar"
                    aria-label={t('formatting.title')}
                  >
                    <button
                      type="button"
                      className={formattingActive.bold ? 'is-active' : ''}
                      aria-pressed={formattingActive.bold}
                      aria-label={t('formatting.bold')}
                      title={t('formatting.bold')}
                      onClick={() => onFormatSelection('**')}
                    >
                      <strong>B</strong>
                    </button>
                    <button
                      type="button"
                      className={formattingActive.italic ? 'is-active' : ''}
                      aria-pressed={formattingActive.italic}
                      aria-label={t('formatting.italic')}
                      title={t('formatting.italic')}
                      onClick={() => onFormatSelection('*')}
                    >
                      <em>I</em>
                    </button>
                    <button
                      type="button"
                      className={formattingActive.underline ? 'is-active' : ''}
                      aria-pressed={formattingActive.underline}
                      aria-label={t('formatting.underline')}
                      title={t('formatting.underline')}
                      onClick={() => onFormatSelection('_')}
                    >
                      <u>U</u>
                    </button>
                  </div>
                ) : null}
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
                  <div
                    className="workspace-preview"
                    style={{ width: active.appData.preview.width }}
                  >
                    <aside className="right-sidebar" aria-label={t('rightPanel.title')}>
                      <header className="right-panel-header">
                        <div className="right-panel-tabs" role="tablist">
                          {(['statistics', 'preview', 'syntax'] as const).map(
                            (tab, index, tabs) => (
                              <button
                                type="button"
                                role="tab"
                                id={`right-panel-tab-${tab}`}
                                aria-controls="right-panel-content"
                                aria-selected={active.appData.preview.activeTab === tab}
                                tabIndex={active.appData.preview.activeTab === tab ? 0 : -1}
                                className={`right-panel-tab${
                                  active.appData.preview.activeTab === tab ? ' active' : ''
                                }`}
                                key={tab}
                                onClick={() => onRightPanelTab(tab)}
                                onKeyDown={(event) => {
                                  const nextIndex =
                                    event.key === 'ArrowRight'
                                      ? (index + 1) % tabs.length
                                      : event.key === 'ArrowLeft'
                                        ? (index - 1 + tabs.length) % tabs.length
                                        : event.key === 'Home'
                                          ? 0
                                          : event.key === 'End'
                                            ? tabs.length - 1
                                            : -1;
                                  const next = tabs[nextIndex];
                                  if (nextIndex >= 0 && next) {
                                    event.preventDefault();
                                    onRightPanelTab(next);
                                    const buttons =
                                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                                        '[role="tab"]',
                                      );
                                    buttons?.[nextIndex]?.focus();
                                  }
                                }}
                              >
                                {t(`rightPanel.${tab}`)}
                              </button>
                            ),
                          )}
                        </div>
                        <button
                          type="button"
                          className="panel-close"
                          aria-label={t('preview.close')}
                          onClick={onClosePreview}
                        >
                          ×
                        </button>
                      </header>
                      <div
                        className="right-panel-content"
                        role="tabpanel"
                        id="right-panel-content"
                        aria-labelledby={`right-panel-tab-${active.appData.preview.activeTab}`}
                      >
                        {active.appData.preview.activeTab === 'statistics' ? (
                          <StatsPanel
                            statistics={analysis?.statistics ?? null}
                            minutesPerPage={settings.minutesPerPage}
                            onExport={onExportStats}
                            onMinutesPerPage={onMinutesPerPage}
                          />
                        ) : active.appData.preview.activeTab === 'syntax' ? (
                          <div className="right-panel-memo">
                            <SyntaxMemo />
                          </div>
                        ) : (
                          <Preview
                            analysis={analysis}
                            syncScroll={active.appData.preview.syncScroll}
                            showSceneNumbers={settings.showSceneNumbers}
                            externalOffset={
                              editorScrollPosition.documentId === active.id
                                ? editorScrollPosition.offset
                                : null
                            }
                            onScrollOffset={onPreviewScroll}
                            onSyncScrollChange={onPreviewSync}
                          />
                        )}
                      </div>
                    </aside>
                  </div>
                </>
              ) : null}

              {!active.appData.sidebar.visible ? (
                <div className="panel-launchers panel-launchers-left">
                  <button
                    type="button"
                    aria-label={t('sidebar.show')}
                    title={t('sidebar.show')}
                    onClick={onShowSidebar}
                  >
                    ›
                  </button>
                </div>
              ) : null}
              {!active.appData.preview.visible ? (
                <div className="panel-launchers panel-launchers-right">
                  <button
                    type="button"
                    aria-label={t('preview.show')}
                    title={t('preview.show')}
                    onClick={onShowPreview}
                  >
                    ‹
                  </button>
                </div>
              ) : null}
              {!active.appData.timeline.visible ? (
                <div className="timeline-launcher">
                  <button type="button" onClick={onShowTimeline}>
                    {t('timeline.show')}
                  </button>
                </div>
              ) : null}
            </div>
            {active.appData.timeline.visible ? (
              <Timeline
                analysis={analysis}
                state={active.appData.timeline}
                activeSceneId={activeSceneId}
                onStateChange={onTimelineState}
                onSelectRange={onSelectEditorRange}
                onClose={onCloseTimeline}
              />
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
