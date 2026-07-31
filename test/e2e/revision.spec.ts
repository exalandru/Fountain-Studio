import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Production revisions, from the author's side.
 *
 * What the exported PDF actually contains — the header, the asterisks, the lettered pages — is
 * asserted in `test/unit/pdf.test.ts`, where the bytes can be read back through pdf.js. This
 * suite covers the journey instead: locking numbers the scenes and files a reference, a scene
 * added afterwards is lettered rather than renumbered, and issuing a revision moves the colour
 * on. Those are the promises a crew depends on.
 */

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;
let screenplay: string;

const ORIGINAL = `Title: Rempart

INT. LABO - NUIT

Alice observe les serveurs.

EXT. RUE - JOUR

Boris traverse.

INT. CAVE - NUIT

Le noir complet.
`;

async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

/** Scene headings as the editor holds them, numbers included. */
async function headings(): Promise<string[]> {
  const lines = await page.locator('.cm-content .cm-line').allInnerTexts();
  return lines.map((text) => text.trim()).filter((text) => /^(INT|EXT)\./.test(text));
}

async function companion(): Promise<{
  revision?: { snapshotId?: string | null; colour?: string };
}> {
  const raw = await readFile(`${screenplay}.appdata.json`, 'utf8').catch(() => '{}');
  return JSON.parse(raw) as { revision?: { snapshotId?: string | null; colour?: string } };
}

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'fountain-studio-revision-'));
  screenplay = join(userData, 'rempart.fountain');
  await writeFile(screenplay, ORIGINAL, 'utf8');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  env['LANG'] = 'en_US.UTF-8';
  env['LC_ALL'] = 'en_US.UTF-8';

  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--lang=en-US'],
    env,
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.cm-content');
  await app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:openFiles', { paths: [path] });
  }, screenplay);
  await expect(page.locator('.cm-content')).toContainText('Alice observe les serveurs.');
});

test.afterAll(async () => {
  if (app) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await app.close();
  }
});

test('locking numbers every scene and files the draft as a reference', async () => {
  expect(await headings()).toEqual(['INT. LABO - NUIT', 'EXT. RUE - JOUR', 'INT. CAVE - NUIT']);
  await expect(page.locator('.status-revision')).toHaveCount(0);

  await runCommand('revision.lock');

  await expect
    .poll(headings)
    .toEqual(['INT. LABO - NUIT #1#', 'EXT. RUE - JOUR #2#', 'INT. CAVE - NUIT #3#']);
  await expect(page.locator('.status-message')).toContainText('3 scenes numbered');
  // The screenplay says what it is on, because every numbering decision now depends on it.
  await expect(page.locator('.status-revision')).toContainText('Blue');

  // The reference is a real snapshot, kept beside the screenplay.
  await expect.poll(async () => (await companion()).revision?.snapshotId ?? null).toMatch(/^snap-/);
  await runCommand('file.snapshots');
  const versions = page.locator('.snapshot-dialog');
  await expect(versions.locator('.rail-name')).toHaveText('Locked draft');
  // The reference holds the numbered screenplay, not the one from before the lock — otherwise
  // the numbering itself would read as a revision.
  await expect(versions.locator('.rail-detail')).toContainText('3 scenes');
  await versions.locator('.panel-close').click();
  await expect(versions).toHaveCount(0);
});

test('a scene added after the lock is lettered, not renumbered', async () => {
  // A new scene between 1 and 2. Renumbering everything here would rewrite the numbers a crew
  // is working from.
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type('\n\nEXT. TOIT - AUBE\n\nElle grimpe.');

  await runCommand('scene.renumber');

  await expect
    .poll(headings)
    .toEqual([
      'INT. LABO - NUIT #1#',
      'EXT. TOIT - AUBE #A2#',
      'EXT. RUE - JOUR #2#',
      'INT. CAVE - NUIT #3#',
    ]);
  await expect(page.locator('.status-message')).toContainText('1 new scenes numbered');
});

test('the export dialog offers the revision only once the screenplay is locked', async () => {
  await runCommand('file.exportPdf');
  const dialog = page.getByRole('dialog', { name: 'Export PDF' });
  await expect(dialog).toBeVisible();

  const section = dialog.locator('.pdf-revision');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Blue');
  await expect(section.getByLabel('Colour')).toHaveValue('header');
  await expect(section.getByLabel('Revision marks (*)')).toBeChecked();
  await expect(section.getByLabel('Locked page numbers')).toBeChecked();

  // The swatch shows the very tint the export would print.
  await expect(section.locator('.pdf-revision-swatch')).toHaveCSS(
    'background-color',
    'rgb(207, 224, 245)',
  );

  // The date defaults to the day the pages go out.
  const today = new Date().toISOString().slice(0, 10);
  await expect(section.getByLabel('Revision date')).toHaveValue(today);
});

test('a tinted page really is tinted, in the colour the swatch promised', async () => {
  const dialog = page.getByRole('dialog', { name: 'Export PDF' });
  await dialog.locator('.pdf-revision').getByLabel('Colour').selectOption('page');
  await expect(dialog.locator('canvas')).toBeVisible();

  // A fill colour cannot be extracted from a PDF's text, but the dialog draws the real bytes to
  // a canvas — so the paper is measured where it is visible. Asserting the colour rather than
  // merely "not white": a blank canvas would sail past that.
  await expect
    .poll(
      async () =>
        dialog.locator('canvas').evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const context = canvas.getContext('2d');
          // Halfway across, just below the top margin: tinted paper with nothing printed on it.
          const pixel = context?.getImageData(Math.floor(canvas.width / 2), 40, 1, 1).data;
          if (!pixel) return 'no pixel';
          const near = (value: number | undefined, target: number) =>
            value !== undefined && Math.abs(value - target) <= 6;
          // #cfe0f5, the blue paper of the shared table.
          return near(pixel[0], 207) && near(pixel[1], 224) && near(pixel[2], 245)
            ? 'blue paper'
            : `${pixel[0]},${pixel[1]},${pixel[2]}`;
        }),
      { timeout: 10_000 },
    )
    .toBe('blue paper');

  await dialog.locator('.pdf-revision').getByLabel('Colour').selectOption('header');
  await dialog.getByRole('button', { name: 'Close PDF export' }).click();
  await expect(dialog).toBeHidden();
});

test('issuing a revision moves the colour on and re-bases the comparison', async () => {
  const before = (await companion()).revision?.snapshotId;

  await runCommand('revision.issue');

  await expect(page.locator('.status-message')).toContainText('Blue pages issued');
  await expect(page.locator('.status-revision')).toContainText('Pink');
  // Each revision is compared against the previous one, not against the first draft.
  await expect.poll(async () => (await companion()).revision?.snapshotId).not.toBe(before);
  await expect.poll(async () => (await companion()).revision?.colour).toBe('pink');
});

test('unlocking leaves the numbers in the screenplay', async () => {
  await runCommand('revision.unlock');

  await expect(page.locator('.status-revision')).toHaveCount(0);
  await expect(page.locator('.status-message')).toContainText('numbers stay in the screenplay');
  // The numbers are characters in the file, not application state: unlocking does not undo them.
  expect(await headings()).toContain('INT. LABO - NUIT #1#');

  // And the command goes back to numbering everything in order.
  await runCommand('scene.renumber');
  await expect
    .poll(headings)
    .toEqual([
      'INT. LABO - NUIT #1#',
      'EXT. TOIT - AUBE #2#',
      'EXT. RUE - JOUR #3#',
      'INT. CAVE - NUIT #4#',
    ]);
});
