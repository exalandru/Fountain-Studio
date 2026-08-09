/**
 * Versioned schema for the snapshot sidecar directory.
 *
 * Snapshots live beside the screenplay rather than inside the companion file, because each
 * one is a full copy of the document: a feature runs to some 120 KB, so ten snapshots
 * inside `script.fountain.appdata.json` would mean re-reading and re-validating more than a
 * megabyte on every open. One file per snapshot also means each is written atomically and
 * in isolation, and stays a plain `.fountain` an author can recover by hand.
 *
 * ```
 * films/
 * ├─ script.fountain
 * ├─ script.fountain.appdata.json
 * └─ script.fountain.snapshots/
 *    ├─ index.json
 *    └─ 20260730-1912-avant-acte3.fountain
 * ```
 *
 * Pure TypeScript (PLAN.md §3.1): both IPC sides and the unit tests share this validation.
 */

import { foldDiacritics } from '../text/index.js';

export const SNAPSHOT_INDEX_VERSION = 1 as const;

/** Upper bound on snapshots per screenplay: the list is a rail, not an archive. */
export const MAX_SNAPSHOTS = 50;

export const MAX_SNAPSHOT_NAME = 120;

export interface SnapshotMeta {
  id: string;
  name: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Recorded so the list can be shown without reading every snapshot file. */
  byteLength: number;
  lineCount: number;
  sceneCount: number;
}

export interface SnapshotIndex {
  version: typeof SNAPSHOT_INDEX_VERSION;
  /** Newest first. */
  snapshots: SnapshotMeta[];
}

export type SnapshotIssueCode =
  | 'indexMissing'
  | 'indexUnreadable'
  | 'indexInvalidSchema'
  | 'entryMissingFile'
  | 'orphanRecoverable'
  | 'orphanUnknown'
  | 'metadataMismatch'
  | 'duplicateId'
  | 'ambiguousFilename'
  | 'unparseableFilename';

export interface SnapshotIssue {
  code: SnapshotIssueCode;
  id?: string;
  fileName?: string;
}

/**
 * Catalog returned to the UI / repair flow.
 *
 * `ok` — index present, parseable, and consistent enough to trust without repair.
 * `repairable` — snapshot files (or a damaged index) exist; an explicit repair can rebuild
 *   a demonstrable index. `snapshots` may list recoverables for display without writing.
 * `error` — damage with nothing safely demonstrable to list (still never deletes files).
 */
export type SnapshotCatalog =
  | { status: 'ok'; snapshots: SnapshotMeta[]; issues: SnapshotIssue[] }
  | { status: 'repairable'; snapshots: SnapshotMeta[]; issues: SnapshotIssue[] }
  | { status: 'error'; snapshots: SnapshotMeta[]; issues: SnapshotIssue[] };

export type SnapshotIndexInterpretation =
  { status: 'ok'; index: SnapshotIndex } | { status: 'unreadable' } | { status: 'invalidSchema' };

/** The sidecar directory for a screenplay. */
export function snapshotDirectory(screenplayPath: string): string {
  return `${screenplayPath}.snapshots`;
}

export function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/**
 * Turns an author-supplied name into a filename fragment.
 *
 * This is a containment boundary, not a cosmetic transform. A name is free text typed into
 * a dialog and it ends up in a path, so everything outside the allowed set is folded to a
 * hyphen — which disposes of `..`, of both separators, of leading dots and of anything a
 * filesystem might interpret. The `id` remains the authority on the filename; the slug is
 * only there to make the directory readable.
 */
export function snapshotSlug(name: string): string {
  const slug = foldDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'instantane';
}

/** `20260730-1912` in local time — sorts naturally and reads at a glance. */
export function snapshotStamp(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** File name of a snapshot inside its directory. Never contains a path separator. */
export function snapshotFileName(meta: SnapshotMeta): string {
  return `${snapshotStamp(meta.createdAt)}-${snapshotSlug(meta.name)}-${meta.id}.fountain`;
}

export function sanitizeSnapshotName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, MAX_SNAPSHOT_NAME);
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Best-effort reconstruction of `createdAt` from a filename stamp.
 * Minute precision only; rejected when `snapshotStamp` would not round-trip (e.g. DST gaps).
 */
