import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app } from 'electron';
import type { AppSettings, RecentFile } from '@shared/ipc-contract.js';
import { DEFAULT_SETTINGS } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';
import { createTranslator, resolveLocale } from '@shared/i18n/index.js';
import { sanitizeSettings } from '@shared/settings/index.js';
import { writeFileAtomic } from './files/atomic.js';

/**
 * Settings and recent files, persisted as JSON in the userData directory.
 *
 * Written by hand rather than pulled from `electron-store`: the need fits in fifty
 * lines, and it is one less dependency to audit (PLAN.md §2.1).
 */

const MAX_RECENT = 12;

interface StoreShape {
  version: 1;
  settings: AppSettings;
  recent: RecentFile[];
}

let cache: StoreShape | null = null;
let persistQueue: Promise<void> = Promise.resolve();

function storePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function defaults(): StoreShape {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, recent: [] };
}

/**
 * Keeps only known keys, and **bounds** numeric values.
 *
 * This file is meant to be hand-editable, so values are validated, not just their
 * types. An `editorFontSize` of 900 or a negative `backupCount` must not be able to
 * make the application unusable.
 */
function sanitize(raw: unknown): StoreShape {
  const base = defaults();
  if (typeof raw !== 'object' || raw === null) return base;

  const input = raw as { settings?: unknown; recent?: unknown };

  if (typeof input.settings === 'object' && input.settings !== null) {
    base.settings = sanitizeSettings(input.settings);
  }

  if (Array.isArray(input.recent)) {
    base.recent = input.recent
      .filter(
        (entry): entry is RecentFile =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as RecentFile).path === 'string',
      )
      .slice(0, MAX_RECENT)
      .map((entry) => ({
        path: entry.path,
        name: typeof entry.name === 'string' ? entry.name : basename(entry.path),
        openedAt: typeof entry.openedAt === 'number' ? entry.openedAt : 0,
      }));
  }

  return base;
}

async function load(): Promise<StoreShape> {
  if (cache) return cache;

  try {
    const raw = await readFile(storePath(), 'utf8');
    cache = sanitize(JSON.parse(raw));
  } catch {
    // First launch, or unreadable file: start from the defaults.
    //
    // The interface defaults to English, but on a genuinely first launch we adopt the
    // OS language when we ship a catalogue for it — a French user should not have to
    // hunt through an English menu to find the language switch. Anything we do not
    // translate still falls back to English.
    cache = defaults();
    cache.settings.language = resolveLocale(app.getLocale());
    cache.settings.spellcheckLanguage = cache.settings.language === 'fr' ? 'fr' : 'en-US';
  }

  return cache;
}

async function persist(): Promise<void> {
  persistQueue = persistQueue.then(async () => {
    if (!cache) return;
    const target = storePath();
    await writeFileAtomic(target, JSON.stringify(cache, null, 2));
  });
  return persistQueue;
}

export async function getSettings(): Promise<AppSettings> {
  return { ...(await load()).settings };
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const store = await load();
  store.settings = sanitize({
    settings: { ...store.settings, ...patch },
    recent: store.recent,
  }).settings;
  await persist();
  return { ...store.settings };
}

/** Translator for the current interface language, for menus and native dialogs. */
export async function getTranslator(): Promise<Translator> {
  return createTranslator((await load()).settings.language);
}

export async function listRecent(): Promise<RecentFile[]> {
  return [...(await load()).recent];
}

export async function addRecent(path: string): Promise<void> {
  const store = await load();
  store.recent = [
    { path, name: basename(path), openedAt: Date.now() },
    ...store.recent.filter((entry) => entry.path !== path),
  ].slice(0, MAX_RECENT);
  await persist();
  app.addRecentDocument(path);
}

export async function clearRecent(): Promise<void> {
  const store = await load();
  store.recent = [];
  await persist();
  app.clearRecentDocuments();
}
