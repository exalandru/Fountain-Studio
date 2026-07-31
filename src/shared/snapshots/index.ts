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
 * Reads the index, discarding anything malformed.
 *
 * A corrupt or unreadable index must never cost the author their snapshot *files*: the
 * worst outcome is an empty list beside intact `.fountain` files, which can be reopened by
 * hand. Hence the tolerant parse rather than a throw.
 */
export function parseSnapshotIndex(raw: string): SnapshotIndex {
  const empty: SnapshotIndex = { version: SNAPSHOT_INDEX_VERSION, snapshots: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const root = parsed as Record<string, unknown>;
  if (root['version'] !== SNAPSHOT_INDEX_VERSION) return empty;
  if (!Array.isArray(root['snapshots'])) return empty;

  const seen = new Set<string>();
  const snapshots: SnapshotMeta[] = [];
  for (const candidate of root['snapshots'].slice(0, MAX_SNAPSHOTS)) {
    const meta = parseMeta(candidate);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    snapshots.push(meta);
  }
  snapshots.sort((left, right) => right.createdAt - left.createdAt);
  return { version: SNAPSHOT_INDEX_VERSION, snapshots };
}

export function serializeSnapshotIndex(index: SnapshotIndex): string {
  return JSON.stringify({ version: SNAPSHOT_INDEX_VERSION, snapshots: index.snapshots }, null, 2);
}
