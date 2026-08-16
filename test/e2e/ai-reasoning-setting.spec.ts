import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The reasoning setting is only worth having if it reaches the wire.
 *
 * Switching it off must make the request say so — a local model that reasons by default
 * would otherwise keep reasoning through the whole deadline while the dialog claims the
 * feature is disabled. That path has no task override to lean on, so it is exercised here
 * on its own: `ai.spec.ts` runs with reasoning on, and every `reasoning_effort: 'none'` it
 * observes comes from a per-task override instead.
 *
 * Both directions are asserted, because absence of a field is what a broken implementation
 * produces too: off must send the disable hints, and a chosen depth must arrive verbatim.
 */

interface Seen {
  path: string;
  body: Record<string, unknown> | null;
}

let requests: Seen[] = [];

const server = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  request.on('end', () => {
    requests.push({
      path: request.url ?? '',
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Answer' } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});

async function launch(
  reasoningEnabled: boolean,
  reasoningEffort: string,
  baseUrl: string,
): Promise<ElectronApplication> {
  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-reasoning-'));
  await writeFile(
    join(userData, 'ai-settings.json'),
    JSON.stringify({
      version: 1,
      activeProfileId: 'p',
      profiles: [
        {
          id: 'p',
          name: 'Local',
          provider: 'openai',
          baseUrl,
          model: 'local-model',
          timeoutMs: 60_000,
          maxTokens: 2_048,
          reasoningEnabled,
          reasoningEffort,
        },
      ],
    }),
    'utf8',
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  return electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], env });
}

/** A task that carries no `reasoning` override, so the profile alone decides. */
async function askWithoutOverride(app: ElectronApplication): Promise<void> {
  const page = await app.firstWindow();
  await page.waitForSelector('.cm-content');
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        const requestId = 'reasoning-setting';
        const cleanups: Array<() => void> = [];
        const finish = (): void => {
          cleanups.forEach((cleanup) => cleanup());
          resolve();
        };
        cleanups.push(
          window.quantum.on('ai:done', (event) => {
            if (event.requestId === requestId) finish();
          }),
          window.quantum.on('ai:error', (event) => {
            if (event.requestId === requestId) finish();
          }),
        );
        void window.quantum.invoke('ai:chat:start', {
          requestId,
          profileId: 'p',
          mode: 'factual',
          systemPrompt: 'Plain text only.',
          messages: [{ role: 'user', content: 'REASONING_SETTING_PROBE' }],
        });
      }),
  );
}

function probeBody(): Record<string, unknown> | undefined {
  return requests.find(({ body }) =>
    JSON.stringify(body?.['messages']).includes('REASONING_SETTING_PROBE'),
  )?.body as Record<string, unknown> | undefined;
}

let baseUrl = '';

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('a profile with reasoning switched off says so on the wire', async () => {
  requests = [];
  const app = await launch(false, 'auto', baseUrl);
  try {
    await askWithoutOverride(app);
  } finally {
    await app.close();
  }

  const body = probeBody();
  expect(body).toBeDefined();
  expect(body?.['reasoning_effort']).toBe('none');
  expect(body?.['chat_template_kwargs']).toEqual({ enable_thinking: false });
  // Inert text for servers that ignore the structured hints above.
  expect(JSON.stringify(body?.['messages'])).toContain('/no_think');
});

test('a profile with reasoning on sends the chosen depth and no disable hint', async () => {
  requests = [];
  const app = await launch(true, 'low', baseUrl);
  try {
    await askWithoutOverride(app);
  } finally {
    await app.close();
  }

  const body = probeBody();
  expect(body).toBeDefined();
  expect(body?.['reasoning_effort']).toBe('low');
  expect(body?.['chat_template_kwargs']).toBeUndefined();
  expect(JSON.stringify(body?.['messages'])).not.toContain('/no_think');
});
