import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { chooseSaveAsDestination, openTrustedScreenplay } from './helpers/open.js';

const ORIGINAL = `Title: Save As Bundle

INT. LAB - DAY

Alice watches the console.

ALICE
Still here.
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

async function waitForFile(path: string, text: string): Promise<void> {
  await expect.poll(() => readFile(path, 'utf8').catch(() => '')).toContain(text);
}

test('Save As duplicates the complete bundle, reopens it and routes every future write to B', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-save-as-reopen-'));
  const source = join(userData, 'A.fountain');
  const destination = join(userData, 'B.fountain');
  const pdf = join(userData, 'B-revision.pdf');
  await writeFile(source, ORIGINAL, 'utf8');
  let running = await launch(userData);

  try {
    await openPath(running.app, running.page, source);
    await runCommand(running.app, 'file.bible');
    let bible = running.page.locator('.bible-dialog');
    await bible.getByLabel('Name of the new sheet').fill('ALICE');
    await bible.getByRole('button', { name: 'New sheet' }).click();
    await bible.getByLabel('Role in the story').fill('Original Bible role');
    await waitForFile(`${source}.bible.json`, 'Original Bible role');
    await bible.getByRole('button', { name: 'Close', exact: true }).click();

    await runCommand(running.app, 'revision.lock');
    await expect(running.page.locator('.status-revision')).toContainText('Blue');
    await expect
      .poll(async () => {
        const data = JSON.parse(
          await readFile(`${source}.appdata.json`, 'utf8').catch(() => '{}'),
        ) as {
          revision?: { snapshotId?: string | null };
        };
        return data.revision?.snapshotId ?? null;
      })
      .toMatch(/^snap-/);

    const editor = running.page.locator('.cm-content');
    await editor.click();
    await running.page.keyboard.press('ControlOrMeta+End');
    await running.page.keyboard.type('\nAFTER_LOCK_BEFORE_SAVE_AS');
    // This appdata mutation is intentionally still inside its debounce when Save As starts.
    await running.page.locator('.timeline').getByRole('button', { name: 'Close timeline' }).click();
    // The Bible field remains focused and dirty: Save As itself must flush it, not a blur.
    await runCommand(running.app, 'file.bible');
    bible = running.page.locator('.bible-dialog');
    await bible.locator('.rail-row').click();
    await bible.getByLabel('Role in the story').fill('Pending Bible role at Save As');

    await chooseSaveAs(running.app, destination);
    await runCommand(running.app, 'file.saveAs');
    await expect(running.page.locator('.tab-active .tab-name')).toHaveText('B.fountain');
    await expect(running.page.locator('.status-message')).toContainText('Saved');
    await waitForFile(destination, 'AFTER_LOCK_BEFORE_SAVE_AS');
    await waitForFile(`${destination}.bible.json`, 'Pending Bible role at Save As');
    await expect.poll(() => readdir(`${destination}.snapshots`)).toContain('index.json');
    await expect
      .poll(async () => {
        const data = JSON.parse(await readFile(`${destination}.appdata.json`, 'utf8')) as {
          revision?: { snapshotId?: string | null };
          timeline?: { visible?: boolean };
        };
        return { snapshotId: data.revision?.snapshotId ?? null, timeline: data.timeline?.visible };
      })
      .toMatchObject({ snapshotId: expect.stringMatching(/^snap-/), timeline: false });

    const sourceBibleBefore = await readFile(`${source}.bible.json`, 'utf8');
    const sourceAppDataBefore = await readFile(`${source}.appdata.json`, 'utf8');
    const sourceTextBefore = await readFile(source, 'utf8');
    await dispose(running.app);

    running = await launch(userData);
    await openPath(running.app, running.page, destination);
    await expect(running.page.locator('.cm-content')).toContainText('AFTER_LOCK_BEFORE_SAVE_AS');
    await expect(running.page.locator('.status-revision')).toContainText('Blue');

    await runCommand(running.app, 'file.bible');
    bible = running.page.locator('.bible-dialog');
    await expect(bible.locator('.rail-row')).toHaveCount(1);
    await bible.locator('.rail-row').click();
    await expect(bible.getByLabel('Role in the story')).toHaveValue(
      'Pending Bible role at Save As',
    );
    await bible.getByLabel('Role in the story').fill('B_ONLY_BIBLE_ROLE');
    await expect(bible.getByLabel('Role in the story')).toHaveValue('B_ONLY_BIBLE_ROLE');
    await bible.getByRole('button', { name: 'Close', exact: true }).click();
    await waitForFile(`${destination}.bible.json`, 'B_ONLY_BIBLE_ROLE');

    await runCommand(running.app, 'file.snapshots');
    const snapshots = running.page.locator('.snapshot-dialog');
    await expect(snapshots.locator('.rail-row')).toHaveCount(1);
    await snapshots.locator('.rail-row').click();
    const restore = snapshots.getByRole('button', { name: 'Restore' });
    await expect(restore).toBeEnabled();
    await restore.click();
    await expect(snapshots).toBeHidden();
    await expect(running.page.locator('.cm-content')).not.toContainText(
      'AFTER_LOCK_BEFORE_SAVE_AS',
    );

    await running.app.evaluate(({ dialog, shell }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      shell.showItemInFolder = () => {};
    }, pdf);
    await runCommand(running.app, 'file.exportPdf');
    const pdfDialog = running.page.getByRole('dialog', { name: 'Export PDF' });
    const exportButton = pdfDialog.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toBeEnabled();
    await exportButton.click();
    await expect(pdfDialog).toBeHidden();
    await expect
      .poll(() => readFile(pdf).then((bytes) => bytes.subarray(0, 5).toString()))
      .toBe('%PDF-');

    await running.page.locator('.cm-content').click();
    await running.page.keyboard.press('ControlOrMeta+End');
    await running.page.keyboard.type('\nB_ONLY_FOUNTAIN_TEXT');
    await runCommand(running.app, 'file.save');
    await waitForFile(destination, 'B_ONLY_FOUNTAIN_TEXT');
    await running.page.getByRole('button', { name: 'Show timeline' }).click();
    await expect
      .poll(async () => {
        const data = JSON.parse(await readFile(`${destination}.appdata.json`, 'utf8')) as {
          timeline?: { visible?: boolean };
        };
        return data.timeline?.visible;
      })
      .toBe(true);

    expect(await readFile(source, 'utf8')).toBe(sourceTextBefore);
    expect(await readFile(`${source}.bible.json`, 'utf8')).toBe(sourceBibleBefore);
    expect(await readFile(`${source}.appdata.json`, 'utf8')).toBe(sourceAppDataBefore);

    await openPath(running.app, running.page, source);
    await expect(running.page.locator('.cm-content')).not.toContainText('B_ONLY_FOUNTAIN_TEXT');
    await expect(running.page.locator('.status-revision')).toContainText('Blue');
    await runCommand(running.app, 'file.bible');
    bible = running.page.locator('.bible-dialog');
    await bible.locator('.rail-row').click();
    await expect(bible.getByLabel('Role in the story')).toHaveValue(
      'Pending Bible role at Save As',
    );
    await expect(bible.getByLabel('Role in the story')).not.toHaveValue('B_ONLY_BIBLE_ROLE');
  } finally {
    await dispose(running.app);
  }
});

test('an invalid source sidecar fails Save As without switching path or changing B', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-save-as-failure-'));
  const source = join(userData, 'A.fountain');
  const destination = join(userData, 'B.fountain');
  await writeFile(source, ORIGINAL, 'utf8');
  await writeFile(destination, 'B_EXISTING_CONTENT', 'utf8');
  await writeFile(`${destination}.appdata.json`, '{"version":1,"destination":"keep"}', 'utf8');
  await mkdir(`${source}.bible.json`);
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, source);
    await chooseSaveAs(app, destination);
    await runCommand(app, 'file.saveAs');
    await expect(page.locator('.status-message')).toContainText('Save failed');
    await expect(page.locator('.tab-active .tab-name')).toHaveText('A.fountain');
    expect(await readFile(destination, 'utf8')).toBe('B_EXISTING_CONTENT');
    expect(await readFile(`${destination}.appdata.json`, 'utf8')).toBe(
      '{"version":1,"destination":"keep"}',
    );
  } finally {
    await dispose(app);
  }
});

test('Save As to the current path behaves as a normal save and keeps its sidecars', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-save-as-same-'));
  const source = join(userData, 'A.fountain');
  await writeFile(source, ORIGINAL, 'utf8');
  await writeFile(`${source}.bible.json`, '{"version":1,"entries":[]}', 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPath(app, page, source);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nSAME_PATH_EDIT');
    await chooseSaveAs(app, source);
    await runCommand(app, 'file.saveAs');
    await expect(page.locator('.tab-active .tab-name')).toHaveText('A.fountain');
    await waitForFile(source, 'SAME_PATH_EDIT');
    expect(await readFile(`${source}.bible.json`, 'utf8')).toBe('{"version":1,"entries":[]}');
  } finally {
    await dispose(app);
  }
});
