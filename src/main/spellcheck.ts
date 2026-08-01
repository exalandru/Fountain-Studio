import { BrowserWindow, session } from 'electron';
import type { AppSettings } from '@shared/ipc-contract.js';

export type SpellcheckLanguage = AppSettings['spellcheckLanguage'];

const FALLBACK: SpellcheckLanguage = 'en-US';

/**
 * Picks a language Chromium lists as available.
 *
 * Electron uses the OS checker on macOS and Hunspell dictionaries managed by Chromium
 * on Windows/Linux. macOS accepts one active language, so the preference is singular.
 * When the preferred language is missing from the available list, fall back rather than
 * leaving the checker on an arbitrary default.
 */
function resolveSpellCheckerLanguage(
  preferred: SpellcheckLanguage,
  available: readonly string[],
): SpellcheckLanguage | null {
  if (available.includes(preferred)) return preferred;
  if (preferred !== FALLBACK && available.includes(FALLBACK)) {
    console.warn(
      `[spellcheck] preferred language "${preferred}" is not available; falling back to "${FALLBACK}". Available: ${available.join(', ') || '(none)'}`,
    );
    return FALLBACK;
  }
  console.warn(
    `[spellcheck] neither "${preferred}" nor "${FALLBACK}" is available. Available: ${available.join(', ') || '(none)'}`,
  );
  return null;
}

/**
 * Applies the spell-check language on the default session and every open window.
 *
 * Call once before the first window loads so the contenteditable inherits the right
 * dictionary from the first keystroke, then again whenever the preference changes.
 *
 * On macOS the OS spell checker may ignore the request and keep the input-source
 * language — that is logged rather than treated as success.
 */
export function applySpellCheckerLanguage(language: SpellcheckLanguage): void {
  const sessions = new Set([session.defaultSession]);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) sessions.add(window.webContents.session);
  }

  for (const target of sessions) {
    const resolved = resolveSpellCheckerLanguage(language, target.availableSpellCheckerLanguages);
    if (resolved === null) continue;
    target.setSpellCheckerLanguages([resolved]);
    const applied = target.getSpellCheckerLanguages();
    if (!applied.includes(resolved)) {
      console.warn(
        `[spellcheck] requested "${resolved}" but the session still reports [${applied.join(', ') || '(none)'}]. On macOS the OS checker often keeps the input-source language.`,
      );
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
