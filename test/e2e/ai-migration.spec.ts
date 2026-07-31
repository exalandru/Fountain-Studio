import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * Multi-provider support added a `provider` field to every connection profile. A profile
 * written before that must keep working untouched: it is resolved to the OpenAI-compatible
 * protocol the application has always spoken, and it must still reach its endpoint.
 *
 * The settings file is dropped into the profile by hand, exactly as an earlier version of
 * the application would have written it.
 */
test('a connection profile saved before multi-provider support still works', async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Legacy profile answer' } }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const userData = await mkdtemp(join(tmpdir(), 'fountain-studio-ai-legacy-'));
  await writeFile(
    join(userData, 'ai-settings.json'),
    JSON.stringify({
      version: 1,
      activeProfileId: 'legacy',
      profiles: [
        {
          id: 'legacy',
          name: 'Legacy endpoint',
          baseUrl,
          model: 'legacy-model',
          timeoutMs: 30_000,
          maxTokens: 2_048,
          reasoningEnabled: false,
        },
      ],
      // A field this version no longer knows about, left in on purpose.
      brainstormingPrompt: 'Réglage retiré depuis.',
    }),
    'utf8',
  );

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

    const view = await page.evaluate(() => window.quantum.invoke('ai:config:get', undefined));
    expect(view.activeProfileId).toBe('legacy');
    expect(view.profiles[0]?.provider).toBe('openai');
    expect(view.profiles[0]?.model).toBe('legacy-model');
    // The retired brainstorming prompt is dropped rather than echoed back.
    expect(view).not.toHaveProperty('brainstormingPrompt');

    const answer = await page.evaluate(
      async () =>
        new Promise<{ content: string; error: string | null }>((resolve) => {
          const requestId = 'legacy-profile';
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
            profileId: 'legacy',
            mode: 'factual',
            systemPrompt: 'Plain text only.',
            messages: [{ role: 'user', content: 'Still reachable?' }],
          });
        }),
    );

    expect(answer).toEqual({ content: 'Legacy profile answer', error: null });
    expect(paths).toEqual(['/v1/chat/completions']);

    // Saving the migrated profile back must pass IPC validation with its new field.
    const saved = await page.evaluate(async () => {
      const config = await window.quantum.invoke('ai:config:get', undefined);
      const next = await window.quantum.invoke('ai:config:save', {
        config: {
          version: 1,
          activeProfileId: config.activeProfileId,
          profiles: config.profiles.map(({ hasApiKey: _hasApiKey, ...profile }) => profile),
        },
        keyUpdates: [],
      });
      return next.profiles[0]?.provider;
    });
    expect(saved).toBe('openai');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