export function createdAtFromSnapshotStamp(stamp: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(stamp);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const createdAt = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  if (!Number.isFinite(createdAt) || snapshotStamp(createdAt) !== stamp) return null;
  return createdAt;
}

/**
 * Parses a snapshot filename into metadata fields that round-trip through
 * {@link snapshotFileName}. Returns null when identity cannot be demonstrated.
 *
 * Recoverable: id (from filename), createdAt (minute stamp), name (lossy slug reverse).
 * Not recovered here: original label text, exact historical milliseconds, byte/line/scene
 * counts (those come from reading the file during diagnose/repair).
 */
export function parseSnapshotFileName(
  fileName: string,
): Omit<SnapshotMeta, 'byteLength' | 'lineCount' | 'sceneCount'> | null {
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return null;
  if (!fileName.endsWith('.fountain')) return null;
  if (fileName.startsWith('.')) return null;

  const base = fileName.slice(0, -'.fountain'.length);
  const idMatch = /-(snap-[A-Za-z0-9_-]{1,75})$/.exec(base);
  if (!idMatch) return null;
  const id = idMatch[1]!;
  if (!isSnapshotId(id)) return null;

  const prefix = base.slice(0, -idMatch[0].length);
  const stampMatch = /^(\d{8}-\d{4})-(.+)$/.exec(prefix);
  if (!stampMatch) return null;
  const stamp = stampMatch[1]!;
  const slug = stampMatch[2]!;
  if (!slug || slug.startsWith('.') || slug.includes('..')) return null;

  const createdAt = createdAtFromSnapshotStamp(stamp);
  if (createdAt === null) return null;

  const fromSpaces = sanitizeSnapshotName(slug.replace(/-/g, ' '), slug);
  const name =
    snapshotSlug(fromSpaces) === slug ? fromSpaces : snapshotSlug(slug) === slug ? slug : null;
  if (name === null) return null;

  const provisional = { id, name, createdAt };
  if (
    snapshotFileName({ ...provisional, byteLength: 0, lineCount: 0, sceneCount: 0 }) !== fileName
  ) {
    return null;
  }
  return provisional;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function parseMeta(value: unknown): SnapshotMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isSnapshotId(record['id'])) return null;
  const createdAt = positiveInteger(record['createdAt']);
  if (createdAt === 0) return null;
  return {
    id: record['id'],
    name: sanitizeSnapshotName(record['name'], 'Instantané'),
    createdAt,
    byteLength: positiveInteger(record['byteLength']),
    lineCount: positiveInteger(record['lineCount']),
    sceneCount: positiveInteger(record['sceneCount']),
  };
}

/**
 * Distinguishes unreadable / invalid schema from a valid (possibly empty) index.
 * Does not invent entries from disk — that belongs to diagnose/repair.
 */
export function interpretSnapshotIndex(raw: string): SnapshotIndexInterpretation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 'invalidSchema' };
  const root = parsed as Record<string, unknown>;
  if (root['version'] !== SNAPSHOT_INDEX_VERSION) return { status: 'invalidSchema' };
  if (!Array.isArray(root['snapshots'])) return { status: 'invalidSchema' };

  const seen = new Set<string>();
  const snapshots: SnapshotMeta[] = [];
  for (const candidate of root['snapshots'].slice(0, MAX_SNAPSHOTS)) {
    const meta = parseMeta(candidate);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    snapshots.push(meta);
  }
  snapshots.sort((left, right) => right.createdAt - left.createdAt);
  return { status: 'ok', index: { version: SNAPSHOT_INDEX_VERSION, snapshots } };
}

/**
 * Reads the index, discarding anything malformed into an empty list.
 *
 * Prefer {@link interpretSnapshotIndex} when the caller must distinguish corruption from
 * a genuinely empty history. This helper remains for callers that only need entries.
 */
export function parseSnapshotIndex(raw: string): SnapshotIndex {
  const interpreted = interpretSnapshotIndex(raw);
  if (interpreted.status !== 'ok') {
    return { version: SNAPSHOT_INDEX_VERSION, snapshots: [] };
  }
  return interpreted.index;
}

export function serializeSnapshotIndex(index: SnapshotIndex): string {
  return JSON.stringify({ version: SNAPSHOT_INDEX_VERSION, snapshots: index.snapshots }, null, 2);
}
