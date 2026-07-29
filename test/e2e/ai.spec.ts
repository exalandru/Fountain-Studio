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
    'Title: AI story\n\nINT. LAB - NIGHT\n\nSECRET_SCENE_M5 stays off the network by default.\n',
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
  await dialog.getByLabel('Model').fill('test-model');
  await dialog.getByLabel('API key').fill('SECRET_API_KEY_M5');

  await dialog.getByRole('button', { name: 'List models' }).click();
  await expect(dialog.locator('.ai-feedback')).toContainText('2 models found');
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

test('streams chat, remembers the reasoning fallback and only sends explicit attachments', async () => {
  requests = [];
  await runCommand('ai.openBrainstorm');
  const panel = page.locator('.brainstorm-pane');
  await expect(panel).toBeVisible();

  const composer = panel.getByPlaceholder('Ask about structure, a character, a scene…');
  await composer.fill('First question without context');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.ai-message-assistant').last()).toContainText(
    'No screenplay content was received.',
  );

  const firstChats = requests.filter(
    ({ path, body }) => path === '/v1/chat/completions' && body?.['stream'] === true,
  );
  expect(firstChats).toHaveLength(1);
  expect(firstChats[0]?.body?.['reasoning_effort']).toBeUndefined();
  expect(JSON.stringify(firstChats)).not.toContain('SECRET_SCENE_M5');

  await panel.getByRole('button', { name: '+ Full screenplay' }).click();
  await expect(panel.locator('.ai-attachment-chips')).toContainText('Full screenplay');
  await composer.fill('Second question with the attachment');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.ai-message-assistant').last()).toContainText(
    'The screenplay was explicitly received.',
  );

  const lastChat = requests
    .filter(({ path, body }) => path === '/v1/chat/completions' && body?.['stream'] === true)
    .at(-1);
  expect(JSON.stringify(lastChat?.body?.['messages'])).toContain('SECRET_SCENE_M5');
  expect(lastChat?.body?.['reasoning_effort']).toBeUndefined();

  const companion = `${screenplay}.appdata.json`;
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(companion, 'utf8')) as unknown;
      } catch {
        return null;
      }
    })
    .toMatchObject({
      brainstorm: {
        conversations: [
          {
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: 'user',
                attachments: [
                  expect.objectContaining({ kind: 'script', label: 'Full screenplay' }),
                ],
              }),
            ]),
          },
        ],
      },
    });
  expect(await readFile(companion, 'utf8')).not.toContain('SECRET_SCENE_M5');

  await panel.getByRole('button', { name: 'Add as note' }).last().click();
  await expect(page.locator('.cm-content')).toContainText(
    'The screenplay was explicitly received.',
  );

  await composer.fill('reasoning stream');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.ai-message-assistant').last()).toContainText(
    'The model is reasoning…',
  );
  await expect(panel.locator('.ai-message-assistant').last()).toContainText('Visible answer');

  await composer.fill('reasoning only');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.ai-message-assistant').last()).toContainText(
    'finished reasoning without a final answer',
  );

  await composer.fill('slow stream');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.ai-message-assistant').last()).toContainText('Partial answer');
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(panel.locator('.ai-message-assistant').last()).toContainText('Partial answer');
});
