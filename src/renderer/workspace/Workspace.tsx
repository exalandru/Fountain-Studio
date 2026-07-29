import type { AppSettings } from '@shared/ipc-contract.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { Translator } from '@shared/i18n/index.js';
import type { OpenDocument } from '../store/documents.js';
import { Editor } from '../editor/Editor.js';
import { Preview } from '../preview/index.js';
import { Sidebar } from '../sidebar/index.js';
import { StatsPanel } from '../stats/index.js';
import { Timeline } from '../timeline/index.js';
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
  onFocusModeChange: (enabled: boolean) => void;
  onTypewriterModeChange: (enabled: boolean) => void;
  onSceneNumbersChange: (enabled: boolean) => void;
  onThemeChange: (theme: AppSettings['theme']) => void;
  onEditorChange: (content: string) => void;
  onCursorOffset: (offset: number) => void;
  onEditorScroll: (offset: number) => void;
  onPreviewScroll: (offset: number) => void;
  onViewReady: EditorParameters['onViewReady'];
  onResizePreview: (width: number) => void;
  onPreviewSync: (enabled: boolean) => void;
  onRightPanelTab: (tab: 'preview' | 'statistics') => void;
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
  onFocusModeChange,
  onTypewriterModeChange,
  onSceneNumbersChange,
  onThemeChange,
  onEditorChange,
  onCursorOffset,
  onEditorScroll,
  onPreviewScroll,
  onViewReady,
  onResizePreview,
  onPreviewSync,
  onRightPanelTab,
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
        <button type="button" className="tab-new" aria-label={t('tab.new')} onClick={onNewDocument}>
          +
        </button>
        <div className="topbar-actions" role="toolbar" aria-label={t('toolbar.modes')}>
          <button
            type="button"
            className={`topbar-mode${settings.focusMode ? ' is-active' : ''}`}
            aria-pressed={settings.focusMode}
            title={t('toolbar.focusHint')}
            onClick={() => onFocusModeChange(!settings.focusMode)}
          >
            <span aria-hidden="true">◎</span>
            {t('toolbar.focus')}
          </button>
          <button
            type="button"
            className={`topbar-mode${settings.typewriterMode ? ' is-active' : ''}`}
            aria-pressed={settings.typewriterMode}
            title={t('toolbar.typewriterHint')}
            onClick={() => onTypewriterModeChange(!settings.typewriterMode)}
          >
            <span aria-hidden="true">⌨</span>
            {t('toolbar.typewriter')}
          </button>
          <button
            type="button"
            className={`topbar-mode topbar-scene-numbers${
              settings.showSceneNumbers ? ' is-active' : ''
            }`}
            aria-pressed={settings.showSceneNumbers}
            title={t('menu.view.showSceneNumbers')}
            onClick={() => onSceneNumbersChange(!settings.showSceneNumbers)}
          >
            <span aria-hidden="true">#</span>
            {t('toolbar.sceneNumbers')}
          </button>
          <div className="topbar-theme" role="group" aria-label={t('toolbar.theme')}>
            <span>{t('toolbar.theme')}</span>
            {(
              [
                ['system', '◐', t('menu.view.themeSystem')],
                ['light', '☀', t('menu.view.themeLight')],
                ['dark', '☾', t('menu.view.themeDark')],
              ] as const
            ).map(([theme, icon, label]) => (
              <button
                type="button"
                key={theme}
                className={settings.theme === theme ? 'is-active' : ''}
                aria-label={label}
                aria-pressed={settings.theme === theme}
                title={label}
                onClick={() => onThemeChange(theme)}
              >
                <span aria-hidden="true">{icon}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {settings.focusMode ? (
        <button type="button" className="focus-mode-exit" onClick={() => onFocusModeChange(false)}>
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
                  <div
                    className="workspace-preview"
                    style={{ width: active.appData.preview.width }}
                  >
                    {active.appData.preview.activeTab === 'statistics' ? (
                      <StatsPanel
                        statistics={analysis?.statistics ?? null}
                        minutesPerPage={settings.minutesPerPage}
                        onShowPreview={() => onRightPanelTab('preview')}
                        onExport={onExportStats}
                        onMinutesPerPage={onMinutesPerPage}
                        onClose={onClosePreview}
                      />
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
                        onShowStatistics={() => onRightPanelTab('statistics')}
                        onClose={onClosePreview}
                      />
                    )}
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
