import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Main journey: the application starts, the editor highlights Fountain, the analysis
 * feeds the status bar, and saving really writes to disk.
 *
 * The interface defaults to English, so the assertions below are English. Locale
 * switching has its own test at the end.
 */

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  // Throwaway profile directory: tests must not touch the real settings.
  userData = await mkdtemp(join(tmpdir(), 'quantum-draft-e2e-'));

  // Some development environments (VS Code extensions in particular) export
  // ELECTRON_RUN_AS_NODE=1. The binary would then start as plain Node and reject the
  // Chromium switches Playwright needs. It is dropped here so the test does not depend
  // on the shell that launched it.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  env['NODE_ENV'] = 'test';
  // Force a known interface language: the store adopts the OS locale on first launch,
  // and a French CI machine would otherwise fail every English assertion.
  env['LANG'] = 'en_US.UTF-8';
  env['LC_ALL'] = 'en_US.UTF-8';

  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--lang=en-US'],
    env,
  });
  page = await app.firstWindow();
  await page.waitForSelector('.cm-content');
});

test.afterAll(async () => {
  if (!app) return;
  // The suite intentionally leaves an edited tab behind. Confirm discard so the close
  // handshake is exercised without leaving a native modal open in CI.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await app.close();
});

/**
 * Triggers a menu command.
 *
 * macOS native accelerators (Cmd+S…) cannot be fired by CDP's synthetic keyboard
 * events: they are handled by the OS menu, upstream of the renderer. So we take exactly
 * the path the menu takes — sending `menu:command` to the renderer — rather than a
 * shortcut that would never leave.
 */
async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.webContents.send('menu:command', { command: name });
  }, command);
}

/** Waits for the active tab to be clean: the disk write has then completed. */
async function waitUntilSaved(): Promise<void> {
  await expect(page.locator('.status-message')).toContainText('Saved');
  await expect(page.locator('.tab-active .tab-name')).not.toContainText('•');
}

/** Top-level labels of the native application menu. */
async function menuLabels(): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return menu ? menu.items.map((item) => item.label) : [];
  });
}

test('the window opens on a blank document, in English', async () => {
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.tab-name')).toContainText('Untitled');
  // The new-document template carries a pre-filled title page. The Fountain keys stay
  // in English in every locale; only the values are translated.
  await expect(page.locator('.cm-content')).toContainText('Title: Untitled');
  await expect(page.locator('.cm-content')).toContainText('Credit: Written by');
});

test('title-page keys autocomplete beyond the first line', async () => {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('Ver');
  await page.keyboard.press('Control+Space');

  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Version:');
});

test('highlighting distinguishes Fountain element kinds', async () => {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('INT. KITCHEN - DAY\n\nJulie walks in.\n\nJULIE\nHello.\n');

  // Each element kind gets its line class, produced by the shared lexer.
  await expect(page.locator('.cm-fountain-scene')).toHaveCount(1);
  await expect(page.locator('.cm-fountain-character')).toHaveCount(1);
  await expect(page.locator('.cm-fountain-dialogue')).toHaveCount(1);
  await expect(page.locator('.cm-fountain-action')).toHaveCount(1);
});

test('the status bar reflects the worker analysis, with correct singulars', async () => {
  const statusbar = page.locator('.statusbar');
  // One of each: the singular forms must be used, not "1 scenes".
  await expect(statusbar).toContainText('1 scene');
  await expect(statusbar).not.toContainText('1 scenes');
  await expect(statusbar).toContainText('1 character');
  await expect(statusbar).toContainText('1 location');
});

