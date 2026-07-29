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
      void patchSettings({ language: locale }).then(async (next) => {
        // Rebuild first so the menu is already translated when the renderer repaints.
        await buildMenu();
        applySpellCheckerLanguage(next.language);
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('app:settingsChanged', { settings: next });
        }
      });
    },
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
        { label: t('menu.language'), submenu: languageItems },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.view.fullscreen') },
        { role: 'toggleDevTools', label: t('menu.view.devTools') },
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
