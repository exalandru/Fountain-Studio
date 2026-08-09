import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  chooseSaveAsDestination,
  openTrustedScreenplay,
  openTrustedScreenplays,
} from './helpers/open.js';

const A_CONTENT = `Title: Path Ownership A

INT. A - DAY

Alice.
`;

const B_CONTENT = `Title: Path Ownership B

INT. B - NIGHT

Bob.
`;

function cleanEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  env['LANG'] = 'en_US.UTF-8';
  env['LC_ALL'] = 'en_US.UTF-8';
  return env;
}

async function launch(userData: string) {
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--lang=en-US'],
    env: cleanEnvironment(),
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.cm-content');
  return { app, page };
}

async function dispose(app: ElectronApplication): Promise<void> {
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await app.close();
  } catch {
    // A preceding close may already have ended Electron.
  }
}

async function openPath(app: ElectronApplication, page: Page, path: string): Promise<void> {
  await openTrustedScreenplay(app, page, path);
}

async function runCommand(app: ElectronApplication, command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

async function chooseSaveAs(app: ElectronApplication, path: string): Promise<void> {
  await chooseSaveAsDestination(app, path);
}

async function tabNames(page: Page): Promise<string[]> {
  return page.locator('.tab .tab-name').allTextContents();
}

function tabLabelsInclude(names: string[], label: string): boolean {
  return names.some((name) => name === label || name.endsWith(label));
}

test('Save As refuses a destination already open in another tab and leaves both bundles intact', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-path-ownership-open-'));
  const pathA = join(userData, 'A.fountain');
  const pathB = join(userData, 'B.fountain');
  await writeFile(pathA, A_CONTENT, 'utf8');
  await writeFile(pathB, B_CONTENT, 'utf8');
  await writeFile(`${pathB}.bible.json`, '{"version":1,"entries":[]}', 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, pathA);
    await openPath(app, page, pathB);
    expect(tabLabelsInclude(await tabNames(page), 'A.fountain')).toBe(true);
    expect(tabLabelsInclude(await tabNames(page), 'B.fountain')).toBe(true);

    await page.locator('.tab', { hasText: 'A.fountain' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nA_PENDING_EDIT');

    await chooseSaveAs(app, pathB);
    await runCommand(app, 'file.saveAs');
    await expect(page.locator('.status-message')).toContainText('already open in another tab');

    expect(tabLabelsInclude(await tabNames(page), 'A.fountain')).toBe(true);
    expect(tabLabelsInclude(await tabNames(page), 'B.fountain')).toBe(true);
    await expect(page.locator('.tab-active .tab-name')).toContainText('A.fountain');
    expect(await readFile(pathA, 'utf8')).toBe(A_CONTENT);
    expect(await readFile(pathB, 'utf8')).toBe(B_CONTENT);
    expect(await readFile(`${pathB}.bible.json`, 'utf8')).toBe('{"version":1,"entries":[]}');
    await expect(page.locator('.cm-content')).toContainText('A_PENDING_EDIT');
  } finally {
    await dispose(app);
  }
});

test('Save As still refuses when the open destination tab is dirty', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-path-ownership-dirty-'));
  const pathA = join(userData, 'A.fountain');
  const pathB = join(userData, 'B.fountain');
  await writeFile(pathA, A_CONTENT, 'utf8');
  await writeFile(pathB, B_CONTENT, 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, pathA);
    await openPath(app, page, pathB);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nB_DIRTY');

    await page.locator('.tab', { hasText: 'A.fountain' }).click();
    await chooseSaveAs(app, pathB);
    await runCommand(app, 'file.saveAs');
    await expect(page.locator('.status-message')).toContainText('already open in another tab');

    await page.locator('.tab', { hasText: 'B.fountain' }).click();
    await expect(page.locator('.cm-content')).toContainText('B_DIRTY');
    expect(await readFile(pathB, 'utf8')).toBe(B_CONTENT);
  } finally {
    await dispose(app);
  }
});

