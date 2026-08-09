import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@shared/fountain/index.js';
import type { SnapshotCatalog, SnapshotIssue, SnapshotMeta } from '@shared/snapshots/index.js';
import {
  MAX_SNAPSHOTS,
  interpretSnapshotIndex,
  parseSnapshotFileName,
  parseSnapshotIndex,
  sanitizeSnapshotName,
  serializeSnapshotIndex,
  snapshotDirectory,
  snapshotFileName,
} from '@shared/snapshots/index.js';
import { writeFileAtomic } from './atomic.js';
import { withDocumentBundleMutation } from './bundle-mutation.js';

/**
 * Named snapshots of a screenplay, in a sidecar directory beside it.
 *
 * Each snapshot is a plain `.fountain` file, so it stays readable and recoverable by hand
 * whatever happens to the index. The index only records metadata, which is what lets the
 * dialog list versions without reading every file.
 *
 * Writes are serialised per screenplay: two snapshots taken in quick succession must not
 * lose each other in the index. Index repair is explicit and never invents IDs.
 */

/** Raised with a code the renderer can translate, rather than an English sentence. */
export class SnapshotError extends Error {
  constructor(readonly code: 'limitReached' | 'notFound' | 'repairFailed' | 'indexDamaged') {
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

function damagedIndexPath(screenplayPath: string): string {
  return join(snapshotDirectory(screenplayPath), 'index.json.damaged');
}

function lineCountOf(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r?\n/).length;
}

function metricsFromContent(
  content: string,
): Pick<SnapshotMeta, 'byteLength' | 'lineCount' | 'sceneCount'> {
  return {
    byteLength: Buffer.byteLength(content, 'utf8'),
    lineCount: lineCountOf(content),
    sceneCount: parse(content).scenes.length,
  };
}

async function readIndexRaw(screenplayPath: string): Promise<string | null> {
  try {
    return await readFile(indexPath(screenplayPath), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Legacy helper: empty on missing/corrupt. Prefer {@link inspectSnapshotCatalog}. */
async function readIndex(screenplayPath: string): Promise<SnapshotMeta[]> {
  const raw = await readIndexRaw(screenplayPath);
  if (raw === null) return [];
  return parseSnapshotIndex(raw).snapshots;
}

async function writeIndex(screenplayPath: string, snapshots: SnapshotMeta[]): Promise<void> {
  await writeFileAtomic(
    indexPath(screenplayPath),
    serializeSnapshotIndex({ version: 1, snapshots }),
  );
}

async function listDirectory(screenplayPath: string): Promise<string[] | null> {
  try {
    return await readdir(snapshotDirectory(screenplayPath));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Index entries whose file is actually present, so a stale record cannot be clicked. */
async function reconcile(
  screenplayPath: string,
  snapshots: SnapshotMeta[],
): Promise<SnapshotMeta[]> {
  const present = await listDirectory(screenplayPath);
  if (present === null) return [];
  const names = new Set(present);
  return snapshots.filter((meta) => names.has(snapshotFileName(meta)));
}

interface RecoveredFile {
  fileName: string;
  meta: SnapshotMeta;
}

/**
 * Builds SnapshotMeta from a physical file when the filename round-trips.
 * Content metrics are measured from the bytes on disk (demonstrable, not invented labels).
 */
async function recoverFromFile(
  screenplayPath: string,
  fileName: string,
): Promise<RecoveredFile | null> {
  const parsed = parseSnapshotFileName(fileName);
  if (!parsed) return null;
  try {
    const content = await readFile(join(snapshotDirectory(screenplayPath), fileName), 'utf8');
    return {
      fileName,
      meta: { ...parsed, ...metricsFromContent(content) },
    };
  } catch {
    return null;
  }
}

/**
 * Diagnoses the snapshot sidecar without writing.
 *
 * Demonstrable recoverables are listed when the index is damaged so the UI can show them
 * before an explicit repair. Metadata mismatches are reported and never auto-normalised.
 */
export async function inspectSnapshotCatalog(screenplayPath: string): Promise<SnapshotCatalog> {
  const issues: SnapshotIssue[] = [];
  const entries = await listDirectory(screenplayPath);
  if (entries === null) {
    return { status: 'ok', snapshots: [], issues: [] };
  }

  const fountainFiles = entries
    .filter((name) => name.endsWith('.fountain') && !name.startsWith('.'))
    .sort();

  const raw = await readIndexRaw(screenplayPath);
  let indexMetas: SnapshotMeta[] | null = null;

  if (raw === null) {
    if (fountainFiles.length > 0) issues.push({ code: 'indexMissing' });
  } else {
    const interpreted = interpretSnapshotIndex(raw);
    if (interpreted.status === 'unreadable') {
      issues.push({ code: 'indexUnreadable' });
    } else if (interpreted.status === 'invalidSchema') {
      issues.push({ code: 'indexInvalidSchema' });
    } else {
      indexMetas = interpreted.index.snapshots;
    }
  }

  const recovered: RecoveredFile[] = [];
  const recoveredById = new Map<string, RecoveredFile[]>();
  const unknownOrphans: string[] = [];

  for (const fileName of fountainFiles) {
    const recoveredFile = await recoverFromFile(screenplayPath, fileName);
    if (!recoveredFile) {
      unknownOrphans.push(fileName);
      issues.push({ code: 'orphanUnknown', fileName });
      continue;
    }
    recovered.push(recoveredFile);
    const group = recoveredById.get(recoveredFile.meta.id) ?? [];
    group.push(recoveredFile);
    recoveredById.set(recoveredFile.meta.id, group);
  }

  const ambiguousIds = new Set<string>();
  for (const [id, group] of recoveredById) {
    if (group.length > 1) {
      ambiguousIds.add(id);
      for (const item of group) {
        issues.push({ code: 'duplicateId', id, fileName: item.fileName });
      }
    }
  }

  const demonstrable = recovered
    .filter((item) => !ambiguousIds.has(item.meta.id))
    .map((item) => item.meta)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_SNAPSHOTS);

  const indexedNames = new Set((indexMetas ?? []).map((meta) => snapshotFileName(meta)));

  if (indexMetas) {
    for (const meta of indexMetas) {
      const fileName = snapshotFileName(meta);
      if (!fountainFiles.includes(fileName)) {
        issues.push({ code: 'entryMissingFile', id: meta.id, fileName });
        continue;
      }
      const recoveredFile = recovered.find((item) => item.fileName === fileName);
      if (!recoveredFile) {
        issues.push({ code: 'unparseableFilename', id: meta.id, fileName });
        continue;
      }
      if (
        recoveredFile.meta.byteLength !== meta.byteLength ||
        recoveredFile.meta.lineCount !== meta.lineCount ||
        recoveredFile.meta.sceneCount !== meta.sceneCount
      ) {
        issues.push({ code: 'metadataMismatch', id: meta.id, fileName });
      }
    }

    for (const item of recovered) {
      if (ambiguousIds.has(item.meta.id)) continue;
      if (!indexedNames.has(item.fileName)) {
        issues.push({
          code: 'orphanRecoverable',
          id: item.meta.id,
          fileName: item.fileName,
        });
      }
    }
  } else {
    for (const item of recovered) {
      if (ambiguousIds.has(item.meta.id)) continue;
      issues.push({
        code: 'orphanRecoverable',
        id: item.meta.id,
        fileName: item.fileName,
      });
    }
  }

  const indexDamaged = issues.some(
    (issue) =>
      issue.code === 'indexMissing' ||
      issue.code === 'indexUnreadable' ||
      issue.code === 'indexInvalidSchema',
  );

  const mustRepair =
    indexDamaged ||
    issues.some(
      (issue) =>
        issue.code === 'orphanRecoverable' ||
        issue.code === 'duplicateId' ||
        issue.code === 'unparseableFilename',
    );

  if (!indexDamaged && indexMetas) {
    const snapshots = await reconcile(screenplayPath, indexMetas);
    if (!mustRepair) {
      // entryMissingFile / metadataMismatch / orphanUnknown are visible issues but the
      // parseable index remains authoritative until the author chooses Repair.
      return { status: 'ok', snapshots, issues };
    }
    return {
      status: 'repairable',
      snapshots: mergeDisplay(snapshots, demonstrable),
      issues,
    };
  }

  if (demonstrable.length > 0) {
    return { status: 'repairable', snapshots: demonstrable, issues };
  }

  if (indexDamaged || issues.length > 0) {
    return { status: 'error', snapshots: [], issues };
  }

  return { status: 'ok', snapshots: [], issues: [] };
}

function mergeDisplay(indexed: SnapshotMeta[], demonstrable: SnapshotMeta[]): SnapshotMeta[] {
  const known = new Set(indexed.map((meta) => meta.id));
  return [...indexed, ...demonstrable.filter((meta) => !known.has(meta.id))]
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, MAX_SNAPSHOTS);
}

/**
 * Trusted entries for H1 / callers that must fail closed on a damaged index.
 * A parseable index still yields its reconciled rows (so metadata mismatches stay visible
 * to baseline validation). Unreadable/missing indexes yield [].
 */
export async function listSnapshots(screenplayPath: string): Promise<SnapshotMeta[]> {
  const raw = await readIndexRaw(screenplayPath);
  if (raw === null) return [];
  const interpreted = interpretSnapshotIndex(raw);
  if (interpreted.status !== 'ok') return [];
  return reconcile(screenplayPath, interpreted.index.snapshots);
}

/**
 * Explicit repair: rebuild index only from filename-round-trippable files with unique IDs.
 * Preserves the previous index bytes on failure. Writes `index.json.damaged` once from the
 * original damaged bytes (never overwrites an existing forensic copy with a newer failure).
 * Does not invent IDs; does not adopt unknown orphans.
 */
export async function repairSnapshotIndex(screenplayPath: string): Promise<SnapshotCatalog> {
  return serialise(screenplayPath, () =>
    withDocumentBundleMutation(screenplayPath, async () => {
      const before = await inspectSnapshotCatalog(screenplayPath);
      if (before.status === 'ok' && before.issues.length === 0) return before;

      const entries = (await listDirectory(screenplayPath)) ?? [];
      const fountainFiles = entries
        .filter((name) => name.endsWith('.fountain') && !name.startsWith('.'))
        .sort();

      const recovered: RecoveredFile[] = [];
      const byId = new Map<string, RecoveredFile[]>();
      for (const fileName of fountainFiles) {
        const item = await recoverFromFile(screenplayPath, fileName);
        if (!item) continue;
        recovered.push(item);
        const group = byId.get(item.meta.id) ?? [];
        group.push(item);
        byId.set(item.meta.id, group);
      }

      const snapshots: SnapshotMeta[] = [];
      for (const item of recovered.sort(
        (left, right) =>
          right.meta.createdAt - left.meta.createdAt || left.meta.id.localeCompare(right.meta.id),
      )) {
        const group = byId.get(item.meta.id) ?? [];
        if (group.length !== 1) continue;
        if (snapshots.some((meta) => meta.id === item.meta.id)) continue;
        snapshots.push(item.meta);
        if (snapshots.length >= MAX_SNAPSHOTS) break;
      }

      // Ambiguous recoverables with nothing unique: refuse rather than invent an empty history.
      if (snapshots.length === 0 && byId.size > 0) {
        throw new SnapshotError('repairFailed');
      }

      const previousRaw = await readIndexRaw(screenplayPath);
      if (previousRaw !== null) {
        // Keep the first damaged original for inspection; never clobber it on retry.
        try {
          await readFile(damagedIndexPath(screenplayPath));
        } catch {
          await writeFileAtomic(damagedIndexPath(screenplayPath), previousRaw);
        }
      }

      try {
        await writeIndex(screenplayPath, snapshots);
        const written = await readFile(indexPath(screenplayPath), 'utf8');
        const interpreted = interpretSnapshotIndex(written);
        if (interpreted.status !== 'ok') {
          throw new SnapshotError('repairFailed');
        }
        if (interpreted.index.snapshots.length !== snapshots.length) {
          throw new SnapshotError('repairFailed');
        }
        for (let i = 0; i < snapshots.length; i++) {
          if (interpreted.index.snapshots[i]?.id !== snapshots[i]?.id) {
            throw new SnapshotError('repairFailed');
          }
        }
      } catch (error) {
        if (previousRaw !== null) {
          await writeFileAtomic(indexPath(screenplayPath), previousRaw);
        }
        if (error instanceof SnapshotError) throw error;
        throw new SnapshotError('repairFailed');
      }

      return inspectSnapshotCatalog(screenplayPath);
    }),
  );
}

export async function createSnapshot(
  screenplayPath: string,
  name: string,
  content: string,
): Promise<SnapshotMeta[]> {
  return serialise(screenplayPath, () =>
    withDocumentBundleMutation(screenplayPath, async () => {
      const catalog = await inspectSnapshotCatalog(screenplayPath);
      if (catalog.status !== 'ok') throw new SnapshotError('indexDamaged');

      const existing = catalog.snapshots;
      // Refusing is safer than silently dropping the oldest: the author decides what to lose.
      if (existing.length >= MAX_SNAPSHOTS) throw new SnapshotError('limitReached');

      const screenplay = parse(content);
      const meta: SnapshotMeta = {
        id: `snap-${randomUUID()}`,
        name: sanitizeSnapshotName(name, 'Instantané'),
        createdAt: Date.now(),
        byteLength: Buffer.byteLength(content, 'utf8'),
        lineCount: lineCountOf(content),
        sceneCount: screenplay.scenes.length,
      };

      // The file first: an index entry pointing at nothing would be worse than a file the
      // index does not yet know about, which diagnose reports as an orphan.
      await writeFileAtomic(
        join(snapshotDirectory(screenplayPath), snapshotFileName(meta)),
        content,
      );
      const next = [meta, ...existing];
      await writeIndex(screenplayPath, next);
      return next;
    }),
  );
}

export async function readSnapshot(screenplayPath: string, id: string): Promise<string> {
  const snapshots = await readIndex(screenplayPath);
  const meta = snapshots.find((candidate) => candidate.id === id);
  if (meta) {
    try {
      return await readFile(
        join(snapshotDirectory(screenplayPath), snapshotFileName(meta)),
        'utf8',
      );
    } catch {
      throw new SnapshotError('notFound');
    }
  }

  // Before repair: locate a unique demonstrable file by id suffix (no invented names).
  const entries = (await listDirectory(screenplayPath)) ?? [];
  const matches = entries.filter(
    (name) => name.endsWith(`-${id}.fountain`) && parseSnapshotFileName(name)?.id === id,
  );
  if (matches.length !== 1) throw new SnapshotError('notFound');
  try {
    return await readFile(join(snapshotDirectory(screenplayPath), matches[0]!), 'utf8');
  } catch {
    throw new SnapshotError('notFound');
  }
}

export async function renameSnapshot(
  screenplayPath: string,
  id: string,
  name: string,
): Promise<SnapshotMeta[]> {
  return serialise(screenplayPath, () =>
    withDocumentBundleMutation(screenplayPath, async () => {
      const catalog = await inspectSnapshotCatalog(screenplayPath);
      if (catalog.status !== 'ok') throw new SnapshotError('indexDamaged');

      const snapshots = catalog.snapshots;
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
    }),
  );
}

export async function deleteSnapshot(screenplayPath: string, id: string): Promise<SnapshotMeta[]> {
  return serialise(screenplayPath, () =>
    withDocumentBundleMutation(screenplayPath, async () => {
      const catalog = await inspectSnapshotCatalog(screenplayPath);
      if (catalog.status !== 'ok') throw new SnapshotError('indexDamaged');

      const snapshots = catalog.snapshots;
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
    }),
  );
}
