import { app, BrowserWindow, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '@shared/ipc-contract.js';
import type { Locale } from '@shared/i18n/index.js';
import { LOCALES } from '@shared/i18n/index.js';
import { applySpellCheckerLanguage } from './spellcheck.js';
import { clearRecent, getSettings, getTranslator, listRecent, patchSettings } from './store.js';

/**
 * Native application menu, translated through the shared catalogues.
 *
 * The menu never touches the document itself: it sends a `MenuCommand` to the renderer,
 * which owns the editing state. A keyboard shortcut and a menu click therefore follow
 * exactly the same code path.
 *
 * The whole menu is rebuilt when the language changes — native menu labels cannot be
 * updated in place.
 */

/** Language names are shown in their own language, as users expect. */
const LANGUAGE_LABELS: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
};

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function send(command: MenuCommand): void {
  focusedWindow()?.webContents.send('menu:command', { command });
}

function sendOpenFiles(paths: string[]): void {
  focusedWindow()?.webContents.send('app:openFiles', { paths });
}

export async function buildMenu(): Promise<void> {
  const isMac = process.platform === 'darwin';
  const { t } = await getTranslator();
  const settings = await getSettings();
  const recent = await listRecent();
  const appName = app.name;
  const applyGlobalSettings = async (patch: Partial<typeof settings>) => {
    const next = await patchSettings(patch);
    await buildMenu();
    if (next.spellcheckLanguage !== settings.spellcheckLanguage) {
      applySpellCheckerLanguage(next.spellcheckLanguage);
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('app:settingsChanged', { settings: next });
    }
  };

  const recentItems: MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: t('menu.file.noRecent'), enabled: false }]
      : [
          ...recent.map((entry) => ({
            label: entry.name,
            toolTip: entry.path,
            click: () => sendOpenFiles([entry.path]),
          })),
          { type: 'separator' as const },
          {
            label: t('menu.file.clearRecent'),
            click: () => {
              void clearRecent().then(buildMenu);
            },
          },
        ];

  const languageItems: MenuItemConstructorOptions[] = LOCALES.map((locale) => ({
    label: LANGUAGE_LABELS[locale],
    type: 'radio' as const,
    checked: settings.language === locale,
    click: () => {
      void applyGlobalSettings({ language: locale });
    },
  }));

  const spellcheckItems: MenuItemConstructorOptions[] = [
    {
      label: t('spell.system'),
      type: 'radio',
      checked: settings.spellcheckLanguage === 'system',
      click: () => void applyGlobalSettings({ spellcheckLanguage: 'system' }),
    },
    {
      label: t('spell.english'),
      type: 'radio',
      checked: settings.spellcheckLanguage === 'en-US',
      click: () => void applyGlobalSettings({ spellcheckLanguage: 'en-US' }),
    },
  ];

  const themeItems: MenuItemConstructorOptions[] = (
    [
      ['system', t('menu.view.themeSystem')],
      ['light', t('menu.view.themeLight')],
      ['dark', t('menu.view.themeDark')],
    ] as const
  ).map(([theme, label]) => ({
    label,
    type: 'radio',
    checked: settings.theme === theme,
    click: () => void applyGlobalSettings({ theme }),
  }));

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: appName,
            submenu: [
              { role: 'about', label: t('menu.app.about', { app: appName }) },
              { type: 'separator' },
              { role: 'services', label: t('menu.app.services') },
              { type: 'separator' },
              { role: 'hide', label: t('menu.app.hide', { app: appName }) },
              { role: 'hideOthers', label: t('menu.app.hideOthers') },
              { role: 'unhide', label: t('menu.app.unhide') },
              { type: 'separator' },
              { role: 'quit', label: t('menu.app.quit') },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.file.new'), accelerator: 'CmdOrCtrl+N', click: () => send('file.new') },
        { label: t('menu.file.open'), accelerator: 'CmdOrCtrl+O', click: () => send('file.open') },
        { label: t('menu.file.openRecent'), submenu: recentItems },
        { type: 'separator' },
        { label: t('menu.file.save'), accelerator: 'CmdOrCtrl+S', click: () => send('file.save') },
        {
          label: t('menu.file.saveAs'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send('file.saveAs'),
        },
        {
          label: t('menu.file.exportPdf'),
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => send('file.exportPdf'),
        },
        { type: 'separator' },
        {
          label: t('menu.file.snapshots'),
          click: () => send('file.snapshots'),
        },
        {
          label: t('menu.file.bible'),
          click: () => send('file.bible'),
        },
        { type: 'separator' },
        {
          label: t('menu.file.closeTab'),
          accelerator: 'CmdOrCtrl+W',
          click: () => send('file.closeTab'),
        },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { role: 'quit', label: t('menu.app.quit') },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.edit.undo') },
        { role: 'redo', label: t('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.edit.cut') },
        { role: 'copy', label: t('menu.edit.copy') },
        { role: 'paste', label: t('menu.edit.paste') },
        { role: 'selectAll', label: t('menu.edit.selectAll') },
        { type: 'separator' },
        { label: t('menu.edit.find'), accelerator: 'CmdOrCtrl+F', click: () => send('edit.find') },
        {
          label: t('menu.edit.replace'),
          accelerator: 'CmdOrCtrl+Alt+F',
          click: () => send('edit.replace'),
        },
        { type: 'separator' },
        { label: t('menu.edit.renumberScenes'), click: () => send('scene.renumber') },
        {
          label: t('menu.edit.removeSceneNumbers'),
          click: () => send('scene.removeNumbers'),
        },
        { type: 'separator' },
        { label: t('menu.edit.lockProduction'), click: () => send('revision.lock') },
        { label: t('menu.edit.issueRevision'), click: () => send('revision.issue') },
        { label: t('menu.edit.unlockProduction'), click: () => send('revision.unlock') },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: t('spell.language'), submenu: spellcheckItems },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.view.showNotes'),
          type: 'checkbox',
          checked: settings.showNotes,
          click: () => send('view.toggleNotes'),
        },
        {
          label: t('menu.view.showBoneyard'),
          type: 'checkbox',
          checked: settings.showBoneyard,
          click: () => send('view.toggleBoneyard'),
        },
        {
          label: t('menu.view.showSynopses'),
          type: 'checkbox',
          checked: settings.showSynopses,
          click: () => send('view.toggleSynopses'),
        },
        {
          label: t('menu.view.showSections'),
          type: 'checkbox',
          checked: settings.showSections,
          click: () => send('view.toggleSections'),
        },
        {
          label: t('menu.view.showSceneNumbers'),
          type: 'checkbox',
          checked: settings.showSceneNumbers,
          click: () => send('view.toggleSceneNumbers'),
        },
        {
          label: t('menu.view.formattedMode'),
          type: 'checkbox',
          checked: settings.formattedMode,
          click: () => send('view.toggleFormattedMode'),
        },
        {
          label: t('menu.view.showTimeline'),
          accelerator: 'CmdOrCtrl+Alt+T',
          click: () => send('view.toggleTimeline'),
        },
        {
          label: t('menu.view.corkboard'),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => send('view.toggleCorkboard'),
        },
        { type: 'separator' },
        {
          label: t('menu.view.increaseFont'),
          accelerator: 'CmdOrCtrl+Plus',
          click: () => send('view.increaseFont'),
        },
        {
          label: t('menu.view.decreaseFont'),
          accelerator: 'CmdOrCtrl+-',
          click: () => send('view.decreaseFont'),
        },
        { type: 'separator' },
        {
          label: t('menu.view.focusMode'),
          type: 'checkbox',
          checked: settings.focusMode,
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => send('view.toggleFocus'),
        },
        {
          label: t('menu.view.typewriterMode'),
          type: 'checkbox',
          checked: settings.typewriterMode,
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => send('view.toggleTypewriter'),
        },
        { label: t('menu.view.theme'), submenu: themeItems },
        {
          label: t('menu.view.commandPalette'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('view.commandPalette'),
        },
        { type: 'separator' },
        { label: t('menu.language'), submenu: languageItems },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.view.fullscreen') },
        ...(app.isPackaged
          ? []
          : ([
              { role: 'toggleDevTools', label: t('menu.view.devTools') },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t('menu.ai'),
      submenu: [
        {
          label: t('menu.ai.synonyms'),
          click: () => send('ai.synonyms'),
        },
        {
          label: t('menu.ai.rewrite'),
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => send('ai.rewrite'),
        },
        {
          label: t('menu.ai.renameCharacter'),
          click: () => send('ai.renameCharacter'),
        },
        {
          label: t('menu.ai.inconsistencies'),
          click: () => send('ai.openInconsistencies'),
        },
        {
          label: t('menu.ai.voiceConsistency'),
          click: () => send('ai.openVoiceConsistency'),
        },
        {
          label: t('menu.ai.repetitions'),
          click: () => send('ai.openRepetitions'),
        },
        { type: 'separator' },
        { label: t('menu.ai.settings'), click: () => send('ai.openSettings') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: isMac
        ? [
            { role: 'minimize', label: t('menu.window.minimize') },
            { role: 'zoom', label: t('menu.window.zoom') },
            { type: 'separator' },
            { role: 'front', label: t('menu.window.front') },
          ]
        : [
            { role: 'minimize', label: t('menu.window.minimize') },
            { role: 'close', label: t('menu.window.close') },
          ],
    },
    {
      role: 'help',
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.help.fountainSyntax'),
          click: () => void shell.openExternal('https://fountain.io/syntax/'),
        },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              { label: t('menu.help.about', { app: appName }), click: () => send('help.about') },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
