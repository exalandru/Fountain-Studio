import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
  /** Each provider authenticates through a different header. */
  apiKeyHeader: string | undefined;
  googleKeyHeader: string | undefined;
  anthropicVersion: string | undefined;
}

let app: ElectronApplication;
let page: Page;
let userData: string;
let screenplay: string;
let baseUrl: string;
let requests: CapturedRequest[] = [];

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sse(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

/**
 * Anthropic Messages endpoint. It refuses `temperature` exactly as current Claude models
 * do, which exercises the degradation ladder and its memoisation.
 */
function anthropicResponse(response: ServerResponse, body: Record<string, unknown> | null): void {
  if (body?.['temperature'] !== undefined) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'temperature: Extra inputs are not permitted',
        },
      }),
    );
    return;
  }
  if (body?.['stream'] === false) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        type: 'message',
        model: 'claude-test-model',
        content: [{ type: 'text', text: 'OK' }],
      }),
    );
    return;
  }
  // Named events, thinking block first, and no `[DONE]` sentinel.
  sse(response);
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start' })}\n\n`);
  response.write(
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Claude ' },
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'native answer' },
    })}\n\n`,
  );
  response.end(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

/** Gemini native endpoint; the model and the verb both live in the path. */
function googleResponse(response: ServerResponse, path: string): void {
  if (path.endsWith(':generateContent')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        modelVersion: 'gemini-test-pro-001',
        candidates: [{ content: { parts: [{ text: 'OK' }] } }],
      }),
    );
    return;
  }
  sse(response);
  response.write(
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini ' }] } }] })}\n\n`,
  );
  response.end(
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'native answer' }] }, finishReason: 'STOP' }],
    })}\n\n`,
  );
}

/** Ollama native endpoint: newline-delimited JSON, one object per line. */
function ollamaResponse(response: ServerResponse, body: Record<string, unknown> | null): void {
  if (body?.['stream'] === false) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ model: 'ollama-test:8b', message: { role: 'assistant', content: 'OK' } }),
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const message of [
    { role: 'assistant', content: '', thinking: 'pondering' },
    { role: 'assistant', content: 'Ollama ' },
    { role: 'assistant', content: 'native answer' },
  ]) {
    response.write(`${JSON.stringify({ model: 'ollama-test:8b', message, done: false })}\n`);
  }
  response.end(
    `${JSON.stringify({
      model: 'ollama-test:8b',
      message: { role: 'assistant', content: '' },
      done: true,
    })}\n`,
  );
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const apiKeyHeader = header(request, 'x-api-key');
    requests.push({
      path: request.url ?? '',
      body,
      authorization: request.headers.authorization,
      apiKeyHeader,
      googleKeyHeader: header(request, 'x-goog-api-key'),
      anthropicVersion: header(request, 'anthropic-version'),
    });
    const path = (request.url ?? '').split('?')[0] ?? '';

    if (path === '/v1/models') {
      // Anthropic lists models at the same path with the same envelope; the auth header
      // is what tells the two providers apart.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: apiKeyHeader
            ? [{ id: 'claude-test-model' }]
            : [{ id: 'test-model' }, { id: 'other-model' }],
        }),
      );
      return;
    }
    if (path === '/v1/messages') {
      anthropicResponse(response, body);
      return;
    }
    if (path === '/v1beta/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          models: [
            { name: 'models/gemini-test-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-test-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embed-test', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      );
      return;
    }
    if (path.startsWith('/v1beta/models/')) {
      googleResponse(response, path);
      return;
    }
    if (path === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ models: [{ name: 'ollama-test:8b', model: 'ollama-test:8b' }] }),
      );
      return;
    }
    if (path === '/api/chat') {
      ollamaResponse(response, body);
      return;
    }
    if (path !== '/v1/chat/completions') {
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
    if (lastContent.includes('Suggest up to ten synonyms')) {
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
    if (lastContent.includes('alternative names for the character')) {
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
    if (lastContent.includes('Rewrite the selected passage')) {
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
    if (lastContent.includes('Draft the bible sheet for')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  fields: {
                    role: 'Ingénieure système du laboratoire.',
                    // The author already wrote this one; the draft must not touch it.
                    wants: 'CE QUE LE MODÈLE PROPOSE',
                    // Nothing in the screenplay establishes this, so the model says so.
                    fears: '',
                    invented: 'une clé que personne n’a demandée',
                  },
                }),
              },
            },
          ],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (lastContent.includes('Find the structural repetitions')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  items: [
                    {
                      type: 'repetition',
                      severity: 'minor',
                      description: 'Scenes 1 and 2 both introduce the same threat.',
                      references: [
                        { sceneNumber: '1', heading: 'INT. LAB - NIGHT', quote: 'first pass' },
                        { sceneNumber: '2', heading: 'INT. LAB - DAWN', quote: 'second pass' },
                      ],
                      suggestion: 'Cut the second, or let it land differently.',
                    },
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
    if (lastContent.includes('Analyse how consistent')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  items: [
                    {
                      type: 'voice',
                      severity: 'major',
                      description: 'ALICE suddenly speaks in a formal register.',
                      references: [
                        {
                          sceneNumber: '1',
                          heading: 'INT. LAB - NIGHT',
                          quote: 'SECRET_SCENE_M5',
                        },
                      ],
                      suggestion: 'Keep her clipped.',
                    },
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
    if (lastContent.includes('Analyse the whole screenplay for inconsistencies')) {
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

interface CollectedAnswer {
  content: string;
  error: string | null;
  reasoning: boolean;
}

/**
 * Drives one streaming request through the real IPC proxy and collects what came back.
 * Exercising the provider adapter and the stream decoder directly is far more precise
 * than asserting on rendered UI.
 */
async function collectAnswer(prompt: string, requestId: string): Promise<CollectedAnswer> {
  return page.evaluate(
    async ({ prompt: text, requestId: id }) => {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      return new Promise<CollectedAnswer>((resolve) => {
        let content = '';
        let reasoning = false;
        const cleanups: Array<() => void> = [];
        const finish = (error: string | null) => {
          cleanups.forEach((cleanup) => cleanup());
          resolve({ content, error, reasoning });
        };
        cleanups.push(
          window.quantum.on('ai:reasoning', (event) => {
            if (event.requestId === id) reasoning = true;
          }),
          window.quantum.on('ai:chunk', (event) => {
            if (event.requestId === id) content += event.chunk;
          }),
          window.quantum.on('ai:done', (event) => {
            if (event.requestId === id) finish(null);
          }),
          window.quantum.on('ai:error', (event) => {
            if (event.requestId === id) finish(event.message);
          }),
        );
        void window.quantum.invoke('ai:chat:start', {
          requestId: id,
          profileId: config.activeProfileId,
          mode: 'factual',
          systemPrompt: 'Plain text only.',
          messages: [{ role: 'user', content: text }],
        });
      });
    },
    { prompt, requestId },
  );
}

async function runCommand(command: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { command: name });
  }, command);
}

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = await mkdtemp(join(tmpdir(), 'fountain-studio-ai-'));
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
    JSON.stringify(body?.['messages']).includes('Suggest up to ten synonyms'),
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
    JSON.stringify(body?.['messages']).includes('Rewrite the selected passage'),
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
    JSON.stringify(body?.['messages']).includes('alternative names for the character'),
  );
  // The chosen style reached the model: 'rare' asks for real but uncommon names.
  expect(JSON.stringify(nameRequest?.body?.['messages'])).toContain('markedly less common');
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

test('analyses a character’s voice, and keeps the finding in the companion file', async () => {
  requests = [];
  await runCommand('ai.openVoiceConsistency');
  const panel = page.locator('.consistency-dialog');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Voice consistency' })).toBeVisible();

  // Nothing to show until a character is chosen — the analysis is per voice.
  await expect(panel.locator('.panel-placeholder')).toContainText('Choose a character');

  // Earlier tests in this file rename the character, so the name is read from the chooser
  // rather than assumed: what matters is that speaking characters are offered at all.
  const chooser = panel.locator('.voice-controls select');
  const speaker = await chooser.locator('option:not([value=""])').first().getAttribute('value');
  expect(speaker).toBeTruthy();
  await chooser.selectOption(speaker ?? '');

  await panel.getByRole('button', { name: 'Analyse this voice' }).click();
  const finding = panel.locator('.consistency-item');
  await expect(finding).toHaveCount(1);
  await expect(finding).toContainText('formal register');
  // The type label comes from the shared consistency namespace, and the guard in
  // parseInconsistencies must accept 'voice' or the finding never arrives at all.
  await expect(finding.locator('.consistency-item-heading strong')).toHaveText('Character voice');
  await expect(finding).toHaveClass(/severity-major/);

  const prompt = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Analyse how consistent'),
  );
  // The reader's language is stated explicitly, so a report never arrives in a language the
  // panel around it does not speak. The quotes are exempted in the same breath.
  const system = JSON.stringify(prompt?.body?.['messages']);
  expect(system).toContain('in English');
  expect(system).toContain('never translated');
  // The context is built for one character, each speech tagged with the scene it sits in.
  const sent = JSON.stringify(prompt?.body?.['messages']);
  expect(sent).toContain(speaker);
  // The scene number travels with the heading, so the model can quote a reference that
  // actually resolves instead of inventing a number.
  expect(sent).toContain('[1 · INT. LAB - NIGHT]');

  // Findings are keyed by character in the companion file, so each voice keeps its own.
  await expect
    .poll(async () => {
      const raw = await readFile(`${screenplay}.appdata.json`, 'utf8');
      const data = JSON.parse(raw) as {
        voiceConsistency?: Record<string, { items?: unknown[] }>;
      };
      return data.voiceConsistency?.[speaker ?? '']?.items?.length ?? 0;
    })
    .toBe(1);

  await panel.getByRole('button', { name: 'Close voice analysis' }).click();
  await expect(panel).toBeHidden();
});

test('asks for reports in the interface language, and never for rewrites', async () => {
  // The wiring, not the wording: a hardcoded locale would pass every unit test and still send
  // English instructions to a French reader.
  await page.evaluate(() => window.quantum.invoke('settings:patch', { language: 'fr' }));
  requests = [];

  await runCommand('ai.openVoiceConsistency');
  const panel = page.locator('.consistency-dialog');
  await expect(panel).toBeVisible();
  const chooser = panel.locator('.voice-controls select');
  const speaker = await chooser.locator('option:not([value=""])').first().getAttribute('value');
  await chooser.selectOption(speaker ?? '');
  // Located by class, not by label: the interface is in French for the length of this test.
  await panel.locator('.ai-primary').click();
  await expect(panel.locator('.consistency-item')).toHaveCount(1);

  const report = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Analyse how consistent'),
  );
  const reportSystem = JSON.stringify(report?.body?.['messages']);
  // The instructions stay English — one prose to maintain — while the answer is asked for in
  // the reader's language.
  expect(reportSystem).toContain('You analyse how consistent');
  expect(reportSystem).toContain('in French');
  expect(reportSystem).not.toContain('in English');
  await panel.locator('.panel-close').click();
  await expect(panel).toBeHidden();

  // And the case that separates this design from a naive translation: with the interface in
  // French, a rewrite must still defer to the language of the excerpt rather than be pinned to
  // either language — an English screenplay gets English variants under a French interface.
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.getByText('SECRET_SCENE_M5').first().dblclick();
  await runCommand('ai.rewrite');
  const rewrite = page.locator('.rewrite-popover');
  await expect(rewrite).toBeVisible();
  await expect
    .poll(() =>
      requests.some(({ body }) =>
        JSON.stringify(body?.['messages']).includes('Rewrite the selected passage'),
      ),
    )
    .toBe(true);
  const rewriteRequest = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Rewrite the selected passage'),
  );
  const rewriteSystem = JSON.stringify(rewriteRequest?.body?.['messages']);
  expect(rewriteSystem).toContain('language of the excerpt');
  expect(rewriteSystem).not.toContain('in French');
  expect(rewriteSystem).not.toContain('in English');

  // Close by class, not by label: this test leaves the interface in French until the
  // last lines, so an English aria-label would miss. Escape alone used to miss too —
  // the popover does not keep focus — but the button always works.
  await rewrite.locator('.panel-close').click();
  await expect(rewrite).toBeHidden();
  await page.evaluate(() => window.quantum.invoke('settings:patch', { language: 'en' }));
  await expect(page.locator('.statusbar')).toContainText('scene');
});

test('measures literal repetition without a request, then asks about structure', async () => {
  requests = [];
  // A screenplay with one deliberate tic: the same line, twice, in two mouths.
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(
    'INT. LAB - NIGHT\n\nALICE\nWe never talk about the second door.\n\n' +
      'EXT. STREET - DAY\n\nBORIS\nWe never talk about the second door.\n',
  );
  await expect(editor).toContainText('BORIS');

  await runCommand('ai.openRepetitions');
  const panel = page.locator('.consistency-dialog');
  await expect(panel).toBeVisible();

  // The literal half is computed from the AST, so it is there before any request is made.
  const finding = panel.locator('.repetition-item');
  await expect(finding).toHaveCount(1);
  await expect(finding.locator('strong')).toHaveText('we never talk about the second door');
  // Two mouths, so it reads as the writer's formula rather than a character's signature.
  await expect(finding.locator('.repetition-badge')).toHaveClass(/is-spread/);
  expect(requests).toHaveLength(0);

  // Each occurrence takes the editor to the block it sits in.
  await finding.getByRole('button', { name: /places it appears/ }).click();
  await expect(panel.locator('.repetition-occurrences li')).toHaveCount(2);

  // The structural half is a judgement, so it is asked for explicitly.
  await expect(panel.locator('.repetition-structural-empty')).toContainText('has not been run');
  await panel.getByRole('button', { name: 'Look for structural repetition' }).click();
  const structural = panel.locator('.repetition-structural .consistency-item');
  await expect(structural).toHaveCount(1);
  await expect(structural).toContainText('same threat');
  // 'repetition' has to be in both runtime guards, or the finding never arrives.
  await expect(structural.locator('.consistency-item-heading strong')).toHaveText(
    'Narrative repetition',
  );

  const prompt = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Find the structural repetitions'),
  );
  // The model reads a one-line digest per scene, not the screenplay.
  const sent = JSON.stringify(prompt?.body?.['messages']);
  expect(sent).toContain('INT. LAB - NIGHT');
  expect(sent).not.toContain('second door');

  await expect
    .poll(async () => {
      const raw = await readFile(`${screenplay}.appdata.json`, 'utf8');
      const data = JSON.parse(raw) as { repetitions?: { items?: Array<{ type?: string }> } };
      return data.repetitions?.items?.[0]?.type;
    })
    .toBe('repetition');

  await panel.getByRole('button', { name: 'Close repetition analysis' }).click();
  await expect(panel).toBeHidden();
});

test('drafts a bible sheet into the empty fields only', async () => {
  requests = [];
  await runCommand('file.bible');
  const dialog = page.locator('.bible-dialog');
  await expect(dialog).toBeVisible();

  // Earlier tests in this file rename the character, so the sheet is named after what the
  // screenplay says by now.
  await dialog.getByLabel('Kind of sheet').selectOption('character');
  // The repetition test rewrote the document; ALICE is who it holds now.
  await dialog.getByLabel('Name of the new sheet').fill('ALICE');
  await dialog.getByRole('button', { name: 'New sheet' }).click();
  await expect(dialog.locator('.rail-row')).toHaveCount(1);

  // The author writes one field themselves before asking for a draft.
  const wants = dialog.getByLabel('What they want');
  await wants.fill('CE QUE L’AUTEUR A ÉCRIT');
  await dialog.getByLabel('Role in the story').click();

  await dialog.getByRole('button', { name: 'Draft the empty fields' }).click();
  await expect(dialog.getByLabel('Role in the story')).toHaveValue(/Ingénieure système/);
  // The author always wins: their own sentence is untouched.
  await expect(wants).toHaveValue('CE QUE L’AUTEUR A ÉCRIT');
  // A field the model returned empty stays empty rather than storing a blank.
  await expect(dialog.getByLabel('What they fear')).toHaveValue('');
  await expect(dialog.locator('.bible-drafted-note')).toBeVisible();

  const prompt = requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('Draft the bible sheet for'),
  );
  // Extraction, not reasoning: thinking first is what made this time out on a local model.
  expect(prompt?.body?.['reasoning_effort']).toBe('none');
  // The sheet is drafted from the character's own scenes, tagged with their numbers.
  expect(JSON.stringify(prompt?.body?.['messages'])).toContain('[1 · INT. LAB - NIGHT]');

  // An invented key never reaches the author's file.
  await expect
    .poll(async () => {
      const raw = await readFile(`${screenplay}.bible.json`, 'utf8');
      return raw.includes('invented');
    })
    .toBe(false);

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
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

/**
 * These run last: each iteration repoints the active profile at another provider, and the
 * base URL deliberately stays on the local server (switching provider only re-targets a
 * URL still holding the previous provider's default).
 */
test('speaks the Anthropic protocol, degrading temperature and remembering it', async () => {
  requests = [];
  await runCommand('ai.openSettings');
  const dialog = page.locator('.ai-settings-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Provider').selectOption('anthropic');
  await expect(dialog.getByLabel('Base URL')).toHaveValue(baseUrl);

  await dialog.getByRole('button', { name: 'List models' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('1 models found');
  await dialog.getByRole('radio', { name: 'claude-test-model' }).check();
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('Connection successful');

  // The probe is rejected over `temperature`, then retried without it.
  const probes = requests.filter(
    ({ path, body }) => path === '/v1/messages' && body?.['stream'] === false,
  );
  expect(probes).toHaveLength(2);
  expect(probes[0]?.body?.['temperature']).toBe(0);
  expect(probes[1]?.body?.['temperature']).toBeUndefined();
  expect(probes[0]?.apiKeyHeader).toBe('SECRET_API_KEY_M5');
  expect(probes[0]?.anthropicVersion).toBe('2023-06-01');
  expect(probes[0]?.authorization).toBeUndefined();

  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  requests = [];
  const answer = await collectAnswer('Anthropic native check', 'anthropic-native');
  expect(answer).toEqual({ content: 'Claude native answer', error: null, reasoning: true });

  const chats = requests.filter(
    ({ path, body }) => path === '/v1/messages' && body?.['stream'] === true,
  );
  // A single attempt: the rejection observed during the probe is memoised per model.
  expect(chats).toHaveLength(1);
  expect(chats[0]?.body?.['temperature']).toBeUndefined();
  expect(chats[0]?.body?.['system']).toBe('Plain text only.');
  expect(chats[0]?.body?.['max_tokens']).toBeDefined();
  expect(chats[0]?.body?.['thinking']).toEqual({ type: 'adaptive' });
});

test('speaks the native Gemini protocol', async () => {
  requests = [];
  await runCommand('ai.openSettings');
  const dialog = page.locator('.ai-settings-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Provider').selectOption('google');
  await expect(dialog.getByLabel('Base URL')).toHaveValue(baseUrl);

  await dialog.getByRole('button', { name: 'List models' }).click();
  // The embedding-only model is filtered out.
  await expect(dialog.locator('.ai-feedback')).toContainText('2 models found');
  await dialog.getByRole('radio', { name: 'gemini-test-pro' }).check();
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('gemini-test-pro-001');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  requests = [];
  const answer = await collectAnswer('Gemini native check', 'google-native');
  // Gemini is not asked for its thoughts, so the reasoning indicator stays silent.
  expect(answer).toEqual({ content: 'Gemini native answer', error: null, reasoning: false });

  const chat = requests.find(({ path }) => path.includes(':streamGenerateContent'));
  expect(chat?.path).toBe('/v1beta/models/gemini-test-pro:streamGenerateContent?alt=sse');
  expect(chat?.googleKeyHeader).toBe('SECRET_API_KEY_M5');
  expect(chat?.authorization).toBeUndefined();
  expect(chat?.body?.['systemInstruction']).toEqual({ parts: [{ text: 'Plain text only.' }] });
  expect(chat?.body?.['contents']).toEqual([
    { role: 'user', parts: [{ text: 'Gemini native check' }] },
  ]);
  expect(chat?.body?.['generationConfig']).toMatchObject({
    temperature: 0.2,
    thinkingConfig: { thinkingBudget: -1 },
  });
});

test('speaks the native Ollama protocol over newline-delimited JSON', async () => {
  requests = [];
  await runCommand('ai.openSettings');
  const dialog = page.locator('.ai-settings-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Provider').selectOption('ollama');
  await expect(dialog.getByLabel('API key (optional)')).toBeVisible();

  await dialog.getByRole('button', { name: 'List models' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('1 models found');
  // Installed models come from the native tags endpoint, not from /v1/models.
  expect(requests.some(({ path }) => path === '/api/tags')).toBe(true);
  await dialog.getByRole('radio', { name: 'ollama-test:8b' }).check();
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('ollama-test:8b');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  requests = [];
  const answer = await collectAnswer('Ollama native check', 'ollama-native');
  expect(answer).toEqual({ content: 'Ollama native answer', error: null, reasoning: true });

  const chat = requests.find(({ path, body }) => path === '/api/chat' && body?.['stream'] === true);
  expect(chat?.body?.['think']).toBe(true);
  expect(chat?.body?.['options']).toMatchObject({ temperature: 0.2 });
  expect(chat?.body?.['messages']).toEqual([
    { role: 'system', content: 'Plain text only.' },
    { role: 'user', content: 'Ollama native check' },
  ]);
});
