import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openTrustedScreenplays } from './helpers/open.js';

const BASELINE = 'INT. LAB - DAY #1#\n\nALICE\nORIGINAL LINE\n';
const CURRENT = 'INT. LAB - DAY #1#\n\nALICE\nCURRENT REVISED LINE\n';

interface Fixture {
  app: ElectronApplication;
  page: Page;
  path: string;
  snapshotId: string | null;
  snapshotFile: string | null;
  userData: string;
}

function appData(snapshotId: string | null) {
  return {
    version: 1,
    sidebar: {
      visible: true,
      activeTab: 'structure',
      width: 280,
      filter: '',
      showSynopses: true,
    },
    preview: { visible: true, width: 320, syncScroll: false, activeTab: 'statistics' },
    timeline: { visible: true, uniformWidth: false, colorMode: 'intExt', zoom: 1 },
    corkboard: { visible: false, colorMode: 'intExt', cardWidth: 240 },
    revision: { snapshotId, lockedAt: snapshotId ? Date.now() : null, colour: 'blue' },
    rewrite: { lastTone: 'neutral', customStyle: '' },
    inconsistencies: { items: [], analyzedAt: null },
    voiceConsistency: {},
    repetitions: { items: [], analyzedAt: null },
  };
}

function snapshotStamp(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

async function launchFixture(options: {
  baseline?: string;
  current?: string;
  corrupt?: boolean;
  missing?: boolean;
}): Promise<Fixture> {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-pdf-fail-closed-'));
  const path = join(userData, 'production.fountain');
  await writeFile(path, options.current ?? CURRENT, 'utf8');

  let snapshotId: string | null = null;
  let snapshotFile: string | null = null;
  if (options.baseline !== undefined) {
    snapshotId = `snap-${randomUUID()}`;
    const createdAt = Date.now();
    const directory = `${path}.snapshots`;
    await mkdir(directory, { recursive: true });
    const meta = {
      id: snapshotId,
      name: 'Locked draft',
      createdAt,
      byteLength: Buffer.byteLength(options.baseline, 'utf8'),
      lineCount: options.baseline.length === 0 ? 0 : options.baseline.split(/\r?\n/).length,
      sceneCount: options.baseline.includes('INT. LAB') ? 1 : 0,
    };
    snapshotFile = join(
      directory,
      `${snapshotStamp(createdAt)}-locked-draft-${snapshotId}.fountain`,
    );
    await writeFile(
      snapshotFile,
      options.corrupt ? 'CORRUPTED SNAPSHOT CONTENT' : options.baseline,
      'utf8',
    );
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({ version: 1, snapshots: [meta] }, null, 2),
      'utf8',
    );
    if (options.missing) await unlink(snapshotFile);
  }
  await writeFile(`${path}.appdata.json`, JSON.stringify(appData(snapshotId), null, 2), 'utf8');

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
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content');
  await openTrustedScreenplays(app, [path]);
  await expect(page.locator('.cm-content')).toContainText('CURRENT REVISED LINE');
  if (snapshotId) await expect(page.locator('.status-revision')).toContainText('Blue');
  return { app, page, path, snapshotId, snapshotFile, userData };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await fixture.app.close();
}

async function runCommand(app: ElectronApplication, command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

async function openPdf(fixture: Fixture) {
  await runCommand(fixture.app, 'file.exportPdf');
  const dialog = fixture.page.getByRole('dialog', { name: 'Export PDF' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function setExportTarget(fixture: Fixture, name: string): Promise<string> {
  const target = join(fixture.userData, name);
  await fixture.app.evaluate(({ dialog, shell }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    shell.showItemInFolder = () => {};
  }, target);
  return target;
}

async function expectExportedPdf(dialog: ReturnType<Page['getByRole']>, target: string) {
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => {
      try {
        return (await readFile(target)).subarray(0, 5).toString();
      } catch {
        return '';
      }
    })
    .toBe('%PDF-');
}

async function installDelayedSnapshotReads(fixture: Fixture): Promise<void> {
  await fixture.app.evaluate(({ ipcMain }) => {
    const scope = globalThis as typeof globalThis & {
      __pdfReads?: {
        started: string[];
        releases: Map<string, (content: string) => void>;
      };
    };
    scope.__pdfReads = { started: [], releases: new Map() };
    ipcMain.removeHandler('snapshot:read');
    ipcMain.handle('snapshot:read', async (_event, argument: { id: string }) => {
      const state = scope.__pdfReads;
      if (!state) throw new Error('Missing PDF read state');
      state.started.push(argument.id);
      return new Promise<string>((resolve) => state.releases.set(argument.id, resolve));
    });
  });
}

async function startedReads(fixture: Fixture): Promise<string[]> {
  return fixture.app.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __pdfReads?: { started: string[] } };
    return scope.__pdfReads?.started ?? [];
  });
}

