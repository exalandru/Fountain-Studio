import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@shared/fountain/index.js';
import type { SnapshotMeta } from '@shared/snapshots/index.js';
import {
  MAX_SNAPSHOTS,
  parseSnapshotIndex,
  sanitizeSnapshotName,
  serializeSnapshotIndex,
  snapshotDirectory,
  snapshotFileName,
} from '@shared/snapshots/index.js';
import { writeFileAtomic } from './atomic.js';

/**
 * Named snapshots of a screenplay, in a sidecar directory beside it.
 *
 * Each snapshot is a plain `.fountain` file, so it stays readable and recoverable by hand
 * whatever happens to the index. The index only records metadata, which is what lets the
 * dialog list versions without reading every file.
 *
 * Writes are serialised per screenplay: two snapshots taken in quick succession must not
 * lose each other in the index.
 */

/** Raised with a code the renderer can translate, rather than an English sentence. */
export class SnapshotError extends Error {
  constructor(readonly code: 'limitReached' | 'notFound') {
    super(code);
  }
}

const pendingByPath = new Map<string, Promise<unknown>>();

function serialise<T>(screenplayPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pendingByPath.get(screenplayPath) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  pendingByPath.set(screenplayPath, current);
  const cleanup = () => {
    if (pendingByPath.get(screenplayPath) === current) pendingByPath.delete(screenplayPath);
  };
  void current.then(cleanup, cleanup);
  return current;
}

function indexPath(screenplayPath: string): string {
  return join(snapshotDirectory(screenplayPath), 'index.json');
}

async function readIndex(screenplayPath: string): Promise<SnapshotMeta[]> {
  try {
    return parseSnapshotIndex(await readFile(indexPath(screenplayPath), 'utf8')).snapshots;
  } catch {
    // Missing or unreadable: an empty list, never a failure. The snapshot files, if any,
    // are untouched and can still be opened by hand.
    return [];
  }
}

async function writeIndex(screenplayPath: string, snapshots: SnapshotMeta[]): Promise<void> {
  await writeFileAtomic(
    indexPath(screenplayPath),
    serializeSnapshotIndex({ version: 1, snapshots }),
  );
}

/** Index entries whose file is actually present, so a stale record cannot be clicked. */
async function reconcile(
  screenplayPath: string,
  snapshots: SnapshotMeta[],
): Promise<SnapshotMeta[]> {
  let present: Set<string>;
  try {
    present = new Set(await readdir(snapshotDirectory(screenplayPath)));
  } catch {
    return [];
  }
  return snapshots.filter((meta) => present.has(snapshotFileName(meta)));
}

export async function listSnapshots(screenplayPath: string): Promise<SnapshotMeta[]> {
  return reconcile(screenplayPath, await readIndex(screenplayPath));
}

export async function createSnapshot(
  screenplayPath: string,
  name: string,
  content: string,
): Promise<SnapshotMeta[]> {
  return serialise(screenplayPath, async () => {
    const existing = await reconcile(screenplayPath, await readIndex(screenplayPath));
    // Refusing is safer than silently dropping the oldest: the author decides what to lose.
    if (existing.length >= MAX_SNAPSHOTS) throw new SnapshotError('limitReached');

    const screenplay = parse(content);
    const meta: SnapshotMeta = {
      id: `snap-${randomUUID()}`,
      name: sanitizeSnapshotName(name, 'Instantané'),
      createdAt: Date.now(),
      byteLength: Buffer.byteLength(content, 'utf8'),
      lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
      sceneCount: screenplay.scenes.length,
    };

    // The file first: an index entry pointing at nothing would be worse than a file the
    // index does not yet know about, which `reconcile` simply ignores.
    await writeFileAtomic(join(snapshotDirectory(screenplayPath), snapshotFileName(meta)), content);
    const next = [meta, ...existing];
    await writeIndex(screenplayPath, next);
    return next;
  });
}

export async function readSnapshot(screenplayPath: string, id: string): Promise<string> {
  const snapshots = await readIndex(screenplayPath);
  const meta = snapshots.find((candidate) => candidate.id === id);
  if (!meta) throw new SnapshotError('notFound');
  try {
    return await readFile(join(snapshotDirectory(screenplayPath), snapshotFileName(meta)), 'utf8');
  } catch {
    throw new SnapshotError('notFound');
  }
}

export async function renameSnapshot(
  screenplayPath: string,
  id: string,
  name: string,
): Promise<SnapshotMeta[]> {
  return serialise(screenplayPath, async () => {
    const snapshots = await readIndex(screenplayPath);
    const meta = snapshots.find((candidate) => candidate.id === id);
    if (!meta) throw new SnapshotError('notFound');

    // The file name embeds the slug, so renaming moves the file. Writing the new name and
    // removing the old one in that order means a crash leaves two files and one index
    // entry — recoverable — rather than an entry pointing at nothing.
    const previousFile = snapshotFileName(meta);
    const renamed: SnapshotMeta = { ...meta, name: sanitizeSnapshotName(name, meta.name) };
    const nextFile = snapshotFileName(renamed);
    if (nextFile !== previousFile) {
      const directory = snapshotDirectory(screenplayPath);
      const content = await readFile(join(directory, previousFile), 'utf8');
      await writeFileAtomic(join(directory, nextFile), content);
      await unlink(join(directory, previousFile)).catch(() => undefined);
    }

    const next = snapshots.map((candidate) => (candidate.id === id ? renamed : candidate));
    await writeIndex(screenplayPath, next);
    return next;
  });
}

export async function deleteSnapshot(screenplayPath: string, id: string): Promise<SnapshotMeta[]> {
  return serialise(screenplayPath, async () => {
    const snapshots = await readIndex(screenplayPath);
    const meta = snapshots.find((candidate) => candidate.id === id);
    // An entry whose file already vanished still has to leave the index.
    if (meta) {
      await unlink(join(snapshotDirectory(screenplayPath), snapshotFileName(meta))).catch(
        () => undefined,
      );
    }
    const next = snapshots.filter((candidate) => candidate.id !== id);
    await writeIndex(screenplayPath, next);
    return reconcile(screenplayPath, next);
  });
}
