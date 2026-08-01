import { isolateHistory } from '@codemirror/commands';
import type { RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import type { InconsistencyState, RewriteState } from '@shared/appdata/index.js';
import type { ParseResponse } from '@shared/analysis/index.js';
import type { MenuCommand } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';
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
  editorView: RefObject<EditorView | null>;
  locale: 'en' | 'fr';
  t: Translator['t'];
  setStatus: (message: string) => void;
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
  updateRewrite: (rewrite: RewriteState) => void;
  updateInconsistencies: (state: InconsistencyState) => void;
  updateVoiceConsistency: (characterName: string, state: InconsistencyState) => void;
  updateRepetitions: (state: InconsistencyState) => void;
  selectInconsistencyReference: (reference: { sceneNumber: string; heading: string }) => void;
  selectEditorRange: (range: { from: number; to: number }) => void;
  replaceEditorRange: (from: number, to: number, content: string) => void;
  renameCharacter: (nextName: string) => void;
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
  editorView,
  locale,
  t,
  setStatus,
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
  selectInconsistencyReference,
  selectEditorRange,
  replaceEditorRange,
  renameCharacter,
  openSynonyms,
  openRewriteSelection,
  openRenameCharacter,
}: AppOverlaysProps) {
  return (
    <>
      {pdfOpen && active ? (
        <PdfExportDialog
          source={active.content}
          suggestedName={`${active.name.replace(/\.(fountain|txt)$/i, '')}.pdf`}
          path={active.path}
          revision={active.appData.revision}
          issueDate={pdfDate}
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
          locale={locale}
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
          locale={locale}
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
          locale={locale}
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
