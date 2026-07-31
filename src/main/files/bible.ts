/**
 * Reading and writing the script bible sidecar file.
 *
 * The bible lives beside the screenplay (e.g. `script.fountain.bible.json` for
 * `script.fountain`). It stores character, location, object, and concept sheets — prose
 * fields written by the author or drafted by the AI. Factual data is never persisted; it
 * is recomputed from the AST on every render.
 *
 * Uses the same atomic-write pattern as the companion file: temporary file then rename.
 */

import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bible } from '@shared/bible/index.js';
import {
  BIBLE_ENTRY_KINDS,
  bibleImageName,
  createBible,
  parseBible,
  serializeBible,
} from '@shared/bible/index.js';
import { writeFileAtomic } from './atomic.js';

/** Derives the sidecar path from the screenplay path. */
export function biblePath(screenplayPath: string): string {
  return `${screenplayPath}.bible.json`;
}

const pendingWrites = new Map<string, Promise<Bible>>();

/**
 * Reads and parses the bible file.
 *
 * Returns `createBible()` when the file is missing, empty, or corrupt — never throws.
 * A corrupt sidecar costs the author nothing but the sheets that were actually unreadable.
 */
export async function readBible(screenplayPath: string): Promise<Bible> {
  try {
    const raw = await readFile(biblePath(screenplayPath), 'utf8');
    if (raw.trim().length === 0) return createBible();
    return parseBible(raw);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as Record<string, unknown>)['code'] === 'ENOENT'
    ) {
      return createBible();
    }
    throw error;
  }
}

/**
 * Writes a bible to disk atomically.
 *
 * Sorts entries before writing: by kind in `BIBLE_ENTRY_KINDS` order, then by name using
 * `localeCompare`. A stable file is a diffable file — this one sits next to a screenplay the
 * author may keep in git.
 *
 * Returns the bible it wrote, so the renderer's state and the disk cannot drift.
 */
export async function writeBible(screenplayPath: string, bible: Bible): Promise<Bible> {
  const target = biblePath(screenplayPath);
  // Never trust a structure that crossed the IPC boundary, even from our own renderer:
  // parseBible is the single authority on what a bible may contain, and running the incoming
  // object through it means an unknown field cannot reach the author's file.
  const checked = parseBible(JSON.stringify(bible));
  const sortedEntries = [...checked.entries].sort((a, b) => {
    const kindA = BIBLE_ENTRY_KINDS.indexOf(a.kind);
    const kindB = BIBLE_ENTRY_KINDS.indexOf(b.kind);
    if (kindA !== kindB) return kindA - kindB;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
  const sortedBible: Bible = { ...checked, entries: sortedEntries };

  const previous = pendingWrites.get(target) ?? Promise.resolve();
  const current = previous
    .catch(() => {
      // A failed write must not prevent a later state change from being persisted.
    })
    .then(async () => {
      await writeFileAtomic(target, serializeBible(sortedBible));
      return sortedBible;
    });
  pendingWrites.set(target, current);
  try {
    const result = await current;
    return result;
  } finally {
    if (pendingWrites.get(target) === current) pendingWrites.delete(target);
  }
}

/**
 * Where a sheet's picture lives.
 *
 * A folder beside the screenplay, like the snapshots: a real image file an author can open,
 * replace or copy without the application. Embedding the bytes in `bible.json` would turn a
 * legible, diffable sidecar into base64 noise.
 *
 * ```
 * films/
 * ├─ script.fountain
 * ├─ script.fountain.bible.json
 * └─ script.fountain.bible.images/
 *    └─ bib-a1b2c3.webp
 * ```
 */
export function bibleImagesDirectory(screenplayPath: string): string {
  return `${screenplayPath}.bible.images`;
}

/** Only what the renderer produces. Anything else is refused rather than stored. */
const ACCEPTED_PREFIX = 'data:image/webp;base64,';

/** Two megabytes of WebP is far past a 512-pixel portrait; past it, something is wrong. */
const MAX_IMAGE_BYTES = 2_000_000;

/**
 * Reads a sheet's picture as a data URI, or `null` when there is none.
 *
 * A data URI rather than a path because the renderer's Content-Security-Policy allows
 * `data:` and not `file:` — which is also why every picture passes through here, where it
 * can be checked.
 */
export async function readBibleImage(screenplayPath: string, id: string): Promise<string | null> {
  try {
    const bytes = await readFile(join(bibleImagesDirectory(screenplayPath), bibleImageName(id)));
    return `${ACCEPTED_PREFIX}${bytes.toString('base64')}`;
  } catch {
    // Missing is the normal case: most sheets have no picture.
    return null;
  }
}

/**
 * Writes a sheet's picture, returning the file name to record on the sheet.
 *
 * The main process does not trust what crossed the IPC boundary, even from our own renderer:
 * an SVG would be a script, and an arbitrary path would be an escape. The format is pinned,
 * the size is bounded, and the file name comes from the id — never from anything typed.
 */
export async function writeBibleImage(
  screenplayPath: string,
  id: string,
  dataUri: string,
): Promise<string> {
  if (!dataUri.startsWith(ACCEPTED_PREFIX)) {
    throw new Error('bible image must be WebP produced by the renderer');
  }
  const bytes = Buffer.from(dataUri.slice(ACCEPTED_PREFIX.length), 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('bible image is empty or too large');
  }
  const directory = bibleImagesDirectory(screenplayPath);
  await mkdir(directory, { recursive: true });
  await writeFileAtomic(join(directory, bibleImageName(id)), bytes);
  return bibleImageName(id);
}

/** Removes a sheet's picture. Called when a sheet is deleted, so the folder does not silt up. */
export async function deleteBibleImage(screenplayPath: string, id: string): Promise<void> {
  await unlink(join(bibleImagesDirectory(screenplayPath), bibleImageName(id))).catch(
    () => undefined,
  );
}

/** Pictures whose sheet is gone, so a deletion that failed once does not leave them for ever. */
export async function pruneBibleImages(
  screenplayPath: string,
  keep: readonly string[],
): Promise<void> {
  const wanted = new Set(keep.map(bibleImageName));
  const directory = bibleImagesDirectory(screenplayPath);
  const entries = await readdir(directory).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!wanted.has(entry)) await unlink(join(directory, entry)).catch(() => undefined);
  }
}
