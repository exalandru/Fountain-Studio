import { constants } from 'node:fs';
import { access, copyFile, readFile, rename, stat, unlink } from 'node:fs/promises';
import type { DocumentSnapshot, Eol, SaveOutcome, SaveRequest } from '@shared/ipc-contract.js';
import {
  DEFAULT_DOCUMENT_OPEN_LIMITS,
  type DocumentOpenLimits,
  MAX_OPEN_BATCH_BYTES,
  MAX_OPEN_FILE_BYTES,
  MAX_OPEN_PATHS,
} from '@shared/documents/limits.js';
import { writeFileAtomic } from './atomic.js';

/**
 * Reading and writing `.fountain` files.
 *
 * The specification (§7) requires that no data loss be possible, hence three
 * safeguards stacked together: atomic writes (temporary file plus rename), rotating
 * `.bak` backups, and external-change detection through mtime.
 */

export type DocumentOpenErrorCode =
  'tooLarge' | 'notRegularFile' | 'tooManyFiles' | 'batchTooLarge';

/** Structured failure for open UX; never carries stack traces into dialogs. */
export class DocumentOpenError extends Error {
  readonly code: DocumentOpenErrorCode;

  constructor(code: DocumentOpenErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'DocumentOpenError';
    this.code = code;
  }
}

export interface ReadDocumentOptions {
  /** Override individual size cap (bytes). Defaults to {@link MAX_OPEN_FILE_BYTES}. */
  maxBytes?: number;
}

export interface OpenPlanLimits {
  maxFileBytes?: number;
  maxBatchBytes?: number;
  maxPaths?: number;
}

export interface OpenPlanAccepted {
  path: string;
  size: number;
}

export interface OpenPlanFailure {
  path: string;
  error: Error;
}

export interface DocumentOpenPlan {
  accepted: OpenPlanAccepted[];
  failures: OpenPlanFailure[];
  /** Set when individually valid files exceed the cumulative batch budget. */
  batchError: DocumentOpenError | null;
}

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

function resolveOpenLimits(partial?: OpenPlanLimits): DocumentOpenLimits {
  return {
    maxFileBytes: partial?.maxFileBytes ?? DEFAULT_DOCUMENT_OPEN_LIMITS.maxFileBytes,
    maxBatchBytes: partial?.maxBatchBytes ?? DEFAULT_DOCUMENT_OPEN_LIMITS.maxBatchBytes,
    maxPaths: partial?.maxPaths ?? DEFAULT_DOCUMENT_OPEN_LIMITS.maxPaths,
  };
}

/**
 * Validates path count for one open request. Enforced in main for every entry
 * (IPC, native dialog, CLI, OS open-file) — not only the IPC envelope.
 */
export function assertOpenPathCount(paths: readonly string[], maxPaths = MAX_OPEN_PATHS): void {
  if (paths.length > maxPaths) {
    throw new DocumentOpenError('tooManyFiles');
  }
}

/**
 * Checked cumulative size. Rejects negative / non-finite sizes and overflow past the budget.
 */
export function assertOpenBatchBudget(
  sizes: readonly number[],
  maxBatchBytes = MAX_OPEN_BATCH_BYTES,
): void {
  let total = 0;
  for (const size of sizes) {
    if (!Number.isFinite(size) || size < 0 || !Number.isSafeInteger(size)) {
      throw new DocumentOpenError('batchTooLarge');
    }
    if (size > maxBatchBytes || total > maxBatchBytes - size) {
      throw new DocumentOpenError('batchTooLarge');
    }
    total += size;
  }
}

/**
 * Stat-before-read gate: regular file (symlink-to-file accepted via `stat`) and size.
 * Does not read file contents.
 */
export async function assertReadableDocument(
  path: string,
  maxBytes = MAX_OPEN_FILE_BYTES,
): Promise<{ size: number }> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  // `stat` follows symlinks. A symlink to a regular file remains accepted; a
  // symlink to a directory or a non-file node is refused as notRegularFile.
  if (!stats.isFile()) {
    throw new DocumentOpenError('notRegularFile');
  }

  const size = stats.size;
  if (!Number.isFinite(size) || size < 0 || !Number.isSafeInteger(size) || size > maxBytes) {
    throw new DocumentOpenError('tooLarge');
  }

  return { size };
}

