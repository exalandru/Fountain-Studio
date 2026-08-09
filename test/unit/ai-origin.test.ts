import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiEndpointOrigin,
  DEFAULT_AI_PROFILE,
  sameAiEndpointOrigin,
  type AiConfig,
  type AiConnectionProfile,
} from '../../src/shared/ai/index.js';

/**
 * M4 AI origin binding — URL origin identity, key clearing on origin change,
 * and probe refusal when a renderer redirects a stored key.
 */

const harness = vi.hoisted(() => {
  let userData = '';
  return {
    get userData() {
      return userData;
    },
    setUserData(path: string) {
      userData = path;
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => harness.userData,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'unknown',
  },
}));

import { authorizeAiNetworkProfile, AiOriginError, listAiModels } from '../../src/main/ai/proxy.js';
import {
  getAiApiKey,
  getAiConfigView,
  resetAiSettingsForTests,
  saveAiConfig,
} from '../../src/main/ai/settings.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  resetAiSettingsForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; seenAuth: string[] }> {
  const seenAuth: string[] = [];
  const server = createServer((request, response) => {
    seenAuth.push(String(request.headers.authorization ?? ''));
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { seenAuth, url: `http://127.0.0.1:${address.port}` };
}

function profile(overrides: Partial<AiConnectionProfile> = {}): AiConnectionProfile {
  return {
    ...DEFAULT_AI_PROFILE,
    id: 'p1',
    name: 'Test',
    ...overrides,
  };
}

function config(profiles: AiConnectionProfile[], activeProfileId = profiles[0]!.id): AiConfig {
  return { version: 1, activeProfileId, profiles };
}

describe('aiEndpointOrigin', () => {
  it('G — path-only changes share an origin', () => {
    expect(sameAiEndpointOrigin('https://host.example/v1', 'https://host.example/v2')).toBe(true);
    expect(aiEndpointOrigin('https://host.example/v1')).toBe('https://host.example:443');
  });

  it('I — suffix hosts are distinct', () => {
    expect(
      sameAiEndpointOrigin('https://trusted.example', 'https://trusted.example.evil.test'),
    ).toBe(false);
  });

  it('J — scheme changes are distinct', () => {
    expect(sameAiEndpointOrigin('https://api.example.com', 'http://api.example.com')).toBe(false);
  });

  it('K — ports follow URL origin rules', () => {
    expect(sameAiEndpointOrigin('https://api.example.com', 'https://api.example.com:443')).toBe(
      true,
    );
    expect(sameAiEndpointOrigin('https://api.example.com', 'https://api.example.com:8443')).toBe(
      false,
    );
    expect(sameAiEndpointOrigin('http://localhost:11434', 'http://localhost:11435')).toBe(false);
  });

  it('rejects credentials embedded in the URL', () => {
    expect(aiEndpointOrigin('https://user:pass@evil.test')).toBeNull();
  });

  it('normalises host case', () => {
    expect(sameAiEndpointOrigin('https://API.Example.COM/v1', 'https://api.example.com/v2')).toBe(
      true,
    );
  });
});

describe('AI key origin binding (M4)', () => {
  beforeEach(async () => {
    resetAiSettingsForTests();
    harness.setUserData(await mkdtemp(join(tmpdir(), 'm4-ai-')));
  });

  it('H — origin change without a fresh key clears the stored key', async () => {
    const trusted = profile({ baseUrl: 'https://trusted.example/v1' });
    await saveAiConfig(config([trusted]), [{ profileId: 'p1', key: 'secret-key' }]);
    expect(await getAiApiKey('p1')).toBe('secret-key');

    const moved = profile({ baseUrl: 'https://evil.example/v1' });
    const view = await saveAiConfig(config([moved]), []);
    expect(view.profiles[0]?.hasApiKey).toBe(false);
    expect(await getAiApiKey('p1')).toBe('');
  });

  it('G — same-origin path change keeps the key', async () => {
    const first = profile({ baseUrl: 'https://trusted.example/v1' });
    await saveAiConfig(config([first]), [{ profileId: 'p1', key: 'secret-key' }]);
    const second = profile({ baseUrl: 'https://trusted.example/v2' });
    const view = await saveAiConfig(config([second]), []);
    expect(view.profiles[0]?.hasApiKey).toBe(true);
    expect(await getAiApiKey('p1')).toBe('secret-key');
  });

  it('L — custom provider may change origin when no key exists', async () => {
    const local = profile({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });
    await saveAiConfig(config([local]), []);
    const elsewhere = profile({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3.1',
    });
    const view = await saveAiConfig(config([elsewhere]), []);
    expect(view.profiles[0]?.baseUrl).toContain('127.0.0.1');
    expect(view.profiles[0]?.hasApiKey).toBe(false);
  });

  it('M — a freshly supplied key may bind to the new origin', async () => {
    const trusted = profile({ baseUrl: 'https://trusted.example/v1' });
    await saveAiConfig(config([trusted]), [{ profileId: 'p1', key: 'old-secret' }]);
    const moved = profile({ baseUrl: 'https://evil.example/v1' });
    const view = await saveAiConfig(config([moved]), [{ profileId: 'p1', key: 'new-secret' }]);
    expect(view.profiles[0]?.hasApiKey).toBe(true);
    expect(await getAiApiKey('p1')).toBe('new-secret');
  });

  it('post-compromise probe cannot inject a stored key toward a foreign origin', async () => {
    const trusted = profile({ baseUrl: 'https://trusted.example/v1' });
    await saveAiConfig(config([trusted]), [{ profileId: 'p1', key: 'secret-key' }]);

    const evil = profile({ baseUrl: 'https://evil.example/v1' });
    await expect(authorizeAiNetworkProfile(evil)).rejects.toBeInstanceOf(AiOriginError);
    await expect(authorizeAiNetworkProfile(evil, undefined)).rejects.toBeInstanceOf(AiOriginError);
  });

  it('explicit key override may target a new origin (user typed the key)', async () => {
    const trusted = profile({ baseUrl: 'https://trusted.example/v1' });
    await saveAiConfig(config([trusted]), [{ profileId: 'p1', key: 'stored-secret' }]);

    const evil = profile({ baseUrl: 'https://evil.example/v1' });
    const authorized = await authorizeAiNetworkProfile(evil, 'typed-for-evil');
    expect(authorized.apiKey).toBe('typed-for-evil');
    expect(authorized.profile.baseUrl).toContain('evil.example');
    // Stored key must remain untouched until an origin-changing save.
    expect(await getAiApiKey('p1')).toBe('stored-secret');
  });

  it('listAiModels with null key refuses a foreign origin and accepts same-origin edits', async () => {
    const { seenAuth, url } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
    });

    const disk = profile({ baseUrl: url });
    await saveAiConfig(config([disk]), [{ profileId: 'p1', key: 'disk-secret' }]);

    const hijack = profile({ baseUrl: 'https://evil.example/v1' });
    await expect(listAiModels(hijack, undefined)).rejects.toThrow(/origin/i);
    expect(seenAuth).toEqual([]);

    const models = await listAiModels({ ...disk, baseUrl: `${url}/ignored-path` }, undefined);
    expect(models).toEqual(['model-a']);
    expect(seenAuth).toEqual(['Bearer disk-secret']);
  });

  it('refuses automatic HTTP redirects that would carry credentials', async () => {
    const { url: evilUrl } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'leaked' }] }));
    });
    const { url: trustedUrl } = await listen((_request, response) => {
      response.writeHead(302, { location: `${evilUrl}/v1/models` });
      response.end();
    });

    const disk = profile({ baseUrl: trustedUrl });
    await saveAiConfig(config([disk]), [{ profileId: 'p1', key: 'disk-secret' }]);
    await expect(listAiModels(disk, undefined)).rejects.toThrow();
  });

  it('persists cleared keys so a later load cannot resurrect them', async () => {
    const trusted = profile({ baseUrl: 'https://trusted.example/v1' });
    await saveAiConfig(config([trusted]), [{ profileId: 'p1', key: 'secret-key' }]);
    await saveAiConfig(config([profile({ baseUrl: 'https://evil.example/v1' })]), []);

    resetAiSettingsForTests();
    const view = await getAiConfigView();
    expect(view.profiles[0]?.hasApiKey).toBe(false);
    const secrets = JSON.parse(
      await readFile(join(harness.userData, 'ai-secrets.json'), 'utf8'),
    ) as { keys: Record<string, string> };
    expect(secrets.keys).toEqual({});
  });
});
