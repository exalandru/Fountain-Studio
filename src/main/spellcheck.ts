import { BrowserWindow, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { AppSettings } from '@shared/ipc-contract.js';
import { getTranslator } from './store.js';

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

/** Native suggestions and global custom-dictionary action for editable screenplay text. */
export function installSpellcheckContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return;
    event.preventDefault();

    void (async () => {
      const { t } = await getTranslator();
      const suggestions = params.dictionarySuggestions.slice(0, 6);
      const selected = params.selectionText.trim();
      const singleWord = /^[\p{L}\p{N}_'’-]+$/u.test(selected);
      const characterLike =
        selected.length > 0 &&
        selected.length <= 120 &&
        /\p{L}/u.test(selected) &&
        selected === selected.toLocaleUpperCase('fr-FR');
      const template: MenuItemConstructorOptions[] = [];

      if (params.misspelledWord) {
        if (suggestions.length > 0) {
          template.push(
            ...suggestions.map((suggestion) => ({
              label: suggestion,
              click: () => window.webContents.replaceMisspelling(suggestion),
            })),
          );
        } else {
          template.push({ label: t('spell.noSuggestions'), enabled: false });
        }
        template.push(
          { type: 'separator' },
          {
            label: t('spell.addGlobal', { word: params.misspelledWord }),
            click: () =>
              window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
          },
          { type: 'separator' },
        );
      }

      template.push(
        {
          label: t('menu.ai.synonyms'),
          enabled: singleWord,
          click: () => window.webContents.send('menu:command', { command: 'ai.synonyms' }),
        },
        {
          label: t('menu.ai.rewrite'),
          enabled: selected.length > 0 && !singleWord,
          click: () => window.webContents.send('menu:command', { command: 'ai.rewrite' }),
        },
        {
          label: t('menu.ai.renameCharacter'),
          enabled: characterLike,
          click: () => window.webContents.send('menu:command', { command: 'ai.renameCharacter' }),
        },
        { type: 'separator' },
        { role: 'undo', label: t('menu.edit.undo'), enabled: params.editFlags.canUndo },
        { role: 'redo', label: t('menu.edit.redo'), enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', label: t('menu.edit.cut'), enabled: params.editFlags.canCut },
        { role: 'copy', label: t('menu.edit.copy'), enabled: params.editFlags.canCopy },
        { role: 'paste', label: t('menu.edit.paste'), enabled: params.editFlags.canPaste },
        {
          role: 'selectAll',
          label: t('menu.edit.selectAll'),
          enabled: params.editFlags.canSelectAll,
        },
      );

      Menu.buildFromTemplate(template).popup({ window });
    })();
  });
}
