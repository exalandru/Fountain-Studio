import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openTrustedScreenplays } from './helpers/open.js';

/**
 * The script bible.
 *
 * The bible lives in a sidecar beside the screenplay, so this suite reads the disk as well as
 * the interface. Two guarantees matter more than the rest and are checked here rather than
 * only in unit tests: the sidecar never holds a computed fact, and a renamed character never
 * silently loses the prose written about them.
 *
 * The AI draft is not covered here — it needs the mock provider in `ai.spec.ts`. Its parser
 * and its context builder are unit-tested.
 */

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;
let screenplay: string;

const ORIGINAL = `Title: Bible

INT. LABO - NUIT

Alice observe les serveurs.

ALICE
Ils tiennent encore.

EXT. MÉGALOPOLE - JOUR

ALICE
Plus pour longtemps.

EXT. MÉGALOPOLE - REMPARTS - MINUIT

BORIS
Rien ne bouge.

EXT. MÉGALOPOLE - RUES - JOUR

Le vent balaie les pavés.
`;

async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

async function sidecar(): Promise<string> {
  return readFile(`${screenplay}.bible.json`, 'utf8');
}

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'fountain-studio-bible-'));
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

test('offers a sheet for a character the screenplay has, and writes the prose to disk', async () => {
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await expect(dialog).toBeVisible();

  // Nothing is seeded behind the author's back. The screenplay's names are suggestions on one
  // field rather than a button each, so the rail stays readable on a feature.
  await expect(dialog.locator('.rail-row')).toHaveCount(0);
  await expect(dialog.locator('.bible-compose-hint')).toContainText('no sheet yet');
  await dialog.getByLabel('Name of the new sheet').fill('ALICE');
  await dialog.getByRole('button', { name: 'New sheet' }).click();
  await expect(dialog.locator('.rail-row')).toHaveCount(1);
  await expect(dialog.locator('.rail-name')).toHaveText('ALICE');
  // One suggestion is spent, so the count drops: ALICE is no longer on offer.
  await expect(dialog.locator('.bible-compose-hint')).toContainText('1 name');

  // Naming the same character again opens the sheet instead of making a second one: two rows
  // called ALICE would both look right and only one would be the one being written.
  await dialog.getByLabel('Name of the new sheet').fill('alice');
  await dialog.getByRole('button', { name: 'New sheet' }).click();
  await expect(dialog.locator('.rail-row')).toHaveCount(1);

  // The facts are computed from the screenplay, not typed in.
  const facts = dialog.locator('.bible-facts');
  await expect(facts).toContainText('2 scenes');
  await expect(facts).toContainText('2 speeches');

  const role = dialog.getByLabel('Role in the story');
  await role.fill('Ingénieure système, seule à comprendre la panne.');
  // Saved on blur rather than on every keystroke.
  await dialog.getByLabel('What they want').click();

  await expect
    .poll(async () => {
      const data = JSON.parse(await sidecar()) as {
        entries?: Array<{ name?: string; fields?: Record<string, string> }>;
      };
      return data.entries?.[0]?.fields?.['role'];
    })
    .toContain('Ingénieure système');
});

test('never stores a computed fact in the sidecar', async () => {
  // The whole design rests on this: a stored fact starts lying the moment a scene is cut.
  const raw = await sidecar();
  expect(raw).not.toContain('speeches');
  expect(raw).not.toContain('scenes');
  expect(raw).not.toContain('firstScene');

  const data = JSON.parse(raw) as { entries?: Array<{ fields?: Record<string, string> }> };
  const fields = Object.keys(data.entries?.[0]?.fields ?? {});
  // Only prose field ids, and only the ones the sheet declares.
  expect(fields).toContain('role');
  expect(fields.every((field) => !['scenes', 'speeches', 'words'].includes(field))).toBe(true);
});

