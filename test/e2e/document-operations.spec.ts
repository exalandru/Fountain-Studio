import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openTrustedScreenplays } from './helpers/open.js';

test.describe.configure({ mode: 'serial' });

const A_CONTENT = 'INT. ALPHA - DAY\n\nALICE\nORIGINAL_TOKEN\n';
const B_CONTENT = 'INT. BETA - NIGHT\n\nBOB\nB_DOCUMENT_UNCHANGED\n';
const SNAPSHOT_CONTENT = 'INT. ALPHA - DAY\n\nALICE\nSNAPSHOT_VERSION\n';

let app: ElectronApplication;
let page: Page;
let userData: string;
let pathA: string;
let pathB: string;
let baseUrl: string;
let receivedAiRequests = 0;
const pendingAiResponses: Array<{
  response: ServerResponse;
  kind: 'rewrite' | 'inconsistency' | 'bible';
}> = [];
const pageErrors: string[] = [];

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    receivedAiRequests += 1;
    const body = Buffer.concat(chunks).toString('utf8');
    pendingAiResponses.push({
      response,
      kind: body.includes('Analyse the whole screenplay')
        ? 'inconsistency'
        : body.includes('Draft the bible sheet for')
          ? 'bible'
          : 'rewrite',
    });
  });
});

function releaseNextAiResponse(): void {
  const pending = pendingAiResponses.shift();
  if (!pending || pending.response.destroyed || pending.response.writableEnded) return;
  const { response } = pending;
  const content =
    pending.kind === 'inconsistency'
      ? JSON.stringify({
          items: [
            {
              type: 'continuity',
              severity: 'major',
              description: 'A_ONLY_FINDING',
              references: [],
              suggestion: '',
            },
          ],
        })
      : pending.kind === 'bible'
        ? JSON.stringify({ role: 'STALE_PATH_DRAFT' })
        : JSON.stringify({ variants: ['VARIANT ONE', 'VARIANT TWO', 'VARIANT THREE'] });
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.write(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            content,
          },
        },
      ],
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

async function runCommand(command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

async function activate(name: RegExp): Promise<void> {
  await page.getByRole('tab', { name }).click({ force: true });
  await expect(page.locator('.tab-active .tab-name')).toHaveText(name);
}

async function activatePath(path: string, name: RegExp): Promise<void> {
  await openTrustedScreenplays(app, [path]);
  await expect(page.locator('.tab-active .tab-name')).toHaveText(name);
}

async function selectLine(text: string): Promise<void> {
  await page.locator('.cm-line').filter({ hasText: text }).click({ clickCount: 3, force: true });
}

async function editorText(): Promise<string> {
  return (await page.locator('.cm-line').allTextContents()).join('\n');
}

async function startDelayedRewrite(): Promise<number> {
  await expect(page.locator('.status-timing')).toBeVisible();
  await selectLine('ORIGINAL_TOKEN');
  const expected = receivedAiRequests + 1;
  await runCommand('ai.rewrite');
  await expect.poll(() => receivedAiRequests).toBe(expected);
  return expected;
}

async function aiSettledCount(): Promise<number> {
  return page.evaluate(() => {
    const scope = window as typeof window & { __h4AiSettled?: number };
    return scope.__h4AiSettled ?? 0;
  });
}

async function snapshotReadsStarted(): Promise<number> {
  return app.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __h4SnapshotReads?: { started: number } };
    return scope.__h4SnapshotReads?.started ?? 0;
  });
}

