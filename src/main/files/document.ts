import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DocumentSnapshot, Eol, SaveOutcome, SaveRequest } from '@shared/ipc-contract.js';

/**
 * Reading and writing `.fountain` files.
 *
 * The specification (§7) requires that no data loss be possible, hence three
 * safeguards stacked together: atomic writes (temporary file plus rename), rotating
 * `.bak` backups, and external-change detection through mtime.
 */

/** Detects the dominant line ending so it can be restored on write. */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return 'lf';
  const lf = (text.match(/\n/g) ?? []).length;
  // A mixed file is rewritten with whichever ending is in the majority.
  return crlf >= lf - crlf ? 'crlf' : 'lf';
}

/** Normalises to LF for the editor; the original ending is kept alongside. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function fromLf(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

/** Strips the UTF-8 BOM, which must never reach the parser. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function readDocument(path: string): Promise<DocumentSnapshot> {
  const raw = stripBom(await readFile(path, 'utf8'));
  const stats = await stat(path);

  return {
    path,
    content: toLf(raw),
    eol: detectEol(raw),
    mtimeMs: stats.mtimeMs,
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rotates the backups: `script.fountain.bak` is the most recent, `.bak2` the one
 * before, and so on. The oldest is dropped.
 */
async function rotateBackups(path: string, keep: number): Promise<void> {
  if (keep <= 0) return;
  if (!(await fileExists(path))) return;

  const name = (index: number) => (index === 1 ? `${path}.bak` : `${path}.bak${index}`);

  // Remove the oldest, then shift the others down one slot.
  const oldest = name(keep);
  if (await fileExists(oldest)) {
    await unlink(oldest).catch(() => undefined);
  }
  for (let i = keep - 1; i >= 1; i--) {
    const from = name(i);
    if (await fileExists(from)) {
      await rename(from, name(i + 1)).catch(() => undefined);
    }
  }

  await copyFile(path, name(1)).catch(() => undefined);
}

/**
 * Atomic write: the temporary file goes in the **same directory** (therefore the same
 * volume, otherwise `rename` stops being atomic), it is flushed to disk, then renamed
 * over the target. A power cut leaves either the old file intact or the new one
 * complete — never a truncated file.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );

  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function saveDocument(
  request: SaveRequest,
  backupCount: number,
): Promise<SaveOutcome> {
  const { path, content, eol, expectedMtimeMs } = request;

  try {
    // Refuse to overwrite if the file changed since it was read.
    if (expectedMtimeMs !== null && (await fileExists(path))) {
      const current = await stat(path);
      // One millisecond of tolerance: some file systems round mtime.
      if (Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
        return { status: 'conflict', path, mtimeMs: current.mtimeMs };
      }
    }

    await mkdir(dirname(path), { recursive: true });
    await rotateBackups(path, backupCount);
    await writeAtomic(path, fromLf(content, eol));

    const stats = await stat(path);
    return { status: 'saved', path, mtimeMs: stats.mtimeMs };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
