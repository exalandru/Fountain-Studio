import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { app } from 'electron';
import type { AppSettings, RecentFile } from '@shared/ipc-contract.js';
import { DEFAULT_SETTINGS } from '@shared/ipc-contract.js';
import type { Locale, Translator } from '@shared/i18n/index.js';
import { createTranslator, LOCALES, resolveLocale } from '@shared/i18n/index.js';

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

function storePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function defaults(): StoreShape {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, recent: [] };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
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
    const s = input.settings as Record<string, unknown>;
    const target = base.settings;

    if (s['theme'] === 'system' || s['theme'] === 'light' || s['theme'] === 'dark') {
      target.theme = s['theme'];
    }
    if (typeof s['language'] === 'string' && LOCALES.includes(s['language'] as Locale)) {
      target.language = s['language'] as Locale;
    }
    if (typeof s['editorFontSize'] === 'number' && Number.isFinite(s['editorFontSize'])) {
      target.editorFontSize = clamp(s['editorFontSize'], 10, 28);
    }
    if (typeof s['autosaveSeconds'] === 'number' && Number.isFinite(s['autosaveSeconds'])) {
      target.autosaveSeconds = clamp(s['autosaveSeconds'], 0, 3600);
    }
    if (typeof s['backupCount'] === 'number' && Number.isFinite(s['backupCount'])) {
      target.backupCount = clamp(s['backupCount'], 0, 20);
    }
    if (typeof s['showNotes'] === 'boolean') target.showNotes = s['showNotes'];
    if (typeof s['showSynopses'] === 'boolean') target.showSynopses = s['showSynopses'];
    if (typeof s['showSections'] === 'boolean') target.showSections = s['showSections'];
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
  }

  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const target = storePath();
  await mkdir(dirname(target), { recursive: true });

  // Same precaution as for screenplays: temporary file then rename, so an abrupt
  // shutdown never leaves a truncated settings.json behind.
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(cache, null, 2), 'utf8');
  await rename(temporary, target);
}

export async function getSettings(): Promise<AppSettings> {
  return { ...(await load()).settings };
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const store = await load();
  store.settings = { ...store.settings, ...patch };
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