async function releaseSnapshotRead(): Promise<void> {
  await app.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __h4SnapshotReads?: { releases: Array<() => void> };
    };
    scope.__h4SnapshotReads?.releases.shift()?.();
  });
}

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = await mkdtemp(join(tmpdir(), 'fountain-studio-document-operations-'));
  pathA = join(userData, 'alpha.fountain');
  pathB = join(userData, 'beta.fountain');
  await writeFile(pathA, A_CONTENT, 'utf8');
  await writeFile(pathB, B_CONTENT, 'utf8');

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
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForSelector('.cm-content');
  await page.evaluate(() => {
    const scope = window as typeof window & { __h4AiSettled?: number };
    scope.__h4AiSettled = 0;
    const settled = () => {
      scope.__h4AiSettled = (scope.__h4AiSettled ?? 0) + 1;
    };
    window.quantum.on('ai:done', settled);
    window.quantum.on('ai:error', settled);
  });

  await page.evaluate(
    async ({ endpoint }) => {
      await window.quantum.invoke('ai:config:save', {
        config: {
          version: 1,
          activeProfileId: 'h4-local',
          profiles: [
            {
              id: 'h4-local',
              name: 'H4 local',
              provider: 'openai',
              baseUrl: endpoint,
              model: 'h4-test',
              timeoutMs: 10_000,
              maxTokens: 1_024,
              reasoningEnabled: false,
            },
          ],
        },
        keyUpdates: [],
      });
    },
    { endpoint: baseUrl },
  );

  await openTrustedScreenplays(app, [pathA, pathB]);
  await expect(page.locator('.tab')).toHaveCount(3);

  const [snapshot] = await page.evaluate(
    ({ path, content }) =>
      window.quantum.invoke('snapshot:create', { path, name: 'H4 baseline', content }),
    { path: pathA, content: SNAPSHOT_CONTENT },
  );
  if (!snapshot) throw new Error('Snapshot fixture was not created');

  await app.evaluate(
    ({ ipcMain }, fixture) => {
      const scope = globalThis as typeof globalThis & {
        __h4SnapshotReads?: { started: number; releases: Array<() => void> };
      };
      scope.__h4SnapshotReads = { started: 0, releases: [] };
      ipcMain.removeHandler('snapshot:read');
      ipcMain.handle('snapshot:read', async (_event, argument: { path: string; id: string }) => {
        const state = scope.__h4SnapshotReads;
        if (!state) throw new Error('Missing H4 snapshot state');
        state.started += 1;
        await new Promise<void>((resolve) => state.releases.push(resolve));
        return argument.path === fixture.path ? fixture.content : 'B snapshot must not appear';
      });
    },
    { path: pathA, content: SNAPSHOT_CONTENT },
  );
});