async function releaseRead(fixture: Fixture, id: string, content: string): Promise<void> {
  await fixture.app.evaluate(
    (_electron, value) => {
      const scope = globalThis as typeof globalThis & {
        __pdfReads?: { releases: Map<string, (content: string) => void> };
      };
      const release = scope.__pdfReads?.releases.get(value.id);
      scope.__pdfReads?.releases.delete(value.id);
      release?.(value.content);
    },
    { id, content },
  );
}

test('an ordinary export still previews and writes a PDF without a baseline', async () => {
  const fixture = await launchFixture({});
  try {
    const target = await setExportTarget(fixture, 'ordinary.pdf');
    const dialog = await openPdf(fixture);
    const exportButton = dialog.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toBeEnabled();
    await exportButton.click();
    await expectExportedPdf(dialog, target);
  } finally {
    await closeFixture(fixture);
  }
});

test('a missing locked snapshot blocks the UI and an incoherent main invocation', async () => {
  const fixture = await launchFixture({ baseline: BASELINE, missing: true });
  try {
    const dialog = await openPdf(fixture);
    await expect(dialog.getByRole('alert')).toContainText('production reference');
    await expect(dialog.getByRole('button', { name: 'Export…' })).toBeDisabled();
    await expect(dialog).toHaveAttribute('data-page-count', '0');

    const result = await fixture.page.evaluate(
      async ({ source }) => {
        const invoke = window.quantum.invoke as unknown as (
          channel: string,
          argument: unknown,
        ) => Promise<unknown>;
        try {
          await invoke('pdf:render', {
            source,
            options: {
              format: 'a4',
              sceneNumbers: 'both',
              includeNotes: false,
              includeSynopses: false,
              headingsBold: true,
              watermark: '',
              pageFrom: null,
              pageTo: null,
              revision: {
                header: 'BLUE REVISION',
                colour: 'blue',
                colourMode: 'header',
                marks: true,
                lockedPages: true,
                onlyRevisedPages: false,
              },
            },
          });
          return 'accepted';
        } catch (error) {
          return String(error);
        }
      },
      { source: CURRENT },
    );
    expect(result).toContain('Invalid payload');
  } finally {
    await closeFixture(fixture);
  }
});

test('snapshot content inconsistent with its metadata is rejected as corrupt', async () => {
  const fixture = await launchFixture({ baseline: BASELINE, corrupt: true });
  try {
    const dialog = await openPdf(fixture);
    await expect(dialog.getByRole('alert')).toContainText('production reference');
    await expect(dialog.getByRole('button', { name: 'Export…' })).toBeDisabled();
    await expect(dialog.locator('canvas')).toBeHidden();
    await expect(dialog.locator('.pdf-preview-controls')).toHaveCount(0);
  } finally {
    await closeFixture(fixture);
  }
});

test('a slow baseline cannot expose an ordinary preview or enable Export', async () => {
  const fixture = await launchFixture({ baseline: BASELINE });
  try {
    if (!fixture.snapshotId) throw new Error('Missing snapshot fixture');
    await installDelayedSnapshotReads(fixture);
    const target = await setExportTarget(fixture, 'locked.pdf');
    const dialog = await openPdf(fixture);
    await expect.poll(() => startedReads(fixture)).toEqual([fixture.snapshotId]);
    const exportButton = dialog.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toBeDisabled();
    await expect(dialog).toHaveAttribute('data-page-count', '0');
    await expect(dialog).toContainText('Loading and validating');

    await releaseRead(fixture, fixture.snapshotId, BASELINE);
    await expect(exportButton).toBeEnabled();
    await exportButton.click();
    await expectExportedPdf(dialog, target);
  } finally {
    await closeFixture(fixture);
  }
});

