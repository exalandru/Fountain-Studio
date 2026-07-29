import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

interface CapturedRequest {
  path: string;
  body: Record<string, unknown> | null;
  authorization: string | undefined;
}

let app: ElectronApplication;
let page: Page;
let userData: string;
let screenplay: string;
let baseUrl: string;
let requests: CapturedRequest[] = [];
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    requests.push({
      path: request.url ?? '',
      body,
      authorization: request.headers.authorization,
    });

    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    if (body?.['reasoning_effort'] === 'high') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'reasoning_effort unsupported' } }));
      return;
    }
    if (body?.['stream'] === false) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { content: 'OK' } }],
        }),
      );
      return;
    }

    const messages = body?.['messages'];
    const serialized = JSON.stringify(messages);
    const lastMessage = Array.isArray(messages) ? messages.at(-1) : null;
    const lastContent =
      typeof lastMessage === 'object' &&
      lastMessage !== null &&
      typeof (lastMessage as { content?: unknown }).content === 'string'
        ? (lastMessage as { content: string }).content
        : '';
    if (lastContent.includes('MISTRAL_422_COMPATIBILITY')) {
      if (body?.['chat_template_kwargs']) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'error',
            message: {
              detail: [
                {
                  type: 'extra_forbidden',
                  loc: ['body', 'chat_template_kwargs'],
                  msg: 'Extra inputs are not permitted',
                },
              ],
            },
            type: 'invalid_request_error',
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'Mistral compatible response' } }],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (lastContent.includes('Propose jusqu’à dix synonymes')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  suggestions: [
                    'SECRET',
                    'MYSTERY',
                    'HIDDEN',
                    'PRIVATE',
                    'COVERT',
                    'UNKNOWN',
                    'CLASSIFIED',
                    'VEILED',
                    'CONCEALED',
                    'ARCANE',
                  ],
                }),
              },
            },
          ],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (lastContent.includes('noms alternatifs pour le personnage')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  suggestions: ['EVELYN STONE', 'MAYA VALE', 'NORA BLAKE'],
                }),
              },
            },
          ],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (lastContent.includes('Reformule le passage sélectionné')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  variants: ['VARIANT ONE', 'VARIANT TWO', 'VARIANT THREE'],
                }),
              },
            },
          ],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (lastContent.includes('Analyse les incohérences')) {
      setTimeout(() => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content: JSON.stringify({
                    items: [
                      {
                        type: 'continuity',
                        severity: 'minor',
                        description: 'The object changes hands.',
                        references: [
                          {
                            sceneNumber: '1',
                            heading: 'INT. LAB - NIGHT',
                            quote: 'SECRET_SCENE_M5',
                          },
                        ],
                        suggestion: 'Keep it in the same hand.',
                      },
                    ],
                  }),
                },
              },
            ],
          })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      }, 350);
      return;
    }
    if (lastContent.includes('reasoning stream')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Analyzing' } }] })}\n\n`,
      );
      setTimeout(() => {
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Visible answer' } }] })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      }, 250);
      return;
    }
    if (lastContent.includes('reasoning only')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Budget exhausted' } }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (lastContent.includes('slow stream')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer' } }] })}\n\n`,
      );
      const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 5_000);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    const answer = serialized.includes('SECRET_SCENE_M5')
      ? '## Attached\n- The screenplay was explicitly received.'
      : '## Private\n- No screenplay content was received.';
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(0, 18) } }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(18) } }] })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
});

async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = await mkdtemp(join(tmpdir(), 'quantum-draft-ai-'));
  screenplay = join(userData, 'ai-story.fountain');
  await writeFile(
    screenplay,
    'Title: AI story\n\nINT. LAB - NIGHT\n\nALICE\nSECRET_SCENE_M5 stays off the network by default.\n',
    'utf8',
  );

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
  await page.waitForSelector('.cm-content');
  await app.evaluate(({ BrowserWindow }, path) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:openFiles', { paths: [path] });
  }, screenplay);
  await expect(page.locator('.cm-content')).toContainText('SECRET_SCENE_M5');
});

test.afterAll(async () => {
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

test('configures, tests and falls back on an OpenAI-compatible endpoint securely', async () => {
  await runCommand('ai.openSettings');
  const dialog = page.locator('.ai-settings-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Base URL').fill(baseUrl);
  await dialog.getByLabel('API key').fill('SECRET_API_KEY_M5');

  await dialog.getByRole('button', { name: 'List models' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('2 models found');
  await dialog.getByRole('radio', { name: 'test-model' }).check();
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('Connection successful');
  const connectionTests = requests.filter(
    ({ path, body }) => path === '/v1/chat/completions' && body?.['stream'] === false,
  );
  expect(connectionTests).toHaveLength(2);
  expect(connectionTests[0]?.body?.['reasoning_effort']).toBe('high');
  expect(connectionTests[1]?.body?.['reasoning_effort']).toBeUndefined();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const settingsFile = await readFile(join(userData, 'ai-settings.json'), 'utf8');
  expect(settingsFile).toContain(baseUrl);
  expect(settingsFile).not.toContain('SECRET_API_KEY_M5');
  const secretsFile = await readFile(join(userData, 'ai-secrets.json'), 'utf8').catch(() => '');
  expect(secretsFile).not.toContain('SECRET_API_KEY_M5');
  expect(requests.some(({ authorization }) => authorization === 'Bearer SECRET_API_KEY_M5')).toBe(
    true,
  );
});

test('removes the generic brainstorming mode from the application menu', async () => {
  const labels = await app.evaluate(({ Menu }) => {
    const ai = Menu.getApplicationMenu()?.items.find((item) => item.label === 'AI');
    return ai?.submenu?.items.map((item) => item.label) ?? [];
  });
  expect(labels).not.toContain('Brainstorm…');
});

test('offers fast synonyms, renames a character and persists an inconsistency report', async () => {
  requests = [];
  const editor = page.locator('.cm-content');
  await page
    .locator('.cm-line')
    .filter({ hasText: 'SECRET_SCENE_M5' })
    .dblclick({ position: { x: 170, y: 8 } });
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim()).not.toContain(
    ' ',
  );
  await page
    .locator('.cm-line')
    .filter({ hasText: 'SECRET_SCENE_M5' })
    .click({ button: 'right', position: { x: 170, y: 8 } });
  const contextMenu = page.locator('.editor-context-menu');
  await expect(contextMenu).toBeVisible();
  await expect(contextMenu.getByRole('menuitem', { name: 'Find Synonyms…' })).toBeEnabled();
  await expect(contextMenu.getByRole('menuitem', { name: 'Rewrite Selection…' })).toBeDisabled();
  await contextMenu.getByRole('menuitem', { name: 'Find Synonyms…' }).click();

  const rewrite = page.locator('.rewrite-popover');
  await expect(rewrite).toBeVisible();
  await expect(rewrite.getByRole('button', { name: 'Rewrite', exact: true })).toHaveCount(0);
  await expect(rewrite.locator('.rewrite-variant')).toHaveCount(10);
  const synonymRequest = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Propose jusqu’à dix synonymes'),
  );
  expect(synonymRequest?.body?.['reasoning_effort']).toBe('none');
  expect(synonymRequest?.body?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
  await rewrite.getByText('MYSTERY').click();
  await expect(editor).toContainText('MYSTERY');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText('SECRET_SCENE_M5');

  await page.locator('.cm-line').filter({ hasText: 'SECRET_SCENE_M5' }).click({ clickCount: 3 });
  await runCommand('ai.rewrite');
  await expect(rewrite.getByRole('button', { name: 'Synonyms', exact: true })).toHaveCount(0);
  await expect(rewrite.locator('.rewrite-variant')).toHaveCount(3);
  const rewriteRequest = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Reformule le passage sélectionné'),
  );
  expect(rewriteRequest?.body?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
  expect(rewriteRequest?.body?.['reasoning_effort']).toBe('none');
  await rewrite.getByRole('button', { name: 'Close rewriting' }).click();

  await page.locator('.cm-line').filter({ hasText: 'ALICE' }).click();
  await runCommand('ai.renameCharacter');
  const rename = page.locator('.character-name-popover');
  await expect(rename).toBeVisible();
  await rename.getByLabel('New name').fill('Eve');
  await rename.getByRole('button', { name: 'Rename everywhere' }).click();
  await expect(editor).toContainText('EVE');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toContainText('ALICE');

  await page.locator('.cm-line').filter({ hasText: 'ALICE' }).click();
  await runCommand('ai.renameCharacter');
  await rename.getByRole('radio', { name: /Rare/ }).check();
  await rename.getByRole('button', { name: 'Suggest alternative names' }).click();
  await expect(rename.getByText('EVELYN STONE')).toBeVisible();
  const nameRequest = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('noms alternatifs pour le personnage'),
  );
  expect(JSON.stringify(nameRequest?.body?.['messages'])).toContain('moins courants');
  expect(nameRequest?.body?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
  expect(nameRequest?.body?.['reasoning_effort']).toBe('none');
  await rename.getByText('EVELYN STONE').click();
  await expect(editor).toContainText('EVELYN STONE');

  await runCommand('ai.openInconsistencies');
  const dialog = page.locator('.consistency-dialog');
  const panel = dialog.locator('.consistency-pane');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('tab', { name: 'AI', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Analyse' }).click();
  await expect(panel.locator('.consistency-running')).toBeVisible();
  await expect(panel.locator('.consistency-running')).toContainText('Elapsed time');
  await expect(panel.locator('.consistency-item')).toContainText('The object changes hands.');
  await panel.locator('.consistency-item select').selectOption('resolved');
  await expect(panel.locator('.consistency-item select')).toHaveValue('resolved');

  await panel.locator('.consistency-reference').click();
  await expect(page.locator('.cm-activeLine')).toContainText('INT. LAB - NIGHT');

  await expect
    .poll(async () => {
      const companion = `${screenplay}.appdata.json`;
      try {
        const data = JSON.parse(await readFile(companion, 'utf8')) as {
          inconsistencies?: { items?: Array<{ status?: string }> };
        };
        return data.inconsistencies?.items?.[0]?.status;
      } catch {
        return null;
      }
    })
    .toBe('resolved');
});

test('retries a Mistral-style 422 response without non-standard parameters', async () => {
  requests = [];
  const result = await page.evaluate(async () => {
    const config = await window.quantum.invoke('ai:config:get', undefined);
    return new Promise<{ content: string; error: string | null }>((resolve) => {
      const requestId = 'mistral-422';
      let content = '';
      const cleanups: Array<() => void> = [];
      const finish = (error: string | null) => {
        cleanups.forEach((cleanup) => cleanup());
        resolve({ content, error });
      };
      cleanups.push(
        window.quantum.on('ai:chunk', (event) => {
          if (event.requestId === requestId) content += event.chunk;
        }),
        window.quantum.on('ai:done', (event) => {
          if (event.requestId === requestId) finish(null);
        }),
        window.quantum.on('ai:error', (event) => {
          if (event.requestId === requestId) finish(event.message);
        }),
      );
      void window.quantum.invoke('ai:chat:start', {
        requestId,
        profileId: config.activeProfileId,
        mode: 'creative',
        reasoning: 'disabled',
        systemPrompt: 'Plain text only.',
        messages: [{ role: 'user', content: 'MISTRAL_422_COMPATIBILITY' }],
      });
    });
  });

  expect(result).toEqual({ content: 'Mistral compatible response', error: null });
  const attempts = requests.filter(({ body }) =>
    JSON.stringify(body?.['messages']).includes('MISTRAL_422_COMPATIBILITY'),
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.body?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
  expect(attempts[0]?.body?.['reasoning_effort']).toBe('none');
  expect(attempts[1]?.body?.['chat_template_kwargs']).toBeUndefined();
  expect(attempts[1]?.body?.['reasoning_effort']).toBeUndefined();
  expect(JSON.stringify(attempts[1]?.body?.['messages'])).toContain('/no_think');
});
