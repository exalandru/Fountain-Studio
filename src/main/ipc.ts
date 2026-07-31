import { readFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { basename, extname, isAbsolute, join } from 'node:path';
import { parseAppData } from '@shared/appdata/index.js';
import type { AiConnectionProfile } from '@shared/ai/index.js';
import { isProviderKind } from '@shared/ai/providers/index.js';
import { isBibleId } from '@shared/bible/index.js';
import { isSnapshotId, MAX_SNAPSHOT_NAME } from '@shared/snapshots/index.js';
import { isRevisionColour } from '@shared/revision/index.js';
import {
  deleteBibleImage,
  readBible,
  readBibleImage,
  writeBible,
  writeBibleImage,
} from './files/bible.js';
import type { DocumentSnapshot, IpcChannel, IpcRequests } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';
import { clearAutosave, pendingAutosaves, writeAutosave } from './files/autosave.js';
import { readAppData, writeAppData } from './files/appdata.js';
import { readDocument, saveDocument } from './files/document.js';
import { writeFileAtomic } from './files/atomic.js';
import { buildMenu } from './menu.js';
import { applySpellCheckerLanguage } from './spellcheck.js';
import { resolveCloseDecision } from './window-lifecycle.js';
import { renderScreenplayPdf } from './pdf/render.js';
import { addRecent, getSettings, getTranslator, patchSettings } from './store.js';
import { cancelAiChat, listAiModels, startAiChat, testAiConnection } from './ai/proxy.js';
import { getAiConfigView, saveAiConfig } from './ai/settings.js';
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  readSnapshot,
  renameSnapshot,
} from './files/snapshots.js';

/**
 * IPC handler registration, typed by the shared contract.
 *
 * `handle` ties the channel key, the argument type and the result type together: a
 * signature that drifts from the contract does not compile.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 32_768 && isAbsolute(value)
  );
}

function validMtime(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function pdfResourcesDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources')
    : join(import.meta.dirname, '../../resources');
}

/**
 * Revision options as they cross the IPC.
 *
 * The colour is checked against the known list rather than trusted: it selects a fill colour,
 * and the one thing the main process must never do is paint with a string it was handed.
 */
function validPdfRevision(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value['baselineSource'] === 'string' &&
    value['baselineSource'].length <= 100_000_000 &&
    typeof value['header'] === 'string' &&
    value['header'].length <= 200 &&
    isRevisionColour(value['colour']) &&
    (value['colourMode'] === 'header' ||
      value['colourMode'] === 'page' ||
      value['colourMode'] === 'both') &&
    typeof value['marks'] === 'boolean' &&
    typeof value['lockedPages'] === 'boolean' &&
    typeof value['onlyRevisedPages'] === 'boolean'
  );
}

function validPdfOptions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const page = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 1 &&
      candidate <= 100_000);
  return (
    (value['format'] === 'letter' || value['format'] === 'a4') &&
    (value['sceneNumbers'] === 'none' ||
      value['sceneNumbers'] === 'left' ||
      value['sceneNumbers'] === 'right' ||
      value['sceneNumbers'] === 'both') &&
    typeof value['includeNotes'] === 'boolean' &&
    typeof value['includeSynopses'] === 'boolean' &&
    typeof value['headingsBold'] === 'boolean' &&
    typeof value['watermark'] === 'string' &&
    value['watermark'].length <= 200 &&
    page(value['pageFrom']) &&
    page(value['pageTo']) &&
    validPdfRevision(value['revision'])
  );
}

function validSnapshotName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SNAPSHOT_NAME;
}