test('a late baseline A cannot replace a newer revision baseline B', async () => {
  const fixture = await launchFixture({ baseline: BASELINE });
  try {
    const snapshotA = fixture.snapshotId;
    if (!snapshotA) throw new Error('Missing snapshot A');
    await installDelayedSnapshotReads(fixture);
    const dialog = await openPdf(fixture);
    await expect.poll(() => startedReads(fixture)).toEqual([snapshotA]);

    await runCommand(fixture.app, 'revision.issue');
    await expect(fixture.page.locator('.status-message')).toContainText('Blue pages issued');
    await expect
      .poll(async () => {
        const data = JSON.parse(await readFile(`${fixture.path}.appdata.json`, 'utf8')) as {
          revision?: { snapshotId?: string };
        };
        return data.revision?.snapshotId ?? '';
      })
      .not.toBe(snapshotA);
    const currentB = JSON.parse(await readFile(`${fixture.path}.appdata.json`, 'utf8')) as {
      revision?: { snapshotId?: string };
    };
    const idB = currentB.revision?.snapshotId;
    if (!idB) throw new Error('Missing snapshot B');
    await expect.poll(() => startedReads(fixture)).toEqual([snapshotA, idB]);

    await releaseRead(fixture, idB, CURRENT);
    const exportButton = dialog.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toBeEnabled();
    await releaseRead(fixture, snapshotA, BASELINE);
    if (fixture.snapshotFile) await unlink(fixture.snapshotFile);

    const target = await setExportTarget(fixture, 'newer-baseline.pdf');
    await exportButton.click();
    await expectExportedPdf(dialog, target);
  } finally {
    await closeFixture(fixture);
  }
});

test('switching documents closes a dialog whose baseline read is still pending', async () => {
  const fixture = await launchFixture({ baseline: BASELINE });
  try {
    if (!fixture.snapshotId) throw new Error('Missing snapshot fixture');
    await installDelayedSnapshotReads(fixture);
    const dialog = await openPdf(fixture);
    await expect.poll(() => startedReads(fixture)).toEqual([fixture.snapshotId]);
    await runCommand(fixture.app, 'file.new');
    await expect(dialog).toBeHidden();
    await releaseRead(fixture, fixture.snapshotId, BASELINE);
    await expect(fixture.page.locator('.tab-active .tab-name')).toContainText('Untitled');
  } finally {
    await closeFixture(fixture);
  }
});

test('returning to ordinary mode ignores a late locked-baseline response', async () => {
  const fixture = await launchFixture({ baseline: BASELINE });
  try {
    if (!fixture.snapshotId) throw new Error('Missing snapshot fixture');
    await installDelayedSnapshotReads(fixture);
    const target = await setExportTarget(fixture, 'unlocked.pdf');
    const dialog = await openPdf(fixture);
    await expect.poll(() => startedReads(fixture)).toEqual([fixture.snapshotId]);
    await runCommand(fixture.app, 'revision.unlock');
    const exportButton = dialog.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toBeEnabled();
    await releaseRead(fixture, fixture.snapshotId, BASELINE);
    await expect(dialog.locator('.pdf-revision')).toHaveCount(0);
    await exportButton.click();
    await expectExportedPdf(dialog, target);
  } finally {
    await closeFixture(fixture);
  }
});

test('an empty but indexed snapshot is a valid locked baseline', async () => {
  const fixture = await launchFixture({ baseline: '' });
  try {
    const dialog = await openPdf(fixture);
    await expect(dialog.getByRole('button', { name: 'Export…' })).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.locator('.pdf-revision')).toBeVisible();
  } finally {
    await closeFixture(fixture);
  }
});

test('deleting the validated snapshot between preview and export fails closed', async () => {
  const fixture = await launchFixture({ baseline: BASELINE });
  try {
    const dialog = await openPdf(fixture);
    const exportButton = dialog.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toBeEnabled();
    if (!fixture.snapshotFile) throw new Error('Missing snapshot file');
    await unlink(fixture.snapshotFile);
    const target = await setExportTarget(fixture, 'must-not-exist.pdf');
    await exportButton.click();
    await expect(dialog.getByRole('alert')).toContainText('production reference');
    await expect(exportButton).toBeDisabled();
    await expect(
      readFile(target)
        .then(() => true)
        .catch(() => false),
    ).resolves.toBe(false);
  } finally {
    await closeFixture(fixture);
  }
});
