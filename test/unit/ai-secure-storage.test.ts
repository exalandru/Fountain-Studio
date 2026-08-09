import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_PROFILE,
  type AiConfig,
  type AiConnectionProfile,
} from '../../src/shared/ai/index.js';
import {
  assessSecretStorageCapability,
  type LinuxSafeStorageBackend,
} from '../../src/main/ai/secure-storage.js';

/**
 * M6 — API keys must not be persisted when Linux safeStorage selects `basic_text`
 * (or when encryption is unavailable / backend undetermined).
 */

const harness = vi.hoisted(() => {
  let userData = '';
  const state = {
    platform: 'linux' as NodeJS.Platform,
    encryptionAvailable: true,
    backend: 'basic_text' as LinuxSafeStorageBackend,
    encryptPlaintexts: [] as string[],
  };
  return {
    state,
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
    isEncryptionAvailable: () => harness.state.encryptionAvailable,
    getSelectedStorageBackend: () => harness.state.backend,
    encryptString: (plainText: string) => {
      harness.state.encryptPlaintexts.push(plainText);
      return Buffer.from(`enc:${plainText}`, 'utf8');
    },
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return text.slice('enc:'.length);
    },
  },
}));

import {
  getAiApiKey,
  getAiConfigView,
  resetAiSettingsForTests,
  saveAiConfig,
} from '../../src/main/ai/settings.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  });
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

async function readSecretsFile(): Promise<{ keys: Record<string, string> }> {
  return JSON.parse(await readFile(join(harness.userData, 'ai-secrets.json'), 'utf8')) as {
    keys: Record<string, string>;
  };
}

async function readSettingsFile(): Promise<AiConfig> {
  return JSON.parse(await readFile(join(harness.userData, 'ai-settings.json'), 'utf8')) as AiConfig;
}

describe('assessSecretStorageCapability (M6 policy)', () => {
  it('rejects Linux basic_text even when encryption APIs are available', () => {
    expect(
      assessSecretStorageCapability({
        platform: 'linux',
        encryptionAvailable: true,
        linuxBackend: 'basic_text',
      }),
    ).toEqual({ canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: true });
  });

  it('accepts Linux secret stores supported by Electron 43', () => {
    for (const linuxBackend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const) {
      expect(
        assessSecretStorageCapability({
          platform: 'linux',
          encryptionAvailable: true,
          linuxBackend,
        }),
      ).toEqual({ canPersistApiSecretsSecurely: true, mustEvictPersistedSecrets: false });
    }
  });

  it('fails closed for unknown without scrubbing during an undetermined window', () => {
    expect(
      assessSecretStorageCapability({
        platform: 'linux',
        encryptionAvailable: true,
        linuxBackend: 'unknown',
      }),
    ).toEqual({ canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: false });
  });

  it('keeps macOS/Windows persistence when encryption is available', () => {
    expect(
      assessSecretStorageCapability({ platform: 'darwin', encryptionAvailable: true }),
    ).toEqual({ canPersistApiSecretsSecurely: true, mustEvictPersistedSecrets: false });
    expect(assessSecretStorageCapability({ platform: 'win32', encryptionAvailable: true })).toEqual(
      { canPersistApiSecretsSecurely: true, mustEvictPersistedSecrets: false },
    );
  });

  it('is session-only when encryption is unavailable on any platform', () => {
    expect(
      assessSecretStorageCapability({
        platform: 'linux',
        encryptionAvailable: false,
        linuxBackend: 'gnome_libsecret',
      }),
    ).toEqual({ canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: false });
    expect(
      assessSecretStorageCapability({ platform: 'darwin', encryptionAvailable: false }),
    ).toEqual({ canPersistApiSecretsSecurely: false, mustEvictPersistedSecrets: false });
  });
});