test('the tab is marked dirty, then clean after saving', async () => {
  await expect(page.locator('.tab-name')).toContainText('•');

  const target = join(userData, 'screenplay-test.fountain');

  // The native dialog is not drivable from Playwright, so it is short-circuited.
  await app.evaluate(async ({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);

  await runCommand('file.save');
  await waitUntilSaved();

  const written = await readFile(target, 'utf8');
  expect(written).toContain('INT. KITCHEN - DAY');
  expect(written).toContain('JULIE');
});

test('a later save creates a .bak backup', async () => {
  const target = join(userData, 'screenplay-test.fountain');

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('EXT. STREET - NIGHT\n\nShe leaves.\n');
  await expect(page.locator('.tab-active .tab-name')).toContainText('•');

  await runCommand('file.save');
  await waitUntilSaved();

  // The previous version must have been set aside before being overwritten.
  const backup = await readFile(`${target}.bak`, 'utf8');
  expect(backup).toContain('INT. KITCHEN - DAY');

  const current = await readFile(target, 'utf8');
  expect(current).toContain('EXT. STREET - NIGHT');
});

test('drag and drop can resolve a file’s real path', async () => {
  // A genuine Finder drop cannot be simulated, but we check the bridge exists:
  // `File.path` is gone in Electron 43, only webUtils via the preload can resolve a
  // disk path.
  const exposed = await page.evaluate(() => typeof window.quantum.getPathForFile);
  expect(exposed).toBe('function');
});

test('an existing .fountain file opens in a new tab', async () => {
  const path = join(userData, 'opened.fountain');
  await writeFile(
    path,
    'Title: Opened script\n\nINT. GARAGE - NIGHT\n\nMARC\nAnyone there?\n',
    'utf8',
  );

  await app.evaluate(async ({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, path);

  await runCommand('file.open');

  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab-active .tab-name')).toContainText('opened.fountain');
  await expect(page.locator('.cm-content')).toContainText('INT. GARAGE - NIGHT');
});

test('the live preview and AST navigator follow the opened screenplay', async () => {
  await expect(page.locator('.preview-scene-heading')).toContainText('INT. GARAGE - NIGHT');
  await expect(page.locator('.sidebar-scene-heading')).toContainText('INT. GARAGE - NIGHT');

  const sidebar = await page.locator('.workspace-sidebar').boundingBox();
  const editor = await page.locator('.workspace-editor').boundingBox();
  const preview = await page.locator('.workspace-preview').boundingBox();
  expect(sidebar?.x).toBeLessThan(editor?.x ?? 0);
  expect(editor?.x).toBeLessThan(preview?.x ?? 0);

  await page.getByRole('tab', { name: 'Locations' }).click();
  const garage = page.getByRole('button', { name: /GARAGE/ });
  await expect(garage).toContainText('1 occurrence');
  await garage.click();
  await expect(page.locator('.cm-activeLine')).toContainText('INT. GARAGE - NIGHT');

  await page.getByRole('tab', { name: 'Characters' }).click();
  const marc = page.getByRole('button', { name: /MARC/ });
  await expect(marc).toContainText('1 speech');
  await marc.click();
  await expect(page.locator('.cm-activeLine')).toContainText('MARC');
});

test('statistics share pagination and export CSV', async () => {
  await page.getByRole('button', { name: 'Statistics' }).click();
  const panel = page.locator('.stats-pane');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('1');
  await expect(panel.locator('svg')).toHaveCount(1);

  const target = join(userData, 'screenplay-statistics.csv');
  await app.evaluate(async ({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole('button', { name: 'Export CSV…' }).click();
  await expect(page.locator('.status-message')).toContainText('screenplay-statistics.csv');
  await expect
    .poll(() => readFile(target, 'utf8'))
    .toContain('record_type,key,name,value,pages,eighths');

  await page.getByRole('button', { name: 'Screenplay preview' }).click();
  await expect(page.locator('.preview-pane')).toBeVisible();
});

test('PDF options render an integrated preview and export a real PDF', async () => {
  const target = join(userData, 'screenplay-export.pdf');
  await app.evaluate(async ({ dialog, shell }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    shell.showItemInFolder = () => {};
  }, target);

  await runCommand('file.exportPdf');
  const dialog = page.getByRole('dialog', { name: 'Export PDF' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-page-count', /[1-9]/);
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect(dialog).toContainText('Page 1 of 2');
  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(dialog).toContainText('Page 2 of 2');
  const exportButton = dialog.getByRole('button', { name: 'Export…' });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('.status-message')).toContainText('screenplay-export.pdf');
  const bytes = await readFile(target);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1_000);
});

test('the title-page preview renders date, version and other metadata', async () => {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(
    'Title: Metadata test\nCredit: Written by\nAuthor: Ada\nVersion: 2.1\nDraft date: 29 July 2026\n\nINT. ROOM - DAY\n',
  );

  const titlePage = page.locator('.preview-title-page');
  await expect(titlePage).toContainText('Metadata test');
  await expect(titlePage).toContainText('version');
  await expect(titlePage).toContainText('2.1');
  await expect(titlePage).toContainText('draft date');
  await expect(titlePage).toContainText('29 July 2026');
});

test('clicking a decorated editor line places the cursor on that line', async () => {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(
    '# Hidden section\n\n= Hidden synopsis\n\n## Another section\n\n= Another synopsis\n\nINT. TARGET ROOM - DAY\n\nCursor target.\n',
  );
  await page.evaluate(async () => {
    await window.quantum.invoke('settings:patch', {
      showSections: false,
      showSynopses: false,
    });
  });
  const target = page.locator('.cm-line').filter({ hasText: 'Cursor target.' });
  await target.click({ position: { x: 80, y: 10 } });
  await expect(target).toHaveClass(/cm-activeLine/);

  await page.evaluate(async () => {
    await window.quantum.invoke('settings:patch', {
      showSections: true,
      showSynopses: true,
    });
  });
});

test('scrollbar colours follow the light and dark themes', async () => {
  const scrollbarColor = () =>
    page.locator('.cm-scroller').evaluate((element) => getComputedStyle(element).scrollbarColor);

  await page.evaluate(() => window.quantum.invoke('settings:patch', { theme: 'light' }));
  const light = await scrollbarColor();
  await page.evaluate(() => window.quantum.invoke('settings:patch', { theme: 'dark' }));
  const dark = await scrollbarColor();

  expect(light).not.toBe(dark);
  await page.evaluate(() => window.quantum.invoke('settings:patch', { theme: 'system' }));
});

test('panel state is persisted in the screenplay companion file', async () => {
  await page.getByLabel('Sync scroll with editor').check();
  await page.getByRole('tab', { name: 'Structure' }).click();

  const companion = join(userData, 'opened.fountain.appdata.json');
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(companion, 'utf8')) as unknown;
      } catch {
        return null;
      }
    })
    .toMatchObject({
      version: 1,
      preview: { syncScroll: true },
      sidebar: { activeTab: 'structure' },
    });
});

test('notes, boneyard and synopses have independent editor visibility', async () => {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(
    '# ACT ONE\n\n= Hidden from paper\n\nINT. GARAGE - NIGHT\n\n[[A note]]\n\n/* discarded */\n\nMARC\nHello.\n',
  );

  await expect(page.locator('.cm-fountain-note')).toHaveCount(1);
  await expect(page.locator('.cm-fountain-boneyard')).toHaveCount(1);
  await expect(page.locator('.cm-fountain-synopsis')).toHaveCount(1);
  await expect(page.locator('.preview-dialogue')).toContainText('Hello.');
  // Editorial annotations never reach the paper preview.
  await expect(page.locator('.preview-scroll')).not.toContainText('A note');
  await expect(page.locator('.preview-scroll')).not.toContainText('Hidden from paper');

  await runCommand('view.toggleBoneyard');
  await expect(page.locator('.cm-fountain-boneyard')).toHaveCount(0);
  await runCommand('view.toggleBoneyard');
  await expect(page.locator('.cm-fountain-boneyard')).toHaveCount(1);
});

test('switching to French retranslates the interface and the native menu', async () => {
  // Default state: English interface, English menu.
  expect(await menuLabels()).toContain('File');
  await expect(page.locator('.statusbar')).toContainText('scene');

  await page.evaluate(() => window.quantum.invoke('settings:patch', { language: 'fr' }));

  // Renderer: the status bar is rebuilt from the French catalogue.
  await expect(page.locator('.statusbar')).toContainText('scène');
  await expect(page.locator('.statusbar')).toContainText('lieu');
  // The document language follows, which is what drives Chromium's spell checker.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');

  // Main process: the native menu was rebuilt, since labels cannot be updated in place.
  const labels = await menuLabels();
  expect(labels).toContain('Fichier');
  expect(labels).not.toContain('File');

  // A new document uses the French template, Fountain keys still in English.
  await runCommand('file.new');
  await expect(page.locator('.tab-active .tab-name')).toContainText('Sans titre');
  await expect(page.locator('.cm-content')).toContainText('Title: Sans titre');
  await expect(page.locator('.cm-content')).toContainText('Credit: Écrit par');

  // Back to English, so the suite leaves no lingering state.
  await page.evaluate(() => window.quantum.invoke('settings:patch', { language: 'en' }));
  await expect(page.locator('.statusbar')).toContainText('scene');
});

test('the native menu offers a language switch, reflecting the current locale', async () => {
  // The real user path: View ▸ Language ▸ Français, as radio items.
  const languageMenu = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    for (const top of menu?.items ?? []) {
      for (const item of top.submenu?.items ?? []) {
        if (item.submenu?.items.some((entry) => entry.label === 'Français')) {
          return item.submenu.items.map((entry) => ({
            label: entry.label,
            type: entry.type,
            checked: entry.checked,
          }));
        }
      }
    }
    return null;
  });

  expect(languageMenu).not.toBeNull();
  expect(languageMenu?.map((item) => item.label)).toEqual(['English', 'Français']);
  // Radio items, so the active language is visibly ticked.
  expect(languageMenu?.every((item) => item.type === 'radio')).toBe(true);
  expect(languageMenu?.find((item) => item.label === 'English')?.checked).toBe(true);
});

test('the chosen language survives a restart', async () => {
  await page.evaluate(() => window.quantum.invoke('settings:patch', { language: 'fr' }));
  await expect(page.locator('.statusbar')).toContainText('scène');

  const settings = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as {
    settings: { language: string };
  };
  expect(settings.settings.language).toBe('fr');
});
