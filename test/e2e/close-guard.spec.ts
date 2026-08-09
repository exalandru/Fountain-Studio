import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openTrustedScreenplays } from './helpers/open.js';

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
  await page.waitForSelector('.cm-content');
  return { app, page };
}

async function openPaths(app: ElectronApplication, paths: string[]): Promise<void> {
  await openTrustedScreenplays(app, paths);
}

async function requestClose(app: ElectronApplication, response = 1): Promise<void> {
  await app.evaluate(({ BrowserWindow, dialog }, answer) => {
    dialog.showMessageBox = async () => ({ response: answer, checkboxChecked: false });
    BrowserWindow.getAllWindows()[0]?.close();
  }, response);
}

async function expectClosed(app: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => {
      try {
        return await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      } catch {
        return 0;
      }
    })
    .toBe(0);
}

async function dispose(app: ElectronApplication): Promise<void> {
  try {
    await requestClose(app, 1);
    await app.close();
  } catch {
    // The application may already have completed an approved close.
  }
}

test('native window close snapshots all dirty tabs and honours cancellation', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-close-'));
  const { app, page } = await launch(userData);

  try {
    await page.locator('.cm-content').click();
    await page.keyboard.type(' first dirty tab');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', {
        command: 'file.new',
      });
    });
    await expect(page.locator('.tab')).toHaveCount(2);
    await page.locator('.cm-content').click();
    await page.keyboard.type(' second dirty tab');

    await requestClose(app, 2);

    // Cancel keeps the window alive.
    await expect(page.locator('.cm-content')).toBeVisible();
    await expect
      .poll(async () => {
        try {
          return (await readdir(join(userData, 'autosave'))).filter((name) =>
            name.endsWith('.json'),
          ).length;
        } catch {
          return 0;
        }
      })
      .toBe(2);

    await requestClose(app, 1);
    await expectClosed(app);
  } finally {
    await dispose(app);
  }
});

test('an autosave failure keeps the dirty window open and can be retried', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-close-error-'));
  const blocker = join(userData, 'autosave');
  await writeFile(blocker, 'not a directory', 'utf8');
  const { app, page } = await launch(userData);

  try {
    await page.evaluate(() => window.quantum.invoke('settings:patch', { autosaveSeconds: 1 }));
    await page.locator('.cm-content').click();
    await page.keyboard.type(' data that must survive');

    await expect(page.locator('.status-message')).toContainText('Crash recovery could not');
    await page.evaluate(() => window.quantum.invoke('settings:patch', { autosaveSeconds: 0 }));
    await requestClose(app, 1);
    await expect(page.locator('.cm-content')).toContainText('data that must survive');
    await expect(page.locator('.tab-active .tab-name')).toContainText('•');
    await expect(page.locator('.status-message')).toContainText('window stayed open');

    await unlink(blocker);
    await requestClose(app, 2);
    await expect(page.locator('.cm-content')).toBeVisible();
    await expect
      .poll(
        async () =>
          (await readdir(join(userData, 'autosave'))).filter((name) => name.endsWith('.json'))
            .length,
      )
      .toBe(1);

    await requestClose(app, 1);
    await expectClosed(app);
  } finally {
    await unlink(blocker).catch(() => undefined);
    await dispose(app);
  }
});

test('window close retains Bible prose until a failed write is acknowledged on retry', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-close-bible-'));
  const screenplay = join(userData, 'bible-close.fountain');
  await writeFile(screenplay, 'INT. LAB - NIGHT\n\nAlice watches.\n\nALICE\nStill here.\n', 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPaths(app, [screenplay]);
    await expect(page.locator('.tab-active .tab-name')).toContainText('bible-close.fountain');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', {
        command: 'file.bible',
      });
    });
    const bible = page.locator('.bible-dialog');
    await bible.getByLabel('Name of the new sheet').fill('ALICE');
    await bible.getByRole('button', { name: 'New sheet' }).click();
    await expect(bible.locator('.rail-row')).toHaveCount(1);

    const sidecar = `${screenplay}.bible.json`;
    await unlink(sidecar);
    await mkdir(sidecar);
    await bible.getByLabel('Role in the story').fill('Persisted by the close transaction.');
    await requestClose(app);
    await expect(bible).toBeVisible();
    await expect(page.locator('.status-message')).toContainText('window stayed open');

    await rmdir(sidecar);
    await requestClose(app);
    await expectClosed(app);

    const saved = JSON.parse(await readFile(sidecar, 'utf8')) as {
      entries?: Array<{ fields?: Record<string, string> }>;
    };
    expect(saved.entries?.[0]?.fields?.['role']).toBe('Persisted by the close transaction.');
  } finally {
    await rmdir(`${screenplay}.bible.json`).catch(() => undefined);
    await dispose(app);
  }
});

test('appdata survives both a document switch and a close before the debounce', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-close-appdata-'));
  const first = join(userData, 'first.fountain');
  const second = join(userData, 'second.fountain');
  await writeFile(first, 'INT. FIRST - DAY\n\nFirst.\n', 'utf8');
  await writeFile(second, 'INT. SECOND - NIGHT\n\nSecond.\n', 'utf8');
  const { app, page } = await launch(userData);

  try {
    await openPaths(app, [first, second]);
    await expect(page.locator('.tab-active .tab-name')).toContainText('second.fountain');

    await page.getByRole('tab', { name: /first\.fountain/ }).click();
    await page.locator('.timeline').getByRole('button', { name: 'Close timeline' }).click();
    await page.getByRole('tab', { name: /second\.fountain/ }).click();
    await page.locator('.timeline').getByRole('button', { name: 'Close timeline' }).click();
    await requestClose(app);
    await expectClosed(app);

    for (const path of [first, second]) {
      const saved = JSON.parse(await readFile(`${path}.appdata.json`, 'utf8')) as {
        timeline?: { visible?: boolean };
      };
      expect(saved.timeline?.visible).toBe(false);
    }
  } finally {
    await dispose(app);
  }
});
