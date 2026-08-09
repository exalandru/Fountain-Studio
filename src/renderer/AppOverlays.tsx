import type { InconsistencyState, RewriteState } from '@shared/appdata/index.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { MenuCommand } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';
import type { PendingWrites } from '@shared/persistence/PendingWrites.js';
import type { DocumentOperationContext } from '@shared/documents/operations.js';
import type { OpenDocument } from './store/documents.js';
import { AiSettingsDialog } from './ai/AiSettingsDialog.js';
import { CharacterNameDialog } from './ai/CharacterNameDialog.js';
import type { CharacterNameSelection } from './ai/CharacterNameDialog.js';
import { InconsistencyPanel } from './ai/InconsistencyPanel.js';
import { RewriteDialog } from './ai/RewriteDialog.js';
import type { RewriteSelection } from './ai/RewriteDialog.js';
import { VoiceConsistencyPanel } from './ai/VoiceConsistencyPanel.js';
import { BiblePanel } from './bible/BiblePanel.js';
import { PdfExportDialog } from './pdf/PdfExportDialog.js';
import { RepetitionPanel } from './repetition/RepetitionPanel.js';
import { SnapshotDialog } from './snapshots/SnapshotDialog.js';
import { CommandPalette } from './ui/CommandPalette.js';
import type { PaletteCommand } from './ui/CommandPalette.js';
import { EditorContextMenu } from './ui/EditorContextMenu.js';