test.afterAll(async () => {
  while (pendingAiResponses.length > 0) releaseNextAiResponse();
  if (app) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await app.close();
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('a delayed snapshot read from A never appears in B', async () => {
  await activate(/alpha\.fountain/);
  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await dialog.locator('.rail-row').click();
  await expect.poll(snapshotReadsStarted).toBe(1);

  await activatePath(pathB, /beta\.fountain/);
  await expect(dialog).toBeHidden();
  await releaseSnapshotRead();

  expect(await editorText()).toBe(B_CONTENT);
  await expect(page.locator('.cm-content')).not.toContainText('SNAPSHOT_VERSION');
  await runCommand('file.snapshots');
  await expect(dialog.locator('.rail-row')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('a snapshot loaded for an older revision cannot restore over newer text', async () => {
  await activate(/alpha\.fountain/);
  await runCommand('file.snapshots');
  const dialog = page.locator('.snapshot-dialog');
  await dialog.locator('.rail-row').click();
  await expect.poll(snapshotReadsStarted).toBe(2);
  await releaseSnapshotRead();
  const restore = dialog.getByRole('button', { name: 'Restore this version' });
  await expect(restore).toBeEnabled();

  const editor = page.locator('.cm-content');
  await runCommand('scene.renumber');
  await expect(editor).toContainText('#1#');

  await restore.click();
  await expect(dialog.locator('.ai-feedback')).toContainText('document changed');
  await expect(editor).toContainText('#1#');
  await expect(editor).not.toContainText('SNAPSHOT_VERSION');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('a delayed rewrite from A is cancelled on a switch and never mutates B', async () => {
  await activate(/alpha\.fountain/);
  await startDelayedRewrite();
  const rewrite = page.locator('.rewrite-popover');
  await expect(rewrite).toBeVisible();
  const settledBefore = await aiSettledCount();

  await activate(/beta\.fountain/);
  await expect(rewrite).toBeHidden();
  releaseNextAiResponse();
  await expect.poll(aiSettledCount).toBeGreaterThan(settledBefore);
  expect(await editorText()).toBe(B_CONTENT);
  await expect(page.locator('.cm-content')).not.toContainText('VARIANT ONE');
});

test('a delayed analysis from A never writes findings into B appdata', async () => {
  await activate(/alpha\.fountain/);
  await expect(page.locator('.status-timing')).toBeVisible();
  await runCommand('ai.openInconsistencies');
  const dialog = page.locator('.consistency-dialog');
  const expected = receivedAiRequests + 1;
  await dialog.getByRole('button', { name: 'Analyse' }).click();
  await expect.poll(() => receivedAiRequests).toBe(expected);
  const settledBefore = await aiSettledCount();

  await activatePath(pathB, /beta\.fountain/);
  await expect(dialog).toBeHidden();
  releaseNextAiResponse();
  await expect.poll(aiSettledCount).toBeGreaterThan(settledBefore);

  await runCommand('ai.openInconsistencies');
  await expect(dialog.locator('.consistency-item')).toHaveCount(0);
  await expect(dialog).not.toContainText('A_ONLY_FINDING');
  expect(await editorText()).toBe(B_CONTENT);
  await dialog.getByRole('button', { name: 'Close consistency analysis' }).click();
});

test('a rewrite calculated for A@N is rejected after A changes to N+1', async () => {
  await activate(/alpha\.fountain/);
  await startDelayedRewrite();
  const rewrite = page.locator('.rewrite-popover');

  const editor = page.locator('.cm-content');
  await editor.click({ force: true });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nLOCAL_AI_EDIT');

  releaseNextAiResponse();
  await expect(rewrite.locator('.rewrite-variant')).toHaveCount(3);
  await rewrite.getByText('VARIANT ONE').click();

  await expect(rewrite).toBeVisible();
  await expect(page.locator('.status-message')).toContainText('document changed');
  await expect(editor).toContainText('ORIGINAL_TOKEN');
  await expect(editor).toContainText('LOCAL_AI_EDIT');
  await expect(editor).not.toContainText('VARIANT ONE');
  await rewrite.getByRole('button', { name: 'Close rewriting' }).click();
});

test('closing the initiating document discards its late AI result without an exception', async () => {
  const pathC = join(userData, 'closing.fountain');
  await writeFile(pathC, A_CONTENT, 'utf8');
  await openTrustedScreenplays(app, [pathC]);
  await expect(page.locator('.tab-active .tab-name')).toHaveText('closing.fountain');
  await startDelayedRewrite();
  const settledBefore = await aiSettledCount();

  await runCommand('file.closeTab');
  await expect(page.locator('.tab-active .tab-name')).not.toHaveText('closing.fountain');
  releaseNextAiResponse();
  await expect.poll(aiSettledCount).toBeGreaterThan(settledBefore);

  await expect(page.locator('.cm-content')).not.toContainText('VARIANT ONE');
  expect(await editorText()).toBe(B_CONTENT);
  expect(pageErrors).toEqual([]);
});

test('an unchanged document still accepts the delayed rewrite normally', async () => {
  await activate(/alpha\.fountain/);
  await startDelayedRewrite();
  releaseNextAiResponse();
  const rewrite = page.locator('.rewrite-popover');
  await expect(rewrite.locator('.rewrite-variant')).toHaveCount(3);
  await rewrite.getByText('VARIANT ONE').click();

  await expect(rewrite).toBeHidden();
  await expect(page.locator('.cm-content')).toContainText('VARIANT ONE');
  await activate(/beta\.fountain/);
  await expect(page.locator('.cm-content')).toContainText('B_DOCUMENT_UNCHANGED');
  await expect(page.locator('.cm-content')).not.toContainText('VARIANT ONE');
});

test('a Bible draft started before Save As cannot write through the old path', async () => {
  await activate(/alpha\.fountain/);
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await dialog.getByLabel('Name of the new sheet').fill('ALICE');
  await dialog.getByRole('button', { name: 'New sheet' }).click();
  await expect(dialog.locator('.rail-row')).toHaveCount(1);

  const expected = receivedAiRequests + 1;
  await dialog.getByRole('button', { name: 'Draft the empty fields' }).click();
  await expect.poll(() => receivedAiRequests).toBe(expected);

  const savedAsPath = join(userData, 'alpha-copy.fountain');
  await app.evaluate(({ ipcMain }, nextPath) => {
    const reserve = (
      globalThis as typeof globalThis & {
        __fountainReserveSaveAsDestination?: (path: string) => void;
      }
    ).__fountainReserveSaveAsDestination;
    ipcMain.removeHandler('dialog:pickSaveAs');
    ipcMain.handle('dialog:pickSaveAs', () => {
      reserve?.(nextPath);
      return nextPath;
    });
  }, savedAsPath);
  await runCommand('file.saveAs');
  await expect(page.locator('.tab-active .tab-name')).toHaveText('alpha-copy.fountain');

  releaseNextAiResponse();
  await expect(dialog.locator('.ai-feedback')).toContainText('document changed');
  await expect(dialog).not.toContainText('STALE_PATH_DRAFT');
  expect(await readFile(`${pathA}.bible.json`, 'utf8')).not.toContain('STALE_PATH_DRAFT');
  expect(await readFile(`${savedAsPath}.bible.json`, 'utf8').catch(() => '')).not.toContain(
    'STALE_PATH_DRAFT',
  );
});
