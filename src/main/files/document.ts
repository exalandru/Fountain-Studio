import { createHash } from 'node:crypto';
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
import { commitSiblingTemporary, writeSiblingTemporary } from './atomic.js';

/**
 * Reading and writing `.fountain` files.
 *
 * The specification (§7) requires that no data loss be possible, hence four
 * safeguards stacked together: atomic writes (temporary file plus rename), rotating
 * `.bak` backups, stable reads through a content fingerprint (SHA-256 of the exact
 * bytes adopted), and external-change detection comparing that fingerprint to the
 * disk version that the current save is about to replace.
 */

export type DocumentOpenErrorCode =
  'tooLarge' | 'notRegularFile' | 'tooManyFiles' | 'batchTooLarge' | 'unstable';

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
 * Stat-before-read gate: regular file (symlink-to-file accepted via `stat`), size,
 * and the metadata of the same observation. Does not read file contents.
 */
export async function assertReadableDocument(
  path: string,
  maxBytes = MAX_OPEN_FILE_BYTES,
): Promise<{ size: number; mtimeMs: number }> {
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

  return { size, mtimeMs: stats.mtimeMs };
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
  const stable = await readStableFile(path, maxBytes);

  const raw = stable.bytes.toString('utf8');
  const text = stripBom(raw);

  return {
    path,
    content: toLf(text),
    eol: detectEol(text),
    mtimeMs: stable.mtimeMs,
    hash: stable.hash,
  };
}

/**
 * Bound on stable-read attempts.
 *
 * A normal file is stable on the second independent observation. One more attempt
 * lets a single transient mid-flight write settle before failing. Beyond that, the
 * file is being actively rewritten — a deterministic failure that refuses to adopt
 * any inconsistent version.
 */
export const MAX_STABLE_READ_ATTEMPTS = 3;

/** SHA-256 over exact bytes; the fingerprint identity for a filesystem version. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface StableFileRead {
  /** Exact bytes adopted as the document content base. */
  bytes: Buffer;
  /** `sha256Hex` of `bytes` — never of a later observation. */
  hash: string;
  mtimeMs: number;
}

/**
 * Content-stable read (H3).
 *
 * Each attempt: M2 gate (regular file, `stat.size <= maxBytes` — no allocation
 * before validation) → one full read → defensive post-read bound → SHA-256 of those
 * exact bytes. Two consecutive attempts with the same hash prove the content was not
 * rewritten while being read, so the adopted bytes and the reported metadata come
 * from the same version. The fingerprint is always computed on the bytes that are
 * actually returned to the caller — never on a later reopen.
 *
 * The reported mtime is the gate observation that immediately precedes the accepted
 * read — never an observation taken after adoption. A write that lands on disk after
 * the gate either changes what the read returns (hash mismatch → retry re-pairs the
 * next gate with the next read) or is invisible to the adopted version. Pairing the
 * mtime with a post-adoption stat instead could attach a newer version's timestamp
 * to older bytes; that would let the legacy recovery path later accept (and
 * overwrite) a disk version the adopted content never matched.
 */
