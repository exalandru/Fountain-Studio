import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect, test } from '@playwright/test';

function longScreenplay(): string {
  const lines: string[] = [];
  for (let scene = 1; scene <= 300; scene++) {
    lines.push(
      `INT. LOCATION ${scene} - DAY #${scene}#`,
      '',
      'An action line long enough to occupy the screenplay page.',
      '',
      'WRITER',
      'A line of dialogue for the virtualised preview.',
      '',
    );
  }
  return lines.join('\n');
}

test('a feature-length preview stays virtualised and syncs both scroll directions', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-preview-'));
  const screenplay = join(userData, 'feature.fountain');
  await writeFile(screenplay, longScreenplay(), 'utf8');

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

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.cm-content');
    await app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('app:openFiles', { paths: [path] });
    }, screenplay);

    await expect(page.locator('.statusbar')).toContainText('300 scenes');
    const widths = await page.evaluate(() => {
      const width = (selector: string) =>
        Math.round(document.querySelector(selector)?.getBoundingClientRect().width ?? 0);
      return {
        viewport: window.innerWidth,
        workspace: width('.workspace'),
        document: width('.workspace-document'),
        layout: width('.workspace-layout'),
        editor: width('.workspace-editor'),
        codeMirror: width('.cm-editor'),
        timeline: width('.timeline'),
        timelineClient: document.querySelector('.timeline-track')?.clientWidth ?? 0,
        timelineScroll: document.querySelector('.timeline-track')?.scrollWidth ?? 0,
      };
    });
    for (const key of ['workspace', 'document', 'layout', 'codeMirror', 'timeline'] as const) {
      expect(widths[key], JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport + 1);
    }
    expect(widths.timelineScroll).toBeGreaterThan(widths.timelineClient);

    await page.getByRole('tab', { name: 'Preview' }).click();
    const papers = page.locator('.preview-paper');
    expect(await papers.count()).toBeLessThanOrEqual(7);

    await page.getByLabel('Sync scroll with editor').check();
    await page.locator('.cm-scroller').evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight * 0.6;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() => page.locator('.preview-scroll').evaluate((scroller) => scroller.scrollTop))
      .toBeGreaterThan(1_000);

    await page.locator('.preview-scroll').evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight * 0.25;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() => page.locator('.cm-scroller').evaluate((scroller) => scroller.scrollTop))
      .toBeGreaterThan(500);

    expect(
      await papers.evaluateAll((pages) =>
        Math.max(...pages.map((paper) => Number(paper.getAttribute('data-page') ?? 0))),
      ),
    ).toBeGreaterThan(8);
  } finally {
    await app.close();
  }
});
