import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type { AppData } from '@shared/appdata/index.js';
import { parseAppData, serializeAppData } from '@shared/appdata/index.js';
import { writeFileAtomic } from './atomic.js';

/**
 * Reading and writing the companion `.fountain.appdata.json` file.
 *
 * The companion file lives alongside the screenplay (e.g. `script.fountain.appdata.json`
 * for `script.fountain`). It stores sidebar state, preview configuration, and per-document
 * preferences.
 *
 * Uses the same atomic-write pattern as the screenplay files: temporary file then rename.
 */

/** Derives the companion file path from the screenplay path. */
export function companionPath(screenplayPath: string): string {
  return `${screenplayPath}.appdata.json`;
}

const pendingWrites = new Map<string, Promise<void>>();

/** Checks whether the companion file exists. */
export async function companionExists(path: string): Promise<boolean> {
  try {
    await access(companionPath(path), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses the companion file.
 *
 * Returns `null` when the file is missing, empty, or on an unsupported schema version.
 */
export async function readAppData(path: string): Promise<AppData | null> {
  try {
    const raw = await readFile(companionPath(path), 'utf8');
    if (raw.trim().length === 0) return null;
    return parseAppData(raw);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Writes AppData to disk atomically.
 *
 * If the companion file did not exist, its parent directory is created first.
 */
export async function writeAppData(path: string, data: AppData): Promise<void> {
  const target = companionPath(path);
  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const current = previous.then(async () => {
    await writeFileAtomic(target, serializeAppData(data));
  });
  pendingWrites.set(target, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(target) === current) pendingWrites.delete(target);
  }
}