export async function readStableFile(
  path: string,
  maxBytes = MAX_OPEN_FILE_BYTES,
): Promise<StableFileRead> {
  let previousHash: string | null = null;

  for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt++) {
    let bytes: Buffer;
    let attemptMtime: number;
    try {
      // Per-attempt M2 gate: size, file type and the metadata of this same
      // observation are captured before every read.
      const gate = await assertReadableDocument(path, maxBytes);
      attemptMtime = gate.mtimeMs;
      bytes = await readFile(path);
    } catch (error) {
      // A transient deletion/recreation in flight may leave one attempt looking like
      // ENOENT anywhere in the gate or read. The next attempt revalidates. Anything
      // else is final — throttling every identical error through the retry bound
      // keeps this bounded.
      if (isErrno(error, 'ENOENT') && attempt < MAX_STABLE_READ_ATTEMPTS) continue;
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Defensive post-read bound (TOCTOU grow): the file may have grown past the gate.
    if (bytes.length > maxBytes) {
      throw new DocumentOpenError('tooLarge');
    }

    const hash = sha256Hex(bytes);
    if (previousHash !== null && hash === previousHash) {
      return { bytes, hash, mtimeMs: attemptMtime };
    }
    previousHash = hash;
  }

  throw new DocumentOpenError('unstable', 'file is changing while being read');
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
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

export type ConflictReason = 'changed-externally' | 'missing' | 'unstable' | 'mtime';

/**
 * Upper bound of what the app itself can have published on disk, in bytes:
 * the renderer caps authored content at 100 000 000 characters and UTF-8 needs
 * at most 4 bytes per character. Anything above this size cannot be the app's
 * own base, so the save verification can refuse to read it without risking a
 * false "changed" on a legitimate file.
 */
const MAX_PUBLISHABLE_BYTES = 4 * MAX_OPEN_FILE_BYTES;

/**
 * Final check immediately before the atomic rename.
 *
 * The disk version is observed here — after the expensive preparation (backup
 * rotation, temp write) — so the gap between the last comparison and the publish is
 * limited to the rename itself. With classic filesystem primitives a writer that
 * commits strictly between that observation and the rename cannot be caught; that
 * residual window is documented as not fully eliminable without a compare-and-swap.
 */
async function verifyBaseUnchanged(
  path: string,
  request: SaveRequest,
  existedInitially: boolean,
): Promise<
  { status: 'ok' } | { status: 'conflict'; mtimeMs: number | null; reason: ConflictReason }
> {
  const { expectedHash, expectedMtimeMs } = request;

  if (expectedHash !== null && expectedHash !== undefined) {
    if (!existedInitially) {
      // The base is known but the file is gone: no silent recreation. The author
      // keeps LOCAL in memory and can choose Save As.
      return { status: 'conflict', mtimeMs: null, reason: 'missing' };
    }
    // The verification bound follows the file actually on disk, capped at what the
    // app itself could have published. The open-path M2 cap (MAX_OPEN_FILE_BYTES)
    // must not apply here: a large file the app previously saved must still verify,
    // otherwise every further save of it would falsely report "changed outside".
    let currentSize: number;
    try {
      const current = await stat(path);
      currentSize = current.size;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { status: 'conflict', mtimeMs: null, reason: 'missing' };
      }
      throw error;
    }
    if (currentSize > MAX_PUBLISHABLE_BYTES) {
      // Too large to be any version this app authored: the entry was replaced
      // externally. Declared without reading it.
      return { status: 'conflict', mtimeMs: null, reason: 'changed-externally' };
    }
    try {
      const verifyMaxBytes = Math.max(MAX_OPEN_FILE_BYTES, currentSize);
      const observed = await readStableFile(path, verifyMaxBytes);
      if (observed.hash !== expectedHash) {
        return { status: 'conflict', mtimeMs: observed.mtimeMs, reason: 'changed-externally' };
      }
      return { status: 'ok' };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { status: 'conflict', mtimeMs: null, reason: 'missing' };
      }
      if (error instanceof DocumentOpenError) {
        if (error.code === 'unstable') {
          return { status: 'conflict', mtimeMs: null, reason: 'unstable' };
        }
        // Size/type violations mean the entry was replaced externally.
        return { status: 'conflict', mtimeMs: null, reason: 'changed-externally' };
      }
      throw error;
    }
  }

  // Legacy fallback: documents restored from recovery carry an mtime but no
  // fingerprint. mtime remains the only available authority there.
  if (expectedMtimeMs !== null) {
    if (!existedInitially) {
      // The base is known (a recorded mtime) but the file is gone: same fail-safe
      // as the fingerprint path — no silent recreation.
      return { status: 'conflict', mtimeMs: null, reason: 'missing' };
    }
    try {
      const current = await stat(path);
      // One millisecond of tolerance: some file systems round mtime. This tolerance
      // never applies when a fingerprint is available — hash comparison is then the
      // sole authority.
      if (Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
        return { status: 'conflict', mtimeMs: current.mtimeMs, reason: 'mtime' };
      }
      return { status: 'ok' };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { status: 'conflict', mtimeMs: null, reason: 'missing' };
      }
      throw error;
    }
  }

  return { status: 'ok' };
}

export async function saveDocument(
  request: SaveRequest,
  backupCount: number,
): Promise<SaveOutcome> {
  const { path, content, eol, refuseExisting = false } = request;

  // Hash of the exact bytes that will be published — the new filesystem base on success.
  const publishedBytes = Buffer.from(fromLf(content, eol), 'utf8');
  const publishedHash = sha256Hex(publishedBytes);

  let temporary: string | null = null;
  try {
    // Unknown previous state: refuse an existing target outright.
    if (refuseExisting && (await fileExists(path))) {
      const current = await stat(path);
      return { status: 'conflict', path, mtimeMs: current.mtimeMs };
    }

    const existedInitially = await fileExists(path);

    if (existedInitially) {
      // Backups rotate BEFORE the final verification, while the source is still the
      // previous version. Moving the full-file copy after the verdict would re-observe
      // the source between verification and publish — widening the residual TOCTOU
      // window with a bulk read. Accepted tradeoff (F-2): a conflicted save still
      // advances the .bak chain, mirroring what a successful publish would have done;
      // the backup copies are never discarded, only their slots shift.
      await rotateBackups(path, backupCount);
    }

    // Prepare before verification: the expensive work happens first, so the final
    // check can be placed immediately before the atomic publish.
    temporary = await writeSiblingTemporary(path, publishedBytes);

    const verdict = await verifyBaseUnchanged(path, request, existedInitially);
    if (verdict.status === 'conflict') {
      await unlink(temporary).catch(() => undefined);
      temporary = null;
      return { status: 'conflict', path, mtimeMs: verdict.mtimeMs, reason: verdict.reason };
    }

    await commitSiblingTemporary(temporary, path);
    temporary = null;

    const stats = await stat(path);
    return { status: 'saved', path, mtimeMs: stats.mtimeMs, hash: publishedHash };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (temporary !== null) {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