export interface AppOverlaysProps {
  active: OpenDocument | null;
  analysis: ParseResponse | null;
  locale: 'en' | 'fr';
  t: Translator['t'];
  setStatus: (message: string) => void;
  /** Used for error messages that should appear with the warning style. */
  setStatusError: (message: string) => void;
  pendingWrites: PendingWrites;
  executeCommand: (command: MenuCommand) => void;
  paletteCommands: PaletteCommand[];
  pdfOpen: boolean;
  pdfDate: string;
  setPdfOpen: (open: boolean) => void;
  bibleOpen: boolean;
  setBibleOpen: (open: boolean) => void;
  snapshotsOpen: boolean;
  setSnapshotsOpen: (open: boolean) => void;
  aiSettingsOpen: boolean;
  setAiSettingsOpen: (open: boolean) => void;
  setAiSettingsRevision: (update: (revision: number) => number) => void;
  inconsistencyOpen: boolean;
  setInconsistencyOpen: (open: boolean) => void;
  voiceConsistencyOpen: boolean;
  setVoiceConsistencyOpen: (open: boolean) => void;
  repetitionsOpen: boolean;
  setRepetitionsOpen: (open: boolean) => void;
  rewriteSelection: RewriteSelection | null;
  setRewriteSelection: (selection: RewriteSelection | null) => void;
  characterNameSelection: CharacterNameSelection | null;
  setCharacterNameSelection: (selection: CharacterNameSelection | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  updateRewrite: (documentId: string, rewrite: RewriteState) => void;
  updateInconsistencies: (documentId: string, state: InconsistencyState) => void;
  updateVoiceConsistency: (
    documentId: string,
    characterName: string,
    state: InconsistencyState,
  ) => void;
  updateRepetitions: (documentId: string, state: InconsistencyState) => void;
  commitInconsistencies: (
    operation: DocumentOperationContext,
    state: InconsistencyState,
  ) => boolean;
  commitVoiceConsistency: (
    operation: DocumentOperationContext,
    characterName: string,
    state: InconsistencyState,
  ) => boolean;
  commitRepetitions: (operation: DocumentOperationContext, state: InconsistencyState) => boolean;
  selectInconsistencyReference: (reference: { sceneNumber: string; heading: string }) => void;
  selectEditorRange: (range: { from: number; to: number }) => void;
  replaceEditorRange: (selection: RewriteSelection, content: string) => boolean;
  renameCharacter: (selection: CharacterNameSelection, nextName: string) => boolean;
  restoreSnapshot: (operation: DocumentOperationContext, content: string) => boolean;
  openSynonyms: () => void;
  openRewriteSelection: () => void;
  openRenameCharacter: () => void;
}

/**
 * Modal dialogs and floating panels owned by the application shell.
 *
 * Extracted from App so the shell can stay an orchestrator of hooks rather than a
 * thousand-line JSX tree.
 */
export function AppOverlays({
  active,
  analysis,
  locale,
  t,
  setStatus,
  setStatusError,
  pendingWrites,
  executeCommand,
  paletteCommands,
  pdfOpen,
  pdfDate,
  setPdfOpen,
  bibleOpen,
  setBibleOpen,
  snapshotsOpen,
  setSnapshotsOpen,
  aiSettingsOpen,
  setAiSettingsOpen,
  setAiSettingsRevision,
  inconsistencyOpen,
  setInconsistencyOpen,
  voiceConsistencyOpen,
  setVoiceConsistencyOpen,
  repetitionsOpen,
  setRepetitionsOpen,
  rewriteSelection,
  setRewriteSelection,
  characterNameSelection,
  setCharacterNameSelection,
  paletteOpen,
  setPaletteOpen,
  updateRewrite,
  updateInconsistencies,
  updateVoiceConsistency,
  updateRepetitions,
  commitInconsistencies,
  commitVoiceConsistency,
  commitRepetitions,
  selectInconsistencyReference,
  selectEditorRange,
  replaceEditorRange,
  renameCharacter,
  restoreSnapshot,
  openSynonyms,
  openRewriteSelection,
  openRenameCharacter,
}: AppOverlaysProps) {
  const exactAnalysis =
    active && analysis?.id === active.id && analysis.revision === active.revision ? analysis : null;

  return (
    <>
      {pdfOpen && active ? (
        <PdfExportDialog
          key={active.id}
          documentId={active.id}
          documentRevision={active.revision}
          source={active.content}
          suggestedName={`${active.name.replace(/\.(fountain|txt)$/i, '')}.pdf`}
          path={active.path}
          revision={active.appData.revision}
          issueDate={pdfDate}
          onExported={(path) => {
            setStatus(t('status.exported', { path }));
            setPdfOpen(false);
          }}
          onError={(error) => setStatusError(t('status.exportFailed', { error }))}
          onClose={() => setPdfOpen(false)}
        />
      ) : null}
      {bibleOpen && active ? (
        <BiblePanel
          key={active.id}
          documentId={active.id}
          documentRevision={active.revision}
          path={active.path}
          analysis={exactAnalysis}
          t={t}
          pendingWrites={pendingWrites}
          onPersistenceError={setStatusError}
          onClose={() => setBibleOpen(false)}
        />
      ) : null}
      {snapshotsOpen && active ? (
        <SnapshotDialog
          key={`${active.id}:${active.path ?? ''}`}
          documentId={active.id}
          documentRevision={active.revision}
          path={active.path}
          currentContent={active.content}
          t={t}
          onRestore={(content, name, operation) => {
            if (!restoreSnapshot(operation, content)) return false;
            setSnapshotsOpen(false);
            setStatus(t('snapshots.restored', { name }));
            return true;
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
          key={active.id}
          documentId={active.id}
          documentRevision={active.revision}
          screenplay={active.content}
          analysis={exactAnalysis}
          state={active.appData.inconsistencies}
          t={t}
          locale={locale}
          onStateChange={(state) => updateInconsistencies(active.id, state)}
          onAnalysisResult={commitInconsistencies}
          onSelectReference={(reference) => {
            selectInconsistencyReference(reference);
            setInconsistencyOpen(false);
          }}
          onClose={() => setInconsistencyOpen(false)}
        />
      ) : null}
      {voiceConsistencyOpen && active ? (
        <VoiceConsistencyPanel
          key={active.id}
          documentId={active.id}
          documentRevision={active.revision}
          screenplay={active.content}
          analysis={exactAnalysis}
          state={active.appData.voiceConsistency}
          t={t}
          locale={locale}
          onStateChange={(characterName, state) =>
            updateVoiceConsistency(active.id, characterName, state)
          }
          onAnalysisResult={commitVoiceConsistency}
          onSelectReference={(reference) => {
            selectInconsistencyReference(reference);
            setVoiceConsistencyOpen(false);
          }}
          onClose={() => setVoiceConsistencyOpen(false)}
        />
      ) : null}
      {repetitionsOpen && active ? (
        <RepetitionPanel
          key={active.id}
          documentId={active.id}
          documentRevision={active.revision}
          screenplay={active.content}
          analysis={exactAnalysis}
          state={active.appData.repetitions}
          t={t}
          locale={locale}
          onStateChange={(state) => updateRepetitions(active.id, state)}
          onAnalysisResult={commitRepetitions}
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
      {rewriteSelection && active?.id === rewriteSelection.operation.documentId ? (
        <RewriteDialog
          key={rewriteSelection.operation.requestId}
          selection={rewriteSelection}
          state={active.appData.rewrite}
          onStateChange={(state) => updateRewrite(rewriteSelection.operation.documentId, state)}
          onReplace={replaceEditorRange}
          onClose={() => setRewriteSelection(null)}
        />
      ) : null}
      {characterNameSelection && active?.id === characterNameSelection.operation.documentId ? (
        <CharacterNameDialog
          key={characterNameSelection.operation.requestId}
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
