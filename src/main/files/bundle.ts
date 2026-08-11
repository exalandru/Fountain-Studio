import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseAppData, serializeAppData } from '@shared/appdata/index.js';
import { BIBLE_VERSION, bibleImageName, parseBible, serializeBible } from '@shared/bible/index.js';
import { comparableDocumentPath } from '@shared/documents/paths.js';
import { parse } from '@shared/fountain/index.js';
import type { SaveAsBundleRequest, SaveOutcome } from '@shared/ipc-contract.js';
import {
  parseSnapshotIndex,
  serializeSnapshotIndex,
  SNAPSHOT_INDEX_VERSION,
  snapshotFileName,
  snapshotDirectory,
} from '@shared/snapshots/index.js';
import { companionPath } from './appdata.js';
import { bibleImagesDirectory, biblePath } from './bible.js';
import { beginBundleTransition, withBundleMutation } from './bundle-mutation.js';
import { fromLf, saveDocument, sha256Hex } from './document.js';
import { writeFileAtomic } from './atomic.js';
import { inspectSnapshotCatalog } from './snapshots.js';

export interface DocumentBundlePaths {
  document: string;
  appData: string;
  bible: string;
  bibleImages: string;
  snapshots: string;
}

interface PreparedBundle {
  root: string;
  paths: DocumentBundlePaths;
  bible: string | null;
  bibleImages: ReadonlyMap<string, Buffer>;
  snapshots: ReadonlyMap<string, string>;
  snapshotIndex: string | null;
}

interface Component {
  key: keyof DocumentBundlePaths;
  target: string;
  prepared: string;
}

export type SaveAsTransactionStep =
  'prepared' | 'destination-backed-up' | 'published' | 'validated';
export type SaveAsTransactionObserver = (step: SaveAsTransactionStep) => void | Promise<void>;