test('opening an already-open path focuses the existing tab instead of duplicating it', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-path-ownership-dup-open-'));
  const pathB = join(userData, 'B.fountain');
  await writeFile(pathB, B_CONTENT, 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, pathB);
    await runCommand(app, 'file.new');
    const countBefore = await page.locator('.tab .tab-name').count();
    expect(countBefore).toBeGreaterThanOrEqual(2);
    await openPath(app, page, pathB);
    await expect(page.locator('.tab .tab-name')).toHaveCount(countBefore);
    expect((await tabNames(page)).filter((name) => name === 'B.fountain')).toHaveLength(1);
    await expect(page.locator('.tab-active .tab-name')).toHaveText('B.fountain');
  } finally {
    await dispose(app);
  }
});

test('Open and Save As racing for the same destination leave a single owner', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-path-ownership-race-'));
  const pathA = join(userData, 'A.fountain');
  const pathB = join(userData, 'B.fountain');
  await writeFile(pathA, A_CONTENT, 'utf8');
  await writeFile(pathB, B_CONTENT, 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, pathA);
    await chooseSaveAs(app, pathB);

    await Promise.all([runCommand(app, 'file.saveAs'), openTrustedScreenplays(app, [pathB])]);

    await expect
      .poll(async () => (await tabNames(page)).filter((name) => name === 'B.fountain').length)
      .toBe(1);

    const names = await tabNames(page);
    expect(names.filter((name) => name === 'B.fountain')).toHaveLength(1);

    if (names.includes('A.fountain')) {
      await expect(page.locator('.status-message')).toContainText('already open in another tab');
      expect(await readFile(pathA, 'utf8')).toBe(A_CONTENT);
      expect(await readFile(pathB, 'utf8')).toBe(B_CONTENT);
    } else {
      await expect.poll(async () => readFile(pathB, 'utf8')).toContain('Alice');
    }
  } finally {
    await dispose(app);
  }
});

test('two concurrent Save As operations toward the same destination leave one owner', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-path-ownership-two-saveas-'));
  const pathA1 = join(userData, 'A1.fountain');
  const pathA2 = join(userData, 'A2.fountain');
  const pathB = join(userData, 'B.fountain');
  await writeFile(pathA1, `${A_CONTENT}\nA1_MARK`, 'utf8');
  await writeFile(pathA2, `${A_CONTENT}\nA2_MARK`, 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, pathA1);
    await openPath(app, page, pathA2);

    await app.evaluate(({ ipcMain }, destination) => {
      let release: ((path: string) => void) | undefined;
      const gate = new Promise<string>((resolve) => {
        release = resolve;
      });
      const reserve = (
        globalThis as typeof globalThis & {
          __fountainReserveSaveAsDestination?: (path: string) => void;
        }
      ).__fountainReserveSaveAsDestination;
      (
        globalThis as typeof globalThis & { __releaseSaveAsDestination?: () => void }
      ).__releaseSaveAsDestination = () => {
        reserve?.(destination);
        release?.(destination);
      };
      ipcMain.removeHandler('dialog:pickSaveAs');
      ipcMain.handle('dialog:pickSaveAs', () => gate);
    }, pathB);

    await page.locator('.tab', { hasText: 'A1.fountain' }).click();
    await runCommand(app, 'file.saveAs');
    await page.waitForTimeout(150);
    await page.locator('.tab', { hasText: 'A2.fountain' }).click();
    await runCommand(app, 'file.saveAs');
    await page.waitForTimeout(150);

    await app.evaluate(() => {
      (
        globalThis as typeof globalThis & { __releaseSaveAsDestination?: () => void }
      ).__releaseSaveAsDestination?.();
    });

    await expect
      .poll(async () => (await tabNames(page)).filter((name) => name === 'B.fountain').length, {
        timeout: 15_000,
      })
      .toBe(1);
    await expect(page.locator('.status-message')).toContainText(
      /Saved|already open in another tab/,
    );

    const names = await tabNames(page);
    expect(names.filter((name) => name === 'B.fountain')).toHaveLength(1);
    expect(names.includes('A1.fountain') !== names.includes('A2.fountain')).toBe(true);
    const disk = await readFile(pathB, 'utf8');
    expect(disk.includes('A1_MARK') !== disk.includes('A2_MARK')).toBe(true);
  } finally {
    await dispose(app);
  }
});