describe('AI secret persistence (M6)', () => {
  beforeEach(async () => {
    resetAiSettingsForTests();
    harness.state.platform = 'linux';
    harness.state.encryptionAvailable = true;
    harness.state.backend = 'basic_text';
    harness.state.encryptPlaintexts = [];
    setPlatform('linux');
    harness.setUserData(await mkdtemp(join(tmpdir(), 'fountain-m6-')));
  });

  afterEach(() => {
    resetAiSettingsForTests();
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('A — Linux basic_text keeps the key in session and writes no secret bytes', async () => {
    const secret = 'super-secret-basic-text-key';
    const view = await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    expect(view.secureStorageAvailable).toBe(false);
    expect(view.profiles[0]?.hasApiKey).toBe(true);
    expect(await getAiApiKey('p1')).toBe(secret);
    expect(harness.state.encryptPlaintexts).toEqual([]);

    const secrets = await readSecretsFile();
    expect(secrets.keys).toEqual({});
    const rawSecrets = await readFile(join(harness.userData, 'ai-secrets.json'), 'utf8');
    expect(rawSecrets).not.toContain(secret);
    expect(rawSecrets).not.toContain(Buffer.from(`enc:${secret}`, 'utf8').toString('base64'));

    const settings = await readSettingsFile();
    expect(settings.profiles[0]?.id).toBe('p1');
  });

  it('B — Linux gnome_libsecret persists ciphertext', async () => {
    harness.state.backend = 'gnome_libsecret';
    const secret = 'libsecret-key';
    const view = await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    expect(view.secureStorageAvailable).toBe(true);
    expect(view.profiles[0]?.hasApiKey).toBe(true);
    expect(await getAiApiKey('p1')).toBe(secret);
    expect(harness.state.encryptPlaintexts).toEqual([secret]);

    const secrets = await readSecretsFile();
    expect(secrets.keys['p1']).toBe(Buffer.from(`enc:${secret}`, 'utf8').toString('base64'));
    expect(secrets.keys['p1']).not.toBe(secret);
  });

  it('C — Linux unknown refuses durable secrets', async () => {
    harness.state.backend = 'unknown';
    const secret = 'unknown-backend-key';
    await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    expect(await getAiApiKey('p1')).toBe(secret);
    const secrets = await readSecretsFile();
    expect(secrets.keys).toEqual({});
    const raw = await readFile(join(harness.userData, 'ai-secrets.json'), 'utf8');
    expect(raw).not.toContain(secret);
  });

  it('D — encryption unavailable stays session-only', async () => {
    harness.state.encryptionAvailable = false;
    harness.state.backend = 'gnome_libsecret';
    const secret = 'no-encryption-key';
    const view = await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    expect(view.secureStorageAvailable).toBe(false);
    expect(await getAiApiKey('p1')).toBe(secret);
    expect(harness.state.encryptPlaintexts).toEqual([]);
    expect((await readSecretsFile()).keys).toEqual({});
  });

  it('E — macOS with encryption persists', async () => {
    harness.state.platform = 'darwin';
    setPlatform('darwin');
    harness.state.backend = 'basic_text'; // ignored off Linux
    const secret = 'macos-key';
    const view = await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    expect(view.secureStorageAvailable).toBe(true);
    expect((await readSecretsFile()).keys['p1']).toBe(
      Buffer.from(`enc:${secret}`, 'utf8').toString('base64'),
    );
  });

  it('F — Windows with encryption persists', async () => {
    harness.state.platform = 'win32';
    setPlatform('win32');
    const secret = 'windows-key';
    const view = await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    expect(view.secureStorageAvailable).toBe(true);
    expect((await readSecretsFile()).keys['p1']).toBe(
      Buffer.from(`enc:${secret}`, 'utf8').toString('base64'),
    );
  });

  it('G — basic_text restart keeps the profile but drops the key', async () => {
    const secret = 'session-only-restart';
    await saveAiConfig(config([profile({ name: 'Kept' })]), [{ profileId: 'p1', key: secret }]);
    expect(await getAiApiKey('p1')).toBe(secret);

    resetAiSettingsForTests();
    const view = await getAiConfigView();
    expect(view.profiles[0]?.name).toBe('Kept');
    expect(view.profiles[0]?.hasApiKey).toBe(false);
    expect(await getAiApiKey('p1')).toBe('');
    expect((await readSecretsFile()).keys).toEqual({});
  });

  it('H — secure restart recovers the key', async () => {
    harness.state.backend = 'kwallet6';
    const secret = 'kwallet-persisted';
    await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);

    resetAiSettingsForTests();
    expect(await getAiApiKey('p1')).toBe(secret);
    expect((await getAiConfigView()).profiles[0]?.hasApiKey).toBe(true);
  });

  it('legacy ciphertext is lifted to session then scrubbed when backend becomes basic_text', async () => {
    harness.state.backend = 'gnome_libsecret';
    const secret = 'formerly-secure-key';
    await saveAiConfig(config([profile()]), [{ profileId: 'p1', key: secret }]);
    const before = await readSecretsFile();
    expect(before.keys['p1']).toBeTruthy();

    harness.state.backend = 'basic_text';
    expect(await getAiApiKey('p1')).toBe(secret);
    expect((await getAiConfigView()).profiles[0]?.hasApiKey).toBe(true);

    const after = await readSecretsFile();
    expect(after.keys).toEqual({});
    const raw = await readFile(join(harness.userData, 'ai-secrets.json'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(before.keys['p1']);
  });

  it('M4 origin change still clears a basic_text session key', async () => {
    const secret = 'origin-bound-session';
    await saveAiConfig(config([profile({ baseUrl: 'https://a.example/v1' })]), [
      { profileId: 'p1', key: secret },
    ]);
    const view = await saveAiConfig(config([profile({ baseUrl: 'https://b.example/v1' })]), []);
    expect(view.profiles[0]?.hasApiKey).toBe(false);
    expect(await getAiApiKey('p1')).toBe('');
  });

  it('does not re-persist a session key when a later non-key save runs under basic_text', async () => {
    const secret = 'no-secondary-persist';
    await saveAiConfig(config([profile({ name: 'One' })]), [{ profileId: 'p1', key: secret }]);
    await saveAiConfig(config([profile({ name: 'Two' })]), []);
    expect(await getAiApiKey('p1')).toBe(secret);
    expect((await readSecretsFile()).keys).toEqual({});
    const raw = await readFile(join(harness.userData, 'ai-secrets.json'), 'utf8');
    expect(raw).not.toContain(secret);
  });

  it('seeded basic_text ciphertext on disk is scrubbed on first view', async () => {
    const secret = 'seeded-basic-ciphertext';
    const ciphertext = Buffer.from(`enc:${secret}`, 'utf8').toString('base64');
    await writeFile(
      join(harness.userData, 'ai-settings.json'),
      JSON.stringify(config([profile()]), null, 2),
    );
    await writeFile(
      join(harness.userData, 'ai-secrets.json'),
      JSON.stringify({ version: 1, keys: { p1: ciphertext } }, null, 2),
    );

    const view = await getAiConfigView();
    expect(view.profiles[0]?.hasApiKey).toBe(true);
    expect(await getAiApiKey('p1')).toBe(secret);
    expect((await readSecretsFile()).keys).toEqual({});
  });
});
