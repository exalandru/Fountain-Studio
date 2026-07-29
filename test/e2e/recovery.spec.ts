import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Crash recovery (§4.9 and §7: no data loss possible).
 *
 * A crash is simulated by dropping an autosave snapshot into the profile by hand,
 * exactly as the application would have done before being killed, then starting up and
 * checking the work is offered back to the author.
 */
test('a snapshot left by an interrupted session is reopened at startup', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'quantum-draft-crash-'));
  await mkdir(join(userData, 'autosave'), { recursive: true });

  const lost = 'INT. WORKSHOP - NIGHT\n\nThis text was never saved.\n';
  await writeFile(
    join(userData, 'autosave', 'lost-tab.json'),
    JSON.stringify({ path: null, content: lost, savedAt: Date.now() }),
    'utf8',
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  // Pin the interface language: recovery messages are asserted in English below.
  env['LANG'] = 'en_US.UTF-8';
  env['LC_ALL'] = 'en_US.UTF-8';

  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--lang=en-US'],
    env,
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.cm-content');

    await expect(page.locator('.status-message')).toContainText('recovered');
    await expect(page.locator('.cm-content')).toContainText('This text was never saved.');
    // The recovered document is flagged unsaved: nothing was written behind the author's
    // back, it is their call.
    await expect(page.locator('.tab-active .tab-name')).toContainText('•');
  } finally {
    await app.close();
  }
});
