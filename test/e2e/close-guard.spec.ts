import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect, test } from '@playwright/test';

test('native window close snapshots all dirty tabs and honours cancellation', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-close-'));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  env['LANG'] = 'en_US.UTF-8';
  env['LC_ALL'] = 'en_US.UTF-8';

  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--lang=en-US'],
    env,
  });
  let closed = false;

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.cm-content');

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

    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
      BrowserWindow.getAllWindows()[0]?.close();
    });

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

    await app.evaluate(({ BrowserWindow, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    await app.close();
    closed = true;
  } finally {
    if (!closed) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      });
      await app.close();
    }
  }
});