test('a renamed character is orphaned, not erased, and can be re-attached', async () => {
  await page.locator('.bible-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.bible-dialog')).toBeHidden();

  // Rename the character in the screenplay itself.
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(ORIGINAL.replace(/ALICE/g, 'EVE'));
  await expect(editor).toContainText('EVE');

  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await expect(dialog).toBeVisible();

  // The sheet is still there, marked as no longer matching anything.
  await expect(dialog.locator('.rail-detail')).toContainText('orphaned');
  await dialog.locator('.rail-row').first().click();
  await expect(dialog.locator('.bible-orphan')).toBeVisible();
  // And the author's prose is untouched — that is the point.
  await expect(dialog.getByLabel('Role in the story')).toHaveValue(/Ingénieure système/);
  // With nothing to measure, no measurement is shown rather than a row of zeros.
  await expect(dialog.locator('.bible-facts')).toContainText('Nothing to measure');

  await dialog.getByLabel('Attach this sheet to…').selectOption('EVE');
  await expect(dialog.locator('.bible-orphan')).toBeHidden();
  await expect(dialog.locator('.rail-name')).toHaveText('EVE');
  await expect(dialog.getByLabel('Role in the story')).toHaveValue(/Ingénieure système/);
  // Re-attached, the facts come back.
  await expect(dialog.locator('.bible-facts')).toContainText('2 speeches');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('finds a name typed without its accents, and adopts the screenplay’s spelling', async () => {
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Kind of sheet').selectOption('location');
  // The screenplay says MÉGALOPOLE; the author types what is on the keyboard.
  await dialog.getByLabel('Name of the new sheet').fill('megalopole');
  // The two sub-locations are offered; the exact match is not, because there is nothing left
  // to complete about it.
  const suggestions = dialog.locator('.bible-suggestions button');
  await expect(suggestions).toHaveCount(2);
  await expect(suggestions.first()).toContainText('MÉGALOPOLE - ');

  // And the list has to be *on screen*. The composer is pinned to the foot of the rail, so a
  // list rendered below the field had nowhere to go and was invisible while the filtering
  // behind it worked — the kind of bug a count assertion sails straight past.
  const inside = await dialog.evaluate((element) => {
    const list = element.querySelector('.bible-suggestions');
    if (list === null) return null;
    const popup = list.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    return {
      hasSize: popup.width > 0 && popup.height > 0,
      within: popup.top >= frame.top && popup.bottom <= frame.bottom,
    };
  });
  expect(inside).toEqual({ hasSize: true, within: true });

  // Creating from the unaccented spelling must not produce a sheet that is orphaned on the
  // spot: the screenplay's spelling wins.
  await dialog.getByRole('button', { name: 'New sheet' }).click();
  await expect(dialog.locator('.rail-row').filter({ hasText: 'MÉGALOPOLE' })).toHaveCount(1);
  await expect(dialog.locator('.bible-orphan')).toHaveCount(0);
  await expect(dialog.locator('.bible-facts')).toContainText('scene');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('folds a place’s sub-locations into one sheet, and lets it be undone', async () => {
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await dialog.getByRole('button', { name: 'Grouping' }).click();

  // Read from the screenplay's own naming, not guessed: MÉGALOPOLE - REMPARTS and - RUES.
  const group = dialog.locator('.bible-group');
  await expect(group).toHaveCount(1);
  await expect(group.locator('header strong')).toHaveText('MÉGALOPOLE');
  await expect(group.locator('li')).toHaveCount(2);
  // A checkbox is not a field to be filled. The dialog's blanket `input` rule gave it padding
  // and a background, which blew it up to twice its size — the same mistake the editor's
  // search panel once made with its match-case boxes.
  const box = await group.locator('input[type="checkbox"]').first().boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(20);
  expect(box?.height ?? 0).toBeLessThanOrEqual(20);

  await group.getByRole('button', { name: 'Group these' }).click();

  // One sheet for the city, and its scenes are the sum of the three names it now covers.
  await dialog.getByRole('button', { name: 'Sheets' }).click();
  const row = dialog.locator('.rail-row').filter({ hasText: 'MÉGALOPOLE' });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(dialog.locator('.bible-facts')).toContainText('3 scenes');
  await expect(dialog.locator('.bible-aliases li')).toHaveCount(2);

  // The sidecar records the names, not the counts.
  const data = JSON.parse(await sidecar()) as {
    entries?: Array<{ name?: string; aliases?: string[] }>;
  };
  const city = data.entries?.find((entry) => entry.name === 'MÉGALOPOLE');
  expect(city?.aliases).toHaveLength(2);
  expect(city?.aliases?.[0]).toContain('MÉGALOPOLE - ');

  // And it can be taken back: the grouping page offers the freed name again.
  await dialog
    .getByRole('button', { name: /^Stop covering/ })
    .first()
    .click();
  await expect(dialog.locator('.bible-aliases li')).toHaveCount(1);
  await expect(dialog.locator('.bible-facts')).toContainText('2 scenes');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('carries a picture in a real file beside the screenplay', async () => {
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await dialog.locator('.rail-row').first().click();

  // Without a picture, the initials stand in, so a sheet is still recognisable in the rail.
  const avatar = dialog.locator('.bible-avatar').first();
  await expect(avatar).toBeVisible();
  await expect(avatar.locator('img')).toHaveCount(0);

  // The native file chooser cannot be driven from a test, so the picture goes through the same
  // channels the panel uses. What is checked is what lands on disk and what the sheet records.
  const id = await page.evaluate(async (path) => {
    const bible = await window.quantum.invoke('bible:read', { path });
    const entry = bible.entries[0];
    if (entry === undefined) return null;
    // A 1×1 WebP: the smallest payload the main process accepts.
    const webp = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    const name = await window.quantum.invoke('bible:imageWrite', {
      path,
      id: entry.id,
      dataUri: webp,
    });
    await window.quantum.invoke('bible:write', {
      path,
      bible: {
        ...bible,
        entries: bible.entries.map((candidate) =>
          candidate.id === entry.id ? { ...candidate, image: name } : candidate,
        ),
      },
    });
    return entry.id;
  }, screenplay);
  expect(id).not.toBeNull();

  // A real file, in its own folder, that an author can open or replace without the app.
  const files = await readdir(`${screenplay}.bible.images`);
  expect(files).toEqual([`${id ?? ''}.webp`]);

  // Reopened, the sheet shows it — the picture travels as a data URI because the CSP allows
  // `data:` and not `file:`.
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await runCommand('file.bible');
  await dialog.locator('.rail-row').first().click();
  await expect(dialog.locator('.bible-avatar img').first()).toBeVisible();

  // Removing it takes the file with it.
  await dialog.getByRole('button', { name: 'Remove the picture' }).click();
  await expect(dialog.locator('.bible-avatar img')).toHaveCount(0);
  await expect.poll(async () => readdir(`${screenplay}.bible.images`)).toEqual([]);

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('refuses a picture that is not the format the renderer produces', async () => {
  // The main process does not trust what crossed the boundary: an SVG reaching an `img src`
  // would be a script running inside the panel.
  const refused = await page.evaluate(async (path) => {
    const results: string[] = [];
    for (const dataUri of [
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      try {
        await window.quantum.invoke('bible:imageWrite', { path, id: 'bib-probe', dataUri });
        results.push('accepted');
      } catch {
        results.push('refused');
      }
    }
    return results;
  }, screenplay);
  expect(refused).toEqual(['refused', 'refused']);
});

test('a draft does not follow the reader to another tab', async () => {
  // The panel is keyed by document. Without that the request outlives the switch and its
  // result lands in whichever bible is on screen — the wrong screenplay's.
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await dialog.locator('.rail-row').first().click();
  await expect(dialog.getByLabel('Sheet name')).toHaveValue(/./);

  await runCommand('file.new');
  await runCommand('file.bible');
  await expect(dialog).toBeVisible();
  // A fresh document: no sheet is selected, and the pane is back to its invitation.
  await expect(dialog.locator('.rail-row')).toHaveCount(0);
  await expect(dialog.locator('.panel-placeholder')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('an unsaved screenplay is told to save first rather than failing', async () => {
  await runCommand('file.new');
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.panel-placeholder')).toContainText('Save the screenplay first');
  await expect(dialog.locator('.rail')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});