function validAiProfile(value: unknown): value is AiConnectionProfile {
  if (!isRecord(value)) return false;
  let validUrl = false;
  if (typeof value['baseUrl'] === 'string' && value['baseUrl'].length <= 2_000) {
    try {
      const url = new URL(value['baseUrl']);
      validUrl =
        (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch {
      validUrl = false;
    }
  }
  return (
    typeof value['id'] === 'string' &&
    /^[A-Za-z0-9_-]{1,80}$/.test(value['id']) &&
    typeof value['name'] === 'string' &&
    value['name'].length > 0 &&
    value['name'].length <= 80 &&
    // Absent on profiles saved before multi-provider support; the sanitizer then
    // resolves it to the OpenAI-compatible default.
    (value['provider'] === undefined || isProviderKind(value['provider'])) &&
    validUrl &&
    typeof value['model'] === 'string' &&
    value['model'].length > 0 &&
    value['model'].length <= 200 &&
    typeof value['timeoutMs'] === 'number' &&
    Number.isInteger(value['timeoutMs']) &&
    value['timeoutMs'] >= 1_000 &&
    value['timeoutMs'] <= 600_000 &&
    typeof value['maxTokens'] === 'number' &&
    Number.isInteger(value['maxTokens']) &&
    value['maxTokens'] >= 64 &&
    value['maxTokens'] <= 200_000 &&
    typeof value['reasoningEnabled'] === 'boolean'
  );
}

function validAiConfig(value: unknown): boolean {
  if (!isRecord(value) || value['version'] !== 1) return false;
  if (
    typeof value['activeProfileId'] !== 'string' ||
    !Array.isArray(value['profiles']) ||
    value['profiles'].length < 1 ||
    value['profiles'].length > 10 ||
    !value['profiles'].every(validAiProfile)
  ) {
    return false;
  }
  const ids = value['profiles'].map((profile) => profile.id);
  return new Set(ids).size === ids.length && ids.includes(value['activeProfileId']);
}

function validAiMessages(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every(
      (message) =>
        isRecord(message) &&
        (message['role'] === 'user' || message['role'] === 'assistant') &&
        typeof message['content'] === 'string' &&
        message['content'].length <= 1_000_000,
    )
  );
}

function validateRequest<C extends IpcChannel>(channel: C, value: unknown): IpcRequests[C]['arg'] {
  const record = isRecord(value) ? value : null;
  let valid = false;

  switch (channel) {
    case 'dialog:pickOpen':
    case 'settings:get':
    case 'ai:config:get':
    case 'autosave:pending':
      valid = value === undefined;
      break;
    case 'dialog:pickSaveAs':
      valid =
        record !== null &&
        typeof record['suggestedName'] === 'string' &&
        record['suggestedName'].length <= 255;
      break;
    case 'dialog:confirmDiscard':
      valid = record !== null && typeof record['name'] === 'string' && record['name'].length <= 255;
      break;
    case 'appdata:read':
      valid = record !== null && validPath(record['path']);
      break;
    case 'bible:read':
      valid = record !== null && validPath(record['path']);
      break;
    case 'bible:imagePick':
      valid = true;
      break;
    case 'bible:imageRead':
    case 'bible:imageDelete':
      valid = record !== null && validPath(record['path']) && isBibleId(record['id']);
      break;
    case 'bible:imageWrite':
      // Only the envelope: the format and the size are the main side's call, in
      // writeBibleImage, which is the single authority on what may reach the disk.
      valid =
        record !== null &&
        validPath(record['path']) &&
        isBibleId(record['id']) &&
        typeof record['dataUri'] === 'string' &&
        record['dataUri'].startsWith('data:image/') &&
        record['dataUri'].length <= 4_000_000;
      break;
    case 'bible:write':
      // Only the envelope is checked here. What a bible may contain is decided by
      // parseBible, which the main side runs on the way in — one authority, not two.
      valid =
        record !== null &&
        validPath(record['path']) &&
        typeof record['bible'] === 'object' &&
        record['bible'] !== null;
      break;
    case 'file:openPaths':
      valid =
        record !== null &&
        Array.isArray(record['paths']) &&
        record['paths'].length <= 100 &&
        record['paths'].every(validPath);
      break;
    case 'file:save':
      valid =
        record !== null &&
        validPath(record['path']) &&
        typeof record['content'] === 'string' &&
        record['content'].length <= 100_000_000 &&
        (record['eol'] === 'lf' || record['eol'] === 'crlf') &&
        validMtime(record['expectedMtimeMs']) &&
        (record['refuseExisting'] === undefined || typeof record['refuseExisting'] === 'boolean');
      break;
    case 'file:exportText':
      valid =
        record !== null &&
        typeof record['suggestedName'] === 'string' &&
        record['suggestedName'].length > 0 &&
        record['suggestedName'].length <= 255 &&
        typeof record['content'] === 'string' &&
        record['content'].length <= 10_000_000 &&
        (record['format'] === 'csv' || record['format'] === 'json');
      break;
    case 'pdf:render':
      valid =
        record !== null &&
        typeof record['source'] === 'string' &&
        record['source'].length <= 100_000_000 &&
        validPdfOptions(record['options']);
      break;
    case 'pdf:export':
      valid =
        record !== null &&
        typeof record['source'] === 'string' &&
        record['source'].length <= 100_000_000 &&
        typeof record['suggestedName'] === 'string' &&
        record['suggestedName'].length > 0 &&
        record['suggestedName'].length <= 255 &&
        validPdfOptions(record['options']);
      break;
    case 'snapshot:list':
      valid = record !== null && validPath(record['path']);
      break;
    case 'snapshot:create':
      valid =
        record !== null &&
        validPath(record['path']) &&
        validSnapshotName(record['name']) &&
        typeof record['content'] === 'string' &&
        record['content'].length <= 100_000_000;
      break;
    case 'snapshot:read':
    case 'snapshot:delete':
      valid = record !== null && validPath(record['path']) && isSnapshotId(record['id']);
      break;
    case 'snapshot:rename':
      valid =
        record !== null &&
        validPath(record['path']) &&
        isSnapshotId(record['id']) &&
        validSnapshotName(record['name']);
      break;
    case 'settings:patch':
      valid = record !== null;
      break;
    case 'ai:config:save':
      valid =
        record !== null &&
        validAiConfig(record['config']) &&
        Array.isArray(record['keyUpdates']) &&
        record['keyUpdates'].length <= 10 &&
        record['keyUpdates'].every(
          (update) =>
            isRecord(update) &&
            typeof update['profileId'] === 'string' &&
            /^[A-Za-z0-9_-]{1,80}$/.test(update['profileId']) &&
            (update['key'] === null ||
              (typeof update['key'] === 'string' && update['key'].length <= 20_000)),
        );
      break;
    case 'ai:models:list':
    case 'ai:connection:test':
      valid =
        record !== null &&
        validAiProfile(record['profile']) &&
        (record['apiKey'] === null ||
          (typeof record['apiKey'] === 'string' && record['apiKey'].length <= 20_000));
      break;
    case 'ai:chat:start':
      valid =
        record !== null &&
        typeof record['requestId'] === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(record['requestId']) &&
        typeof record['profileId'] === 'string' &&
        /^[A-Za-z0-9_-]{1,80}$/.test(record['profileId']) &&
        (record['mode'] === 'factual' || record['mode'] === 'creative') &&
        typeof record['systemPrompt'] === 'string' &&
        record['systemPrompt'].length > 0 &&
        record['systemPrompt'].length <= 20_000 &&
        (record['temperature'] === undefined ||
          (typeof record['temperature'] === 'number' &&
            Number.isFinite(record['temperature']) &&
            record['temperature'] >= 0 &&
            record['temperature'] <= 2)) &&
        (record['reasoning'] === undefined ||
          record['reasoning'] === 'profile' ||
          record['reasoning'] === 'disabled') &&
        validAiMessages(record['messages']);
      break;
    case 'ai:chat:cancel':
      valid =
        record !== null &&
        typeof record['requestId'] === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(record['requestId']);
      break;
    case 'editor:contextAction':
      valid =
        record !== null &&
        (record['action'] === 'replaceMisspelling' ||
          record['action'] === 'addToDictionary' ||
          record['action'] === 'undo' ||
          record['action'] === 'redo' ||
          record['action'] === 'cut' ||
          record['action'] === 'copy' ||
          record['action'] === 'paste' ||
          record['action'] === 'selectAll') &&
        (record['value'] === undefined ||
          (typeof record['value'] === 'string' && record['value'].length <= 200));
      break;
    case 'autosave:write':
      valid =
        record !== null &&
        typeof record['id'] === 'string' &&
        record['id'].length > 0 &&
        record['id'].length <= 200 &&
        (record['path'] === null || validPath(record['path'])) &&
        typeof record['content'] === 'string' &&
        record['content'].length <= 100_000_000 &&
        (record['eol'] === 'lf' || record['eol'] === 'crlf') &&
        validMtime(record['mtimeMs']);
      break;
    case 'autosave:clear':
      valid =
        record !== null &&
        typeof record['id'] === 'string' &&
        record['id'].length > 0 &&
        record['id'].length <= 200;
      break;
    case 'window:setDirty':
      valid =
        record !== null &&
        typeof record['dirty'] === 'boolean' &&
        typeof record['name'] === 'string' &&
        record['name'].length <= 255;
      break;
    case 'window:closeDecision':
      valid = record !== null && typeof record['proceed'] === 'boolean';
      break;
    case 'appdata:write':
      valid =
        record !== null &&
        validPath(record['path']) &&
        (() => {
          try {
            return parseAppData(JSON.stringify(record['data'])) !== null;
          } catch {
            return false;
          }
        })();
      break;
  }

  if (!valid) throw new TypeError(`Invalid payload for IPC channel "${channel}"`);
  return value as IpcRequests[C]['arg'];
}

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  if (event.senderFrame !== event.sender.mainFrame) return false;

  try {
    const actual = new URL(event.senderFrame.url);
    if (actual.protocol === 'file:') return true;

    const developmentUrl = process.env['ELECTRON_RENDERER_URL'];
    return Boolean(developmentUrl && actual.origin === new URL(developmentUrl).origin);
  } catch {
    return false;
  }
}

