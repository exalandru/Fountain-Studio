import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData } from '@shared/appdata/index.js';
import { PendingWrites } from '@shared/persistence/PendingWrites.js';
import { statisticsToCsv, statisticsToJson } from '@shared/stats/index.js';
import { AppOverlays } from './AppOverlays.js';
import { useAiEditorActions } from './hooks/useAiEditorActions.js';
import { useAppShellEffects } from './hooks/useAppShellEffects.js';
import { useAutosave } from './hooks/useAutosave.js';
import { useCorkboardActions } from './hooks/useCorkboardActions.js';
import { useDocumentIO } from './hooks/useDocumentIO.js';
import { useEditorChrome } from './hooks/useEditorChrome.js';
import { useFileCommands } from './hooks/useFileCommands.js';
import { useRecovery } from './hooks/useRecovery.js';
import { useRevisionActions } from './hooks/useRevisionActions.js';
import { useScreenplay } from './hooks/useScreenplay.js';
import { useTranslator } from './hooks/useTranslator.js';
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout.js';
import type { NewDocumentStrings } from './store/documents.js';
import { useDocuments } from './store/documents.js';
import type { PaletteCommand } from './ui/CommandPalette.js';
import { Workspace } from './workspace/Workspace.js';

/**
 * Application shell: wires store, hooks and overlays into the workspace.
 */
