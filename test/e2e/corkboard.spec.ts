import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The corkboard.
 *
 * This is the only view that rewrites the screenplay, so every test here checks the *document*
 * and not the cards: a board that reorders itself while the script stays put would look
 * perfectly correct. The cutting itself is unit-tested; what matters here is that the gesture
 * reaches the editor, lands one undo step, and does not touch what it should not.
 */

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let userData: string;
let screenplay: string;

const ORIGINAL = `Title: Board

INT. LABO - NUIT #7#

Alice observe les serveurs.

EXT. RUE - JOUR #12#

Boris traverse.

INT. CAVE - NUIT #3#

Le noir complet.
`;

async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

/** The screenplay as the editor renders it, lines run together. */
async function screenplayText(): Promise<string> {
  return page.locator('.cm-content').innerText();
}

/**
 * Scene headings in document order, taken from the editor's own lines.
 *
 * The declared number is stripped: whether `#7#` is drawn in the line or moved into the
 * gutter is a display setting, and this is a test about order.
 */
async function headings(): Promise<string[]> {
  const lines = await page.locator('.cm-content .cm-line').allInnerTexts();
  return lines
    .map((text) => text.trim())
    .filter((text) => /^(INT|EXT)\./.test(text))
    .map((text) => text.replace(/\s*#[^#]*#\s*$/, ''));
}

const board = (): Locator => page.locator('.corkboard');
const cards = (): Locator => page.locator('.corkboard-card');

/** Drags a card onto another card's far side, with real pointer events. */
async function dragCard(from: number, to: number, side: 'left' | 'right'): Promise<void> {
  const source = await cards().nth(from).boundingBox();
  const destination = await cards().nth(to).boundingBox();
  expect(source).not.toBeNull();
  expect(destination).not.toBeNull();
  if (!source || !destination) return;

  await page.mouse.move(source.x + 8, source.y + source.height - 8);
  await page.mouse.down();
  const x = side === 'right' ? destination.x + destination.width - 6 : destination.x + 6;
  await page.mouse.move(x, destination.y + destination.height / 2, { steps: 12 });
  await page.mouse.up();
}

test.beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'quantum-draft-corkboard-'));
  screenplay = join(userData, 'board.fountain');
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

test('opens from the toolbar with one card per scene', async () => {
  await page.getByRole('button', { name: 'Corkboard', exact: true }).click();
  await expect(board()).toBeVisible();
  await expect(cards()).toHaveCount(3);

  // The card carries what a board is read for: the number, the heading and the length.
  await expect(cards().nth(0)).toContainText('INT. LABO - NUIT');
  await expect(cards().nth(0).locator('.corkboard-number')).toHaveText('7');
  await expect(cards().nth(2)).toContainText('INT. CAVE - NUIT');

  // The editor is still there underneath: it is what applies every move.
  await expect(page.locator('.cm-content')).toBeAttached();
});

test('dragging a card rewrites the screenplay, and one undo puts it back', async () => {
  expect(await headings()).toEqual(['INT. LABO - NUIT', 'EXT. RUE - JOUR', 'INT. CAVE - NUIT']);

  await dragCard(0, 2, 'right');

  await expect
    .poll(headings)
    .toEqual(['EXT. RUE - JOUR', 'INT. CAVE - NUIT', 'INT. LABO - NUIT']);
  // The body followed its heading rather than staying behind.
  const moved = await screenplayText();
  expect(moved.indexOf('Alice observe')).toBeGreaterThan(moved.indexOf('Le noir complet.'));
  // Declared numbers are locked numbers: the order changed, they did not.
  await expect(cards().nth(0).locator('.corkboard-number')).toHaveText('12');

  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(headings)
    .toEqual(['INT. LABO - NUIT', 'EXT. RUE - JOUR', 'INT. CAVE - NUIT']);
  // And the board follows the document back. Left showing the order it had optimistically
  // drawn, the next gesture would be aimed at the wrong scene.
  await expect
    .poll(() => cards().locator('.corkboard-heading').allInnerTexts())
    .toEqual(['INT. LABO - NUIT', 'EXT. RUE - JOUR', 'INT. CAVE - NUIT']);
});

test('a card moves with Alt and an arrow', async () => {
  await cards().nth(0).focus();
  await page.keyboard.press('Alt+ArrowRight');

  await expect
    .poll(headings)
    .toEqual(['EXT. RUE - JOUR', 'INT. LABO - NUIT', 'INT. CAVE - NUIT']);
  await expect(page.locator('.status-message')).toContainText('position 2');

  // Undo reaches the editor even though a card holds the focus.
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(headings)
    .toEqual(['INT. LABO - NUIT', 'EXT. RUE - JOUR', 'INT. CAVE - NUIT']);
  await expect
    .poll(() => cards().locator('.corkboard-heading').allInnerTexts())
    .toEqual(['INT. LABO - NUIT', 'EXT. RUE - JOUR', 'INT. CAVE - NUIT']);
});

test('writing a synopsis on a card inserts it under the right heading', async () => {
  const synopsis = cards().nth(1).locator('.corkboard-synopsis');
  await synopsis.fill('Boris hésite au carrefour.');
  // Committed on blur, like every other field in the application.
  await cards().nth(0).locator('.corkboard-synopsis').click();

  await expect(page.locator('.cm-content')).toContainText('= Boris hésite au carrefour.');
  // Under its own heading, not appended to the end of the scene or of the script.
  await expect
    .poll(async () => {
      const lines = await page.locator('.cm-content .cm-line').allInnerTexts();
      const heading = lines.findIndex((line) => line.trim().startsWith('EXT. RUE'));
      return lines[heading + 1]?.trim();
    })
    .toBe('= Boris hésite au carrefour.');

  // It comes back on the card from the document, not from what was typed: closing the board
  // throws the draft away.
  await runCommand('view.toggleCorkboard');
  await runCommand('view.toggleCorkboard');
  await expect(cards().nth(1).locator('.corkboard-synopsis')).toHaveValue(
    'Boris hésite au carrefour.',
  );
});

test('says where a synopsis went when the script is not showing them', async () => {
  // Written with synopses hidden, the `=` line is really there and really saved — and
  // invisible, which reads as lost.
  await page.evaluate(() => window.quantum.invoke('settings:patch', { showSynopses: false }));

  const synopsis = cards().nth(2).locator('.corkboard-synopsis');
  await synopsis.fill('Le noir, et personne.');
  await cards().nth(0).locator('.corkboard-synopsis').click();

  await expect(page.locator('.status-message')).toContainText('Show Synopses');
  await expect(page.locator('.cm-content')).not.toContainText('Le noir, et personne.');

  await page.evaluate(() => window.quantum.invoke('settings:patch', { showSynopses: true }));
  await expect(page.locator('.cm-content')).toContainText('= Le noir, et personne.');
});

test('remembers being open in the companion file', async () => {
  await expect
    .poll(async () => {
      const raw = await readFile(`${screenplay}.appdata.json`, 'utf8').catch(() => '');
      return raw.includes('"corkboard"') && raw.includes('"visible": true');
    })
    .toBe(true);

  await board().getByRole('button', { name: 'Close corkboard' }).click();
  await expect(board()).toHaveCount(0);
  // The editor is reachable again the moment the board is gone.
  await page.locator('.cm-content').click();
});