export function documentBundlePaths(screenplayPath: string): DocumentBundlePaths {
  return {
    document: screenplayPath,
    appData: companionPath(screenplayPath),
    bible: biblePath(screenplayPath),
    bibleImages: bibleImagesDirectory(screenplayPath),
    snapshots: snapshotDirectory(screenplayPath),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function comparable(path: string): string {
  return comparableDocumentPath(resolve(path));
}

async function sameExistingEntry(left: string, right: string): Promise<boolean> {
  try {
    const [leftStats, rightStats] = await Promise.all([stat(left), stat(right)]);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch {
    return false;
  }
}

async function sameDocumentPath(left: string, right: string): Promise<boolean> {
  return comparable(left) === comparable(right) || sameExistingEntry(left, right);
}

function isInside(path: string, directory: string): boolean {
  const relation = relative(resolve(directory), resolve(path));
  return (
    relation === '' ||
    (!relation.startsWith('..') &&
      !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

async function assertNamespacesDoNotOverlap(sourcePath: string, destinationPath: string) {
  const source = documentBundlePaths(sourcePath);
  const destination = documentBundlePaths(destinationPath);
  const sourceEntries = Object.values(source);
  const destinationEntries = Object.values(destination);

  for (const sourceEntry of sourceEntries) {
    for (const destinationEntry of destinationEntries) {
      if (
        comparable(sourceEntry) === comparable(destinationEntry) ||
        (await sameExistingEntry(sourceEntry, destinationEntry))
      ) {
        throw new Error('Save As destination overlaps the source project bundle');
      }
    }
  }
  if (
    isInside(destinationPath, source.bibleImages) ||
    isInside(destinationPath, source.snapshots)
  ) {
    throw new Error('Save As destination is inside the source project bundle');
  }
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split(/\r?\n/).length;
}

function validateSnapshot(
  meta: ReturnType<typeof parseSnapshotIndex>['snapshots'][number],
  source: string,
) {
  if (
    Buffer.byteLength(source, 'utf8') !== meta.byteLength ||
    lineCount(source) !== meta.lineCount ||
    parse(source).scenes.length !== meta.sceneCount
  ) {
    throw new Error(`Snapshot ${meta.id} does not match its index metadata`);
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

async function prepareBundle(request: SaveAsBundleRequest): Promise<PreparedBundle> {
  const destinationParent = dirname(request.destinationPath);
  await mkdir(destinationParent, { recursive: true });
  const root = await mkdtemp(
    join(destinationParent, `.${basename(request.destinationPath)}.saveas-`),
  );
  const paths = documentBundlePaths(join(root, 'document'));
  const expectedAppData = parseAppData(serializeAppData(request.appData));
  if (!expectedAppData) throw new Error('Invalid appdata for Save As');

  const bibleImages = new Map<string, Buffer>();
  const snapshots = new Map<string, string>();
  let bible: string | null = null;
  let snapshotIndex: string | null = null;

  try {
    await writeFileAtomic(paths.document, fromLf(request.content, request.eol));
    await writeFileAtomic(paths.appData, serializeAppData(expectedAppData));

    if (request.sourcePath !== null) {
      const source = documentBundlePaths(request.sourcePath);
      const rawBible = await readOptionalFile(source.bible);
      if (rawBible !== null) {
        let parsedRoot: unknown;
        try {
          parsedRoot = JSON.parse(rawBible);
        } catch {
          throw new Error('The source Bible sidecar is unreadable');
        }
        if (typeof parsedRoot !== 'object' || parsedRoot === null) {
          throw new Error('The source Bible sidecar is invalid');
        }
        const bibleRoot = parsedRoot as Record<string, unknown>;
        if (bibleRoot['version'] !== BIBLE_VERSION || !Array.isArray(bibleRoot['entries'])) {
          throw new Error('The source Bible sidecar has an unsupported schema');
        }
        const parsedBible = parseBible(rawBible);
        bible = serializeBible(parsedBible);
        await writeFileAtomic(paths.bible, bible);
        for (const entry of parsedBible.entries) {
          if (entry.image === null) continue;
          const name = bibleImageName(entry.id);
          const bytes = await readFile(join(source.bibleImages, name));
          bibleImages.set(name, bytes);
          await mkdir(paths.bibleImages, { recursive: true });
          await writeFileAtomic(join(paths.bibleImages, name), bytes);
        }
      }

      const rawIndex = await readOptionalFile(join(source.snapshots, 'index.json'));
      const catalog = await inspectSnapshotCatalog(request.sourcePath);
      if (catalog.status !== 'ok') {
        throw new Error('The source snapshot history is damaged and must be repaired first');
      }
      if (rawIndex !== null) {
        let parsedRoot: unknown;
        try {
          parsedRoot = JSON.parse(rawIndex);
        } catch {
          throw new Error('The source snapshot index is unreadable');
        }
        if (typeof parsedRoot !== 'object' || parsedRoot === null) {
          throw new Error('The source snapshot index is invalid');
        }
        const snapshotRoot = parsedRoot as Record<string, unknown>;
        if (
          snapshotRoot['version'] !== SNAPSHOT_INDEX_VERSION ||
          !Array.isArray(snapshotRoot['snapshots'])
        ) {
          throw new Error('The source snapshot index has an unsupported schema');
        }
        const index = parseSnapshotIndex(rawIndex);
        snapshotIndex = serializeSnapshotIndex(index);
        await mkdir(paths.snapshots, { recursive: true });
        await writeFileAtomic(join(paths.snapshots, 'index.json'), snapshotIndex);
        for (const meta of index.snapshots) {
          const content = await readFile(join(source.snapshots, snapshotFileName(meta)), 'utf8');
          validateSnapshot(meta, content);
          snapshots.set(snapshotFileName(meta), content);
          await writeFileAtomic(join(paths.snapshots, snapshotFileName(meta)), content);
        }
      }
    }

    const revisionSnapshotId = expectedAppData.revision.snapshotId;
    if (
      revisionSnapshotId !== null &&
      ![...snapshots.keys()].some((name) => name.endsWith(`-${revisionSnapshotId}.fountain`))
    ) {
      throw new Error(
        'The production revision references a snapshot absent from the source bundle',
      );
    }

    return { root, paths, bible, bibleImages, snapshots, snapshotIndex };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function validatePublishedBundle(
  request: SaveAsBundleRequest,
  prepared: PreparedBundle,
): Promise<void> {
  const target = documentBundlePaths(request.destinationPath);
  const raw = await readFile(target.document, 'utf8');
  if (raw !== fromLf(request.content, request.eol))
    throw new Error('Saved Fountain validation failed');

  const appData = parseAppData(await readFile(target.appData, 'utf8'));
  if (JSON.stringify(appData) !== JSON.stringify(parseAppData(serializeAppData(request.appData)))) {
    throw new Error('Saved appdata validation failed');
  }

  if (prepared.bible !== null) {
    const savedBible = serializeBible(parseBible(await readFile(target.bible, 'utf8')));
    if (savedBible !== prepared.bible) throw new Error('Saved Bible validation failed');
    for (const [name, expected] of prepared.bibleImages) {
      const actual = await readFile(join(target.bibleImages, name));
      if (!actual.equals(expected)) throw new Error(`Saved Bible image validation failed: ${name}`);
    }
  } else if ((await exists(target.bible)) || (await exists(target.bibleImages))) {
    throw new Error('Obsolete destination Bible data survived Save As');
  }

  if (prepared.snapshotIndex !== null) {
    const savedIndex = serializeSnapshotIndex(
      parseSnapshotIndex(await readFile(join(target.snapshots, 'index.json'), 'utf8')),
    );
    if (savedIndex !== prepared.snapshotIndex)
      throw new Error('Saved snapshot index validation failed');
    for (const [name, expected] of prepared.snapshots) {
      if ((await readFile(join(target.snapshots, name), 'utf8')) !== expected) {
        throw new Error(`Saved snapshot validation failed: ${name}`);
      }
    }
  } else if (await exists(target.snapshots)) {
    throw new Error('Obsolete destination snapshots survived Save As');
  }
}

async function publishBundle(
  request: SaveAsBundleRequest,
  prepared: PreparedBundle,
  observe: SaveAsTransactionObserver,
): Promise<number> {
  const target = documentBundlePaths(request.destinationPath);
  const backup = join(prepared.root, 'previous');
  await mkdir(backup);
  const components: Component[] = (Object.keys(target) as Array<keyof DocumentBundlePaths>).map(
    (key) => ({ key, target: target[key], prepared: prepared.paths[key] }),
  );
  const movedAside: Component[] = [];
  const published: Component[] = [];

  try {
    for (const component of components) {
      if (!(await exists(component.target))) continue;
      await rename(component.target, join(backup, component.key));
      movedAside.push(component);
    }
    await observe('destination-backed-up');
    for (const component of components) {
      if (!(await exists(component.prepared))) continue;
      await rename(component.prepared, component.target);
      published.push(component);
    }
    await observe('published');
    await validatePublishedBundle(request, prepared);
    await observe('validated');
    const result = await stat(target.document);
    // B is now complete and validated. Cleanup is intentionally post-commit: if removing the
    // private backup directory fails halfway, attempting rollback could destroy the valid B
    // after some of its previous components have already been deleted.
    await rm(prepared.root, { recursive: true, force: true }).catch(() => undefined);
    return result.mtimeMs;
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const component of [...published].reverse()) {
      await rm(component.target, { recursive: true, force: true }).catch((failure) =>
        rollbackFailures.push(failure),
      );
    }
    for (const component of [...movedAside].reverse()) {
      await rename(join(backup, component.key), component.target).catch((failure) =>
        rollbackFailures.push(failure),
      );
    }
    await rm(prepared.root, { recursive: true, force: true }).catch((failure) =>
      rollbackFailures.push(failure),
    );
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        'Save As failed and rollback was incomplete',
        { cause: error },
      );
    }
    throw error;
  }
}

/** Duplicates the complete logical project bundle and leaves the source untouched. */
export async function saveAsDocumentBundle(
  request: SaveAsBundleRequest,
  backupCount: number,
  observe: SaveAsTransactionObserver = () => undefined,
): Promise<SaveOutcome> {
  const releaseTransition =
    request.sourcePath !== null &&
    comparable(request.sourcePath) !== comparable(request.destinationPath)
      ? beginBundleTransition([request.sourcePath, request.destinationPath])
      : () => undefined;
  try {
    if (
      request.sourcePath !== null &&
      (await sameDocumentPath(request.sourcePath, request.destinationPath))
    ) {
      return saveDocument(
        {
          path: request.sourcePath,
          content: request.content,
          eol: request.eol,
          expectedMtimeMs: request.expectedMtimeMs,
          expectedHash: request.expectedHash,
        },
        backupCount,
      );
    }
    if (request.sourcePath !== null) {
      await assertNamespacesDoNotOverlap(request.sourcePath, request.destinationPath);
    }

    const mtimeMs = await withBundleMutation(async () => {
      const prepared = await prepareBundle(request);
      await observe('prepared');
      return publishBundle(request, prepared, observe);
    });
    // The published screenplay bytes are exactly fromLf(content, eol): they become
    // the new filesystem base for the next save, without re-reading the disk.
    const publishedHash = sha256Hex(Buffer.from(fromLf(request.content, request.eol), 'utf8'));
    return { status: 'saved', path: request.destinationPath, mtimeMs, hash: publishedHash };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    releaseTransition();
  }
}
