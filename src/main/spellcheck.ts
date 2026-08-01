import { app, BrowserWindow, session } from 'electron';
import type { AppSettings } from '@shared/ipc-contract.js';

export type SpellcheckLanguage = AppSettings['spellcheckLanguage'];

const FALLBACK = 'en-US';

/**
 * Picks the best Chromium spell-check tag for an OS locale string.
 *
 * Tries the full tag (`fr-FR`), then the language subtag (`fr`), then a matching
 * language-* variant already in the available list.
 */
function matchAvailableLanguage(locale: string, available: readonly string[]): string | null {
  if (available.includes(locale)) return locale;

  const language = locale.split(/[-_]/)[0]?.toLowerCase();
  if (!language) return null;

  const exactLanguage = available.find((tag) => tag.toLowerCase() === language);
  if (exactLanguage) return exactLanguage;

  const prefixed = available.find((tag) => tag.toLowerCase().startsWith(`${language}-`));
  if (prefixed) return prefixed;

  return null;
}

/**
 * Resolves the Chromium language tag to apply for a preference.
 *
 * Returns null when nothing usable is available (caller skips the session).
 */
function resolveSpellCheckerLanguage(
  preference: SpellcheckLanguage,
  available: readonly string[],
): string | null {
  if (preference === 'en-US') {
    if (available.includes('en-US')) return 'en-US';
    const english = matchAvailableLanguage('en', available);
    if (english) {
      console.warn(
        `[spellcheck] "en-US" is not available; falling back to "${english}". Available: ${available.join(', ') || '(none)'}`,
      );
      return english;
    }
    console.warn(
      `[spellcheck] neither "en-US" nor any English tag is available. Available: ${available.join(', ') || '(none)'}`,
    );
    return null;
  }

  // preference === 'system'
  const fromOs = matchAvailableLanguage(app.getLocale(), available);
  if (fromOs) return fromOs;
  if (available.includes(FALLBACK)) {
    console.warn(
      `[spellcheck] OS locale "${app.getLocale()}" is not available; falling back to "${FALLBACK}". Available: ${available.join(', ') || '(none)'}`,
    );
    return FALLBACK;
  }
  console.warn(
    `[spellcheck] neither the OS locale nor "${FALLBACK}" is available. Available: ${available.join(', ') || '(none)'}`,
  );
  return null;
}

/**
 * Applies the spell-check language on the default session and every open window.
 *
 * Call once before the first window loads so the contenteditable inherits the right
 * dictionary from the first keystroke, then again whenever the preference changes.
 *
 * On macOS the OS spell checker ignores Electron's language list and follows the
 * machine / input-source language — this function is a no-op there.
 */
export function applySpellCheckerLanguage(language: SpellcheckLanguage): void {
  if (process.platform === 'darwin') return;

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
        `[spellcheck] requested "${resolved}" but the session still reports [${applied.join(', ') || '(none)'}].`,
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
