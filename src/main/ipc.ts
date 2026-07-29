import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename } from 'node:path';
import type { DocumentSnapshot, IpcChannel, IpcRequests } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';
import { clearAutosave, pendingAutosaves, writeAutosave } from './files/autosave.js';
import { fileExists, readDocument, saveDocument } from './files/document.js';
import { buildMenu } from './menu.js';
import { applySpellCheckerLanguage } from './spellcheck.js';
import {
  addRecent,
  clearRecent,
  getSettings,
  getTranslator,
  listRecent,
  patchSettings,
} from './store.js';

/**
 * IPC handler registration, typed by the shared contract.
 *
 * `handle` ties the channel key, the argument type and the result type together: a
 * signature that drifts from the contract does not compile.
 */
function handle<C extends IpcChannel>(
  channel: C,
  listener: (
    arg: IpcRequests[C]['arg'],
    window: BrowserWindow | null,
  ) => Promise<IpcRequests[C]['result']> | IpcRequests[C]['result'],
): void {
  ipcMain.handle(channel, (event, arg) =>
    listener(arg as IpcRequests[C]['arg'], BrowserWindow.fromWebContents(event.sender)),
  );
}

/** File-type filters for the native dialogs, in the interface language. */
function fountainFilters(t: Translator['t']) {
  return [
    { name: t('dialog.filter.fountain'), extensions: ['fountain'] },
    { name: t('dialog.filter.text'), extensions: ['txt'] },
    { name: t('dialog.filter.all'), extensions: ['*'] },
  ];
}

export async function openPaths(paths: string[]): Promise<DocumentSnapshot[]> {
  const documents: DocumentSnapshot[] = [];
  const { t } = await getTranslator();

  for (const path of paths) {
    try {
      const snapshot = await readDocument(path);
      documents.push(snapshot);
      await addRecent(path);
    } catch (error) {
      dialog.showErrorBox(
        t('dialog.openError.title'),
        t('dialog.openError.body', {
          name: basename(path),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return documents;
}

export function registerIpcHandlers(): void {
  handle('dialog:pickOpen', async (_arg, window) => {
    const { t } = await getTranslator();
    const options = {
      title: t('dialog.open.title'),
      filters: fountainFilters(t),
      properties: ['openFile' as const, 'multiSelections' as const],
    };
    // Dialogs are modal to the window when there is one, application-wide otherwise.
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return openPaths(result.filePaths);
  });

  handle('dialog:pickSaveAs', async ({ suggestedName }, window) => {
    const { t } = await getTranslator();
    const options = {
      title: t('dialog.save.title'),
      defaultPath: suggestedName,
      filters: fountainFilters(t),
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  handle('dialog:confirmDiscard', async ({ name }, window) => {
    const { t } = await getTranslator();
    const options = {
      type: 'warning' as const,
      buttons: [t('dialog.discard.save'), t('dialog.discard.dontSave'), t('dialog.discard.cancel')],
      defaultId: 0,
      cancelId: 2,
      message: t('dialog.discard.message', { name }),
      detail: t('dialog.discard.detail'),
    };
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
  });

  handle('file:read', ({ path }) => readDocument(path));

  handle('file:save', async (request) => {
    const settings = await getSettings();
    const outcome = await saveDocument(request, settings.backupCount);
    if (outcome.status === 'saved') {
      await addRecent(outcome.path);
      // The recent-files submenu is part of the native menu, so it has to be rebuilt.
      await buildMenu();
    }
    return outcome;
  });

  handle('file:exists', ({ path }) => fileExists(path));

  handle('recent:list', () => listRecent());
  handle('recent:clear', async () => {
    await clearRecent();
    await buildMenu();
  });

  handle('settings:get', () => getSettings());
  handle('settings:patch', async (patch) => {
    const before = await getSettings();
    const next = await patchSettings(patch);

    // Language changes retranslate the menu; the view toggles drive its checkboxes.
    if (
      before.language !== next.language ||
      before.showNotes !== next.showNotes ||
      before.showSynopses !== next.showSynopses ||
      before.showSections !== next.showSections
    ) {
      await buildMenu();
    }
    if (before.language !== next.language) {
      applySpellCheckerLanguage(next.language);
    }

    // Settings are global: every window is notified, the caller included. That makes
    // this event the single path by which the interface learns about a settings change,
    // whatever triggered it — renderer, native menu, or a future preferences window.
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('app:settingsChanged', { settings: next });
    }

    return next;
  });

  handle('autosave:write', ({ id, path, content }) => writeAutosave(id, path, content));
  handle('autosave:clear', ({ id }) => clearAutosave(id));
  handle('autosave:pending', () => pendingAutosaves());

  handle('window:setDirty', async ({ dirty, name }, window) => {
    if (!window) return;
    const { t } = await getTranslator();
    window.setTitle(`${dirty ? '• ' : ''}${t('window.title', { name })}`);
    // On macOS the close button also shows the unsaved state.
    window.setDocumentEdited(dirty);
  });

  handle('shell:showItemInFolder', ({ path }) => {
    shell.showItemInFolder(path);
  });
}