/**
 * Preflight for multi-open: count → per-path stat/validate → cumulative budget.
 * No `readFile` runs here. Individually invalid paths become `failures` (partial
 * success contract). An aggregate over budget sets `batchError` and clears
 * `accepted` so nothing is read.
 */
export async function planDocumentOpen(
  paths: readonly string[],
  limits?: OpenPlanLimits,
): Promise<DocumentOpenPlan> {
  const resolved = resolveOpenLimits(limits);
  assertOpenPathCount(paths, resolved.maxPaths);

  const accepted: OpenPlanAccepted[] = [];
  const failures: OpenPlanFailure[] = [];

  for (const path of paths) {
    try {
      const { size } = await assertReadableDocument(path, resolved.maxFileBytes);
      accepted.push({ path, size });
    } catch (error) {
      failures.push({
        path,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  try {
    assertOpenBatchBudget(
      accepted.map((entry) => entry.size),
      resolved.maxBatchBytes,
    );
  } catch (error) {
    const batchError =
      error instanceof DocumentOpenError ? error : new DocumentOpenError('batchTooLarge');
    return { accepted: [], failures, batchError };
  }

  return { accepted, failures, batchError: null };
}

export async function readDocument(
  path: string,
  options?: ReadDocumentOptions,
): Promise<DocumentSnapshot> {
  const maxBytes = options?.maxBytes ?? MAX_OPEN_FILE_BYTES;
  await assertReadableDocument(path, maxBytes);

  const raw = stripBom(await readFile(path, 'utf8'));
  // Defensive post-read bound (TOCTOU grow). Full external races remain H3.
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new DocumentOpenError('tooLarge');
  }

  const stats = await stat(path);

  return {
    path,
    content: toLf(raw),
    eol: detectEol(raw),
    mtimeMs: stats.mtimeMs,
  };
}

/**
 * Full main-process open sequence: plan (stat / type / size / batch) then read
 * only accepted paths. Used by `openPaths` so dialogs stay in the IPC layer while
 * the no-read-before-validate invariant remains unit-testable.
 */
export async function openDocumentPaths(
  paths: readonly string[],
  limits?: OpenPlanLimits,
): Promise<{
  documents: DocumentSnapshot[];
  failures: OpenPlanFailure[];
  batchError: DocumentOpenError | null;
}> {
  const plan = await planDocumentOpen(paths, limits);
  if (plan.batchError) {
    return { documents: [], failures: plan.failures, batchError: plan.batchError };
  }

  const documents: DocumentSnapshot[] = [];
  const failures = [...plan.failures];
  const maxBytes = resolveOpenLimits(limits).maxFileBytes;

  for (const candidate of plan.accepted) {
    try {
      documents.push(await readDocument(candidate.path, { maxBytes }));
    } catch (error) {
      failures.push({
        path: candidate.path,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return { documents, failures, batchError: null };
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
    await unlink(oldest);
  }
  for (let i = keep - 1; i >= 1; i--) {
    const from = name(i);
    if (await fileExists(from)) {
      await rename(from, name(i + 1));
    }
  }

  await copyFile(path, name(1));
}

export async function saveDocument(
  request: SaveRequest,
  backupCount: number,
): Promise<SaveOutcome> {
  const { path, content, eol, expectedMtimeMs, refuseExisting = false } = request;

  try {
    if (refuseExisting && (await fileExists(path))) {
      const current = await stat(path);
      return { status: 'conflict', path, mtimeMs: current.mtimeMs };
    }

    // Refuse to overwrite if the file changed since it was read.
    if (expectedMtimeMs !== null && (await fileExists(path))) {
      const current = await stat(path);
      // One millisecond of tolerance: some file systems round mtime.
      if (Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
        return { status: 'conflict', path, mtimeMs: current.mtimeMs };
      }
    }

    await rotateBackups(path, backupCount);
    await writeFileAtomic(path, fromLf(content, eol));

    const stats = await stat(path);
    return { status: 'saved', path, mtimeMs: stats.mtimeMs };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