export function App() {
  const documents = useDocuments((state) => state.documents);
  const activeId = useDocuments((state) => state.activeId);
  const settings = useDocuments((state) => state.settings);
  const store = useDocuments.getState;
  const { t, locale } = useTranslator();
  /*
   * The footer message carries its own severity and clears itself.
   *
   * Neither was true before: an export failure read as a neutral note, and every message
   * stayed for the rest of the session.
   */
  type StatusInfo = { text: string; tone: 'info' | 'error' };
  const [statusObj, setStatusObj] = useState<StatusInfo | null>(null);

  const setStatus = useCallback((text: string) => setStatusObj({ text, tone: 'info' }), []);
  const setStatusError = useCallback((text: string) => setStatusObj({ text, tone: 'error' }), []);
  const [pendingWrites] = useState(() => new PendingWrites());

  useEffect(() => {
    if (!statusObj) return undefined;
    const timer = window.setTimeout(() => setStatusObj(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [statusObj]);

  const active = documents.find((d) => d.id === activeId) ?? null;
  const anyDirty = documents.some((document) => document.dirty);
  const activeName = active?.name ?? null;
  const analysis = useScreenplay(
    active?.id ?? null,
    active?.content ?? '',
    active?.revision ?? 0,
    settings.minutesPerPage,
  );

  const documentStrings = useMemo<NewDocumentStrings>(
    () => ({
      untitled: t('document.untitled'),
      titleValue: t('template.titleValue'),
      creditValue: t('template.creditValue'),
      recovered: t('document.recovered'),
    }),
    [t],
  );
  const stringsRef = useRef(documentStrings);
  useEffect(() => {
    stringsRef.current = documentStrings;
  }, [documentStrings]);

  const { closeTab, openDialog, openDropped, save } = useDocumentIO({
    locale,
    t,
    stringsRef,
    setStatus,
    setStatusError,
    pendingWrites,
  });

  useRecovery({ stringsRef, setStatus, setStatusError, t });

  const updateAppData = useCallback(
    (update: (current: AppData) => AppData) => {
      const current = store().active();
      if (!current) return;
      store().setAppData(current.id, update(current.appData), true);
    },
    [store],
  );

  const { flushCrashRecovery } = useAutosave({
    documents,
    autosaveSeconds: settings.autosaveSeconds,
    pendingWrites,
    setStatusError,
    t,
  });

  const flushForClose = useCallback(async () => {
    const outcomes = await Promise.allSettled([flushCrashRecovery(), pendingWrites.flush()]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Could not persist all pending data before close');
    }
  }, [flushCrashRecovery, pendingWrites]);
  const onClosePersistenceError = useCallback(
    () => setStatusError(t('status.closePersistenceFailed')),
    [setStatusError, t],
  );

  const { effectiveDark, patchSettings } = useAppShellEffects({
    theme: settings.theme,
    language: settings.language,
    activeName,
    anyDirty,
    save,
    flushForClose,
    onClosePersistenceError,
  });

  const layout = useWorkspaceLayout(updateAppData);
  const chrome = useEditorChrome(activeId, analysis, t, setStatus);
  const corkboard = useCorkboardActions(chrome.editorView, settings.showSynopses, t, setStatus);

  const revision = active?.appData.revision ?? null;
  const locked = revision?.snapshotId != null;
  const revisionActions = useRevisionActions(
    chrome.editorView,
    locked,
    updateAppData,
    t,
    setStatus,
    setStatusError,
  );

  const ai = useAiEditorActions(
    chrome.editorView,
    analysis,
    chrome.selectEditorRange,
    t,
    setStatus,
  );

  const executeCommand = useFileCommands({
    closeTab,
    editorView: chrome.editorView,
    openDialog,
    openDropped,
    onExportPdf: ai.openPdfDialog,
    onOpenSnapshots: ai.openSnapshots,
    onOpenBible: ai.openBible,
    onOpenAiSettings: ai.openAiSettings,
    onOpenInconsistencies: ai.openInconsistencies,
    onOpenVoiceConsistency: ai.openVoiceConsistency,
    onOpenRepetitions: ai.openRepetitions,
    onRewrite: ai.openRewriteSelection,
    onSynonyms: ai.openSynonyms,
    onRenameCharacter: ai.openRenameCharacter,
    onRenumberScenes: revisionActions.numberScenes,
    onRemoveSceneNumbers: revisionActions.removeSceneNumbers,
    onLockProduction: () => void revisionActions.lockForProduction(),
    onIssueRevision: () => void revisionActions.issueRevision(),
    onUnlockProduction: revisionActions.unlockProduction,
    onToggleTimeline: layout.toggleTimeline,
    onToggleCorkboard: layout.toggleCorkboard,
    onCommandPalette: ai.openCommandPalette,
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
      { id: 'scene.renumber', label: t('menu.edit.renumberScenes') },
      { id: 'revision.lock', label: t('menu.edit.lockProduction') },
      { id: 'revision.issue', label: t('menu.edit.issueRevision') },
      { id: 'revision.unlock', label: t('menu.edit.unlockProduction') },
      { id: 'view.toggleTimeline', label: t('menu.view.showTimeline') },
      { id: 'view.toggleCorkboard', label: t('menu.view.corkboard'), shortcut: '⇧⌘B' },
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
        setStatusError(t('status.exportFailed', { error: outcome.message }));
      }
    },
    [analysis, setStatus, setStatusError, store, t],
  );

  const activeSceneId =
    analysis?.scenes.find(
      (scene) => chrome.cursorOffset >= scene.range.from && chrome.cursorOffset <= scene.range.to,
    )?.id ?? null;

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
        editorScrollPosition={chrome.editorScrollPosition}
        effectiveDark={effectiveDark}
        previewScrollPosition={chrome.previewScrollPosition}
        settings={settings}
        status={statusObj}
        revisionColour={locked && revision ? t(`revision.colour.${revision.colour}`) : null}
        t={t}
        onCloseTab={(id) => void closeTab(id)}
        onNewDocument={newDocument}
        onSetActive={setActive}
        onSettingsChange={(patch) => void patchSettings(patch)}
        onEditorChange={chrome.handleEditorChange}
        onCursorOffset={chrome.handleCursorOffset}
        onSelectionRange={chrome.handleSelectionRange}
        onEditorScroll={chrome.handleEditorScroll}
        onPreviewScroll={chrome.handlePreviewScroll}
        onViewReady={chrome.handleViewReady}
        onResizePreview={layout.resizePreview}
        onPreviewSync={layout.setPreviewSync}
        onRightPanelTab={layout.setRightPanelTab}
        formattingActive={chrome.formattingActive}
        onFormatSelection={chrome.formatSelection}
        onOpenInconsistencies={ai.openInconsistencies}
        onOpenVoiceConsistency={ai.openVoiceConsistency}
        onOpenRepetitions={ai.openRepetitions}
        onOpenBible={ai.openBible}
        onExportStats={(format) => void exportStats(format)}
        onMinutesPerPage={(value) => void patchSettings({ minutesPerPage: value })}
        onClosePreview={layout.closePreview}
        onShowPreview={layout.showPreview}
        onResizeSidebar={layout.resizeSidebar}
        onSidebarTab={layout.setSidebarTab}
        onSidebarFilter={layout.setSidebarFilter}
        onSidebarSynopses={layout.setSidebarSynopses}
        onSelectEditorRange={chrome.selectEditorRange}
        onCloseSidebar={layout.closeSidebar}
        onShowSidebar={layout.showSidebar}
        onTimelineState={layout.updateTimeline}
        onCloseTimeline={layout.closeTimeline}
        onShowTimeline={layout.showTimeline}
        onCorkboardState={layout.updateCorkboard}
        onToggleCorkboard={layout.toggleCorkboard}
        onCloseCorkboard={layout.closeCorkboard}
        onMoveScene={corkboard.moveScene}
        onEditSynopsis={corkboard.editSceneSynopsis}
        onUndo={corkboard.undoEdit}
        onRedo={corkboard.redoEdit}
      />
      <AppOverlays
        active={active}
        analysis={analysis}
        locale={locale}
        t={t}
        setStatus={setStatus}
        setStatusError={setStatusError}
        pendingWrites={pendingWrites}
        executeCommand={executeCommand}
        paletteCommands={paletteCommands}
        pdfOpen={ai.pdfOpen}
        pdfDate={ai.pdfDate}
        setPdfOpen={ai.setPdfOpen}
        bibleOpen={ai.bibleOpen}
        setBibleOpen={ai.setBibleOpen}
        snapshotsOpen={ai.snapshotsOpen}
        setSnapshotsOpen={ai.setSnapshotsOpen}
        aiSettingsOpen={ai.aiSettingsOpen}
        setAiSettingsOpen={ai.setAiSettingsOpen}
        setAiSettingsRevision={ai.setAiSettingsRevision}
        inconsistencyOpen={ai.inconsistencyOpen}
        setInconsistencyOpen={ai.setInconsistencyOpen}
        voiceConsistencyOpen={ai.voiceConsistencyOpen}
        setVoiceConsistencyOpen={ai.setVoiceConsistencyOpen}
        repetitionsOpen={ai.repetitionsOpen}
        setRepetitionsOpen={ai.setRepetitionsOpen}
        rewriteSelection={ai.rewriteSelection}
        setRewriteSelection={ai.setRewriteSelection}
        characterNameSelection={ai.characterNameSelection}
        setCharacterNameSelection={ai.setCharacterNameSelection}
        paletteOpen={ai.paletteOpen}
        setPaletteOpen={ai.setPaletteOpen}
        updateRewrite={ai.updateRewrite}
        updateInconsistencies={ai.updateInconsistencies}
        updateVoiceConsistency={ai.updateVoiceConsistency}
        updateRepetitions={ai.updateRepetitions}
        commitInconsistencies={ai.commitInconsistencies}
        commitVoiceConsistency={ai.commitVoiceConsistency}
        commitRepetitions={ai.commitRepetitions}
        selectInconsistencyReference={ai.selectInconsistencyReference}
        selectEditorRange={chrome.selectEditorRange}
        replaceEditorRange={ai.replaceEditorRange}
        renameCharacter={ai.renameCharacter}
        restoreSnapshot={ai.restoreSnapshot}
        openSynonyms={ai.openSynonyms}
        openRewriteSelection={ai.openRewriteSelection}
        openRenameCharacter={ai.openRenameCharacter}
      />
    </>
  );
}