function handle<C extends IpcChannel>(
  channel: C,
  listener: (
    arg: IpcRequests[C]['arg'],
    window: BrowserWindow | null,
  ) => Promise<IpcRequests[C]['result']> | IpcRequests[C]['result'],
): void {
  ipcMain.handle(channel, (event, arg: unknown) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted IPC sender');
    return listener(validateRequest(channel, arg), BrowserWindow.fromWebContents(event.sender));
  });
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
  if (documents.length > 0) await buildMenu();

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

  handle('file:openPaths', ({ paths }) => openPaths(paths));

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

  handle('file:exportText', async ({ suggestedName, content, format }, window) => {
    const options = {
      defaultPath: suggestedName,
      filters: [
        {
          name: format === 'csv' ? 'CSV' : 'JSON',
          extensions: [format],
        },
      ],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { status: 'cancelled' };

    try {
      await writeFileAtomic(result.filePath, content);
      return { status: 'exported', path: result.filePath };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  handle('pdf:render', async ({ source, options }) => {
    const rendered = await renderScreenplayPdf(source, options, pdfResourcesDirectory());
    const { bytes } = rendered;
    return {
      pageCount: rendered.pageCount,
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    };
  });

  handle('pdf:export', async ({ source, options, suggestedName }, window) => {
    const result = window
      ? await dialog.showSaveDialog(window, {
          defaultPath: suggestedName,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        })
      : await dialog.showSaveDialog({
          defaultPath: suggestedName,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
    if (result.canceled || !result.filePath) return { status: 'cancelled' };

    try {
      const rendered = await renderScreenplayPdf(source, options, pdfResourcesDirectory());
      await writeFileAtomic(result.filePath, rendered.bytes);
      shell.showItemInFolder(result.filePath);
      return { status: 'exported', path: result.filePath };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  handle('settings:get', () => getSettings());
  handle('settings:patch', async (patch) => {
    const before = await getSettings();
    const next = await patchSettings(patch);

    // Language changes retranslate the menu; the view toggles drive its checkboxes.
    if (
      before.language !== next.language ||
      before.showNotes !== next.showNotes ||
      before.showBoneyard !== next.showBoneyard ||
      before.showSynopses !== next.showSynopses ||
      before.showSections !== next.showSections ||
      before.showSceneNumbers !== next.showSceneNumbers ||
      before.focusMode !== next.focusMode ||
      before.typewriterMode !== next.typewriterMode ||
      before.theme !== next.theme ||
      before.spellcheckLanguage !== next.spellcheckLanguage
    ) {
      await buildMenu();
    }
    if (before.spellcheckLanguage !== next.spellcheckLanguage) {
      applySpellCheckerLanguage(next.spellcheckLanguage);
    }

    // Settings are global: every window is notified, the caller included. That makes
    // this event the single path by which the interface learns about a settings change,
    // whatever triggered it — renderer, native menu, or a future preferences window.
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('app:settingsChanged', { settings: next });
    }

    return next;
  });

  handle('ai:config:get', () => getAiConfigView());
  handle('ai:config:save', ({ config, keyUpdates }) => saveAiConfig(config, keyUpdates));
  handle('ai:models:list', ({ profile, apiKey }) => listAiModels(profile, apiKey ?? undefined));
  handle('ai:connection:test', ({ profile, apiKey }) =>
    testAiConnection(profile, apiKey ?? undefined),
  );
  handle('ai:chat:start', (request, window) => {
    if (!window) throw new Error('AI chat requires a renderer window');
    startAiChat(window, request);
  });
  handle('ai:chat:cancel', ({ requestId }) => cancelAiChat(requestId));

  handle('snapshot:list', ({ path }) => listSnapshots(path));
  handle('snapshot:create', ({ path, name, content }) => createSnapshot(path, name, content));
  handle('snapshot:read', ({ path, id }) => readSnapshot(path, id));
  handle('snapshot:rename', ({ path, id, name }) => renameSnapshot(path, id, name));
  handle('snapshot:delete', ({ path, id }) => deleteSnapshot(path, id));
  handle('editor:contextAction', ({ action, value }, window) => {
    if (!window) return;
    const contents = window.webContents;
    switch (action) {
      case 'replaceMisspelling':
        if (value) contents.replaceMisspelling(value);
        break;
      case 'addToDictionary':
        if (value) contents.session.addWordToSpellCheckerDictionary(value);
        break;
      case 'undo':
        contents.undo();
        break;
      case 'redo':
        contents.redo();
        break;
      case 'cut':
        contents.cut();
        break;
      case 'copy':
        contents.copy();
        break;
      case 'paste':
        contents.paste();
        break;
      case 'selectAll':
        contents.selectAll();
        break;
    }
  });

  handle('autosave:write', ({ id, path, content, eol, mtimeMs }) =>
    writeAutosave(id, path, content, eol, mtimeMs),
  );
  handle('autosave:clear', ({ id }) => clearAutosave(id));
  handle('autosave:pending', () => pendingAutosaves());

  handle('window:setDirty', async ({ dirty, name }, window) => {
    if (!window) return;
    const { t } = await getTranslator();
    window.setTitle(`${dirty ? '• ' : ''}${t('window.title', { name })}`);
    // On macOS the close button also shows the unsaved state.
    window.setDocumentEdited(dirty);
  });
  handle('window:closeDecision', ({ proceed }, window) => {
    resolveCloseDecision(window, proceed);
  });

  handle('appdata:read', ({ path }) => readAppData(path));
  handle('appdata:write', ({ path, data }) => writeAppData(path, data));
  handle('bible:read', ({ path }) => readBible(path));
  handle('bible:write', ({ path, bible }) => writeBible(path, bible));
  handle('bible:imagePick', async (_arg, window) => {
    const { t } = await getTranslator();
    const options = {
      title: t('bible.imagePick'),
      filters: [{ name: t('bible.imageFilter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile' as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const [chosen] = result.filePaths;
    if (result.canceled || chosen === undefined) return null;
    const bytes = await readFile(chosen);
    // Bounded before it reaches the renderer, which will shrink it to 512 pixels anyway. A
    // camera raw file has no business being read into a renderer message.
    if (bytes.byteLength > 12_000_000) throw new Error('image is too large');
    const type = extname(chosen).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    const mime = extname(chosen).toLowerCase() === '.webp' ? 'image/webp' : type;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  });
  handle('bible:imageRead', ({ path, id }) => readBibleImage(path, id));
  handle('bible:imageWrite', ({ path, id, dataUri }) => writeBibleImage(path, id, dataUri));
  handle('bible:imageDelete', ({ path, id }) => deleteBibleImage(path, id));
}
