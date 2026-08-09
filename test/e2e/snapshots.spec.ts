import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openTrustedScreenplays } from './helpers/open.js';

/**
 * Named snapshots and version comparison.
 *
 * The snapshots live in a sidecar directory beside the screenplay, so this suite checks the
 * disk as well as the interface: the point of the sidecar is that an author can recover a
 * version by hand.
 */

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;
let screenplay: string;

const ORIGINAL = `Title: Instantanés

INT. LABO - NUIT

Alice observe les serveurs.

EXT. RUE - JOUR

Elle court.
`;

function snapshotDir(): string {
  return `${screenplay}.snapshots`;
}

async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'fountain-studio-snapshots-'));
  screenplay = join(userData, 'story.fountain');
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
  await openTrustedScreenplays(app, [screenplay]);
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

test('takes a snapshot, and writes it as a readable file beside the screenplay', async () => {
  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.snapshot-empty')).toBeVisible();

  await dialog.getByLabel('Snapshot name').fill('avant acte III');
  await dialog.getByRole('button', { name: 'Take a snapshot' }).click();

  await expect(dialog.locator('.rail-row')).toHaveCount(1);
  await expect(dialog.locator('.rail-name')).toHaveText('avant acte III');
  // 9 lines, 2 scenes: the metadata is recorded so the list needs no file reads.
  await expect(dialog.locator('.rail-detail')).toContainText('2 scenes');

  const entries = await readdir(snapshotDir());
  expect(entries).toContain('index.json');
  const fountain = entries.find((entry) => entry.endsWith('.fountain'));
  expect(fountain).toBeDefined();
  // The whole point of the sidecar: a plain, complete, hand-recoverable screenplay.
  expect(await readFile(join(snapshotDir(), fountain ?? ''), 'utf8')).toBe(ORIGINAL);
  expect(fountain).toContain('avant-acte-iii');

  // The version just taken is selected, so its name is ready to be corrected.
  await expect(dialog.getByLabel('New name for this snapshot')).toHaveValue('avant acte III');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('summarises the difference in scenes, and restores through the undo history', async () => {
  // Rewrite one line and add a scene.
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(
    ORIGINAL.replace('Elle court.', 'Elle ralentit, puis s’arrête.') +
      '\nINT. TOIT - AUBE\n\nElle respire.\n',
  );
  await expect(editor).toContainText('Elle respire.');

  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await dialog.locator('.rail-row').first().click();

  await expect(dialog.locator('.snapshot-scene-summary')).toContainText('1 scene modified');
  await expect(dialog.locator('.snapshot-scene-summary')).toContainText('1 scene added');
  await expect(dialog.locator('.snapshot-line-summary')).toContainText('lines');
  // Only the changed regions are in the DOM, not the whole document.
  await expect(dialog.locator('.snapshot-line.is-removed').first()).toContainText('Elle court.');
  await expect(dialog.locator('.snapshot-line.is-added').first()).toContainText('ralentit');

  await dialog.getByRole('button', { name: 'Restore this version' }).click();
  await expect(dialog).toBeHidden();
  await expect(editor).toContainText('Elle court.');
  await expect(editor).not.toContainText('Elle respire.');
  await expect(page.locator('.status-message')).toContainText('restored');

  // Restoring goes through the editor, so the author's text is one undo away.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText('Elle respire.');
});

test('renames a version, moving its file on disk', async () => {
  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await dialog.locator('.rail-row').first().click();

  const field = dialog.getByLabel('New name for this snapshot');
  await expect(field).toHaveValue('avant acte III');
  // The action stays out of reach until the name actually differs.
  const button = dialog.getByRole('button', { name: 'Rename' });
  await expect(button).toBeDisabled();
  await field.fill('v2 producteur');
  await button.click();

  await expect(dialog.locator('.rail-name')).toHaveText('v2 producteur');
  const entries = await readdir(snapshotDir());
  expect(entries.some((entry) => entry.includes('v2-producteur'))).toBe(true);
  expect(entries.some((entry) => entry.includes('avant-acte-iii'))).toBe(false);
  // Renaming moves the file, so the version must still be readable through the dialog.
  await expect(dialog.locator('.snapshot-diff')).toBeVisible();

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('a snapshot name cannot escape its folder', async () => {
  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await dialog.getByLabel('Snapshot name').fill('../../evasion');
  await dialog.getByRole('button', { name: 'Take a snapshot' }).click();
  await expect(dialog.locator('.rail-row')).toHaveCount(2);

  // Nothing may appear outside the sidecar directory — neither beside the screenplay nor
  // two levels up, where the traversal was aiming.
  const beside = await readdir(dirname(screenplay));
  expect(beside.filter((entry) => entry.includes('evasion'))).toEqual([]);
  const above = await readdir(dirname(dirname(screenplay)));
  expect(above.filter((entry) => entry.includes('evasion'))).toEqual([]);

  const entries = await readdir(snapshotDir());
  expect(entries.filter((entry) => entry.endsWith('.fountain'))).toHaveLength(2);
  expect(entries.some((entry) => entry.includes('..'))).toBe(false);

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('survives a corrupt index without losing the snapshot files', async () => {
  await writeFile(join(snapshotDir(), 'index.json'), '{ this is not json', 'utf8');

  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await expect(dialog).toBeVisible();
  // Damaged history is distinguishable from a genuinely empty list.
  await expect(dialog.getByRole('button', { name: 'Repair history' })).toBeVisible();
  await expect(dialog.locator('.rail-row')).toHaveCount(2);
  const entries = await readdir(snapshotDir());
  expect(entries.filter((entry) => entry.endsWith('.fountain'))).toHaveLength(2);

  await dialog.getByRole('button', { name: 'Repair history' }).click();
  await expect(dialog.getByRole('button', { name: 'Repair history' })).toHaveCount(0);
  await expect(dialog.locator('.rail-row')).toHaveCount(2);
  await expect(dialog.locator('.snapshot-empty')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('an unsaved screenplay is told to save first rather than failing', async () => {
  await runCommand('file.new');
  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.panel-placeholder')).toContainText('Save the screenplay first');
  await expect(dialog.getByRole('button', { name: 'Take a snapshot' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});
