import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { AiConfig, AiConfigView, AiConnectionProfile, AiKeyUpdate } from '@shared/ai/index.js';
import { DEFAULT_AI_CONFIG, sanitizeAiConfig } from '@shared/ai/index.js';
import { writeFileAtomic } from '../files/atomic.js';

interface SecretFile {
  version: 1;
  keys: Record<string, string>;
}

let configCache: AiConfig | null = null;
let secretCache: SecretFile | null = null;
const sessionKeys = new Map<string, string>();
let queue: Promise<void> = Promise.resolve();

function configPath(): string {
  return join(app.getPath('userData'), 'ai-settings.json');
}

function secretPath(): string {
  return join(app.getPath('userData'), 'ai-secrets.json');
}

async function loadConfig(): Promise<AiConfig> {
  if (configCache) return configCache;
  try {
    configCache = sanitizeAiConfig(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch {
    configCache = sanitizeAiConfig(DEFAULT_AI_CONFIG);
  }
  return configCache;
}

async function loadSecrets(): Promise<SecretFile> {
  if (secretCache) return secretCache;
  try {
    const parsed = JSON.parse(await readFile(secretPath(), 'utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const input = parsed as Record<string, unknown>;
      const keys =
        typeof input['keys'] === 'object' && input['keys'] !== null
          ? Object.fromEntries(
              Object.entries(input['keys'] as Record<string, unknown>).filter(
                (entry): entry is [string, string] =>
                  /^[A-Za-z0-9_-]{1,80}$/.test(entry[0]) &&
                  typeof entry[1] === 'string' &&
                  entry[1].length <= 100_000,
              ),
            )
          : {};
      secretCache = { version: 1, keys };
      return secretCache;
    }
  } catch {
    // Missing or unreadable secret storage starts empty.
  }
  secretCache = { version: 1, keys: {} };
  return secretCache;
}

async function persist(config: AiConfig, secrets: SecretFile): Promise<void> {
  queue = queue
    .catch(() => {
      // A previous disk failure must not permanently poison later save attempts.
    })
    .then(async () => {
      await writeFileAtomic(configPath(), JSON.stringify(config, null, 2));
      // This file only ever contains encrypted values. Writing it even while secure
      // storage is temporarily unavailable also makes key removals durable.
      await writeFileAtomic(secretPath(), JSON.stringify(secrets, null, 2));
    });
  return queue;
}

async function hasKey(profileId: string): Promise<boolean> {
  if (sessionKeys.has(profileId)) return true;
  const encrypted = (await loadSecrets()).keys[profileId];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return false;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64')).length > 0;
  } catch {
    return false;
  }
}

export async function getAiConfigView(): Promise<AiConfigView> {
  const config = await loadConfig();
  return {
    ...config,
    profiles: await Promise.all(
      config.profiles.map(async (profile) => ({ ...profile, hasApiKey: await hasKey(profile.id) })),
    ),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  };
}

export async function saveAiConfig(
  raw: AiConfig,
  keyUpdates: AiKeyUpdate[],
): Promise<AiConfigView> {
  const config = sanitizeAiConfig(raw);
  const secrets = await loadSecrets();
  const profileIds = new Set(config.profiles.map((profile) => profile.id));

  for (const id of Object.keys(secrets.keys)) {
    if (!profileIds.has(id)) delete secrets.keys[id];
  }
  for (const id of [...sessionKeys.keys()]) {
    if (!profileIds.has(id)) sessionKeys.delete(id);
  }

  for (const update of keyUpdates) {
    if (!profileIds.has(update.profileId)) continue;
    if (update.key === null || update.key.length === 0) {
      delete secrets.keys[update.profileId];
      sessionKeys.delete(update.profileId);
    } else if (safeStorage.isEncryptionAvailable()) {
      secrets.keys[update.profileId] = safeStorage.encryptString(update.key).toString('base64');
      sessionKeys.delete(update.profileId);
    } else {
      sessionKeys.set(update.profileId, update.key);
    }
  }

  configCache = config;
  secretCache = secrets;
  await persist(config, secrets);
  return getAiConfigView();
}

export async function resolveAiProfile(profileId: string): Promise<AiConnectionProfile> {
  const config = await loadConfig();
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('Unknown AI profile');
  return { ...profile };
}

export async function getAiApiKey(profileId: string): Promise<string> {
  const session = sessionKeys.get(profileId);
  if (session !== undefined) return session;
  if (!safeStorage.isEncryptionAvailable()) return '';
  const encrypted = (await loadSecrets()).keys[profileId];
  if (!encrypted) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return '';
  }
}

export async function getBrainstormingPrompt(): Promise<string> {
  return (await loadConfig()).brainstormingPrompt;
}
