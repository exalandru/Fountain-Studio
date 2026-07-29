import { BrowserWindow } from 'electron';
import type { AppSettings } from '@shared/ipc-contract.js';

export type SpellcheckLanguage = AppSettings['spellcheckLanguage'];

/**
 * Electron uses the OS checker on macOS and Hunspell dictionaries managed by Chromium
 * on Windows/Linux. macOS accepts one active language, so the preference is singular.
 */
export function applySpellCheckerLanguage(language: SpellcheckLanguage): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const { session } = window.webContents;
    if (session.availableSpellCheckerLanguages.includes(language)) {
      session.setSpellCheckerLanguages([language]);
    }
  }
}

/** Sends Chromium spellcheck data to the renderer's custom context menu. */
export function installSpellcheckContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return;
    event.preventDefault();

    const selected = params.selectionText.trim();
    window.webContents.send('editor:contextMenu', {
      x: params.x,
      y: params.y,
      misspelledWord: params.misspelledWord,
      suggestions: params.dictionarySuggestions.slice(0, 6),
      selectedText: selected,
      singleWord: /^[\p{L}\p{N}_'’-]+$/u.test(selected),
      characterLike:
        selected.length > 0 &&
        selected.length <= 120 &&
        /\p{L}/u.test(selected) &&
        selected === selected.toLocaleUpperCase('fr-FR'),
      editFlags: {
        canUndo: params.editFlags.canUndo,
        canRedo: params.editFlags.canRedo,
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
    });
  });
}
