/**
 * Document filesystem operations that enforce M4 grants before touching sidecars.
 *
 * IPC handlers must call these (or assertDocumentGranted themselves) so the gate and
 * the discriminating tests share one implementation — deleting the assert fails both.
 */

import type { AppData } from '@shared/appdata/index.js';
import type { Bible } from '@shared/bible/index.js';
import type { SnapshotCatalog } from '@shared/snapshots/index.js';
import { readAppData, writeAppData } from './appdata.js';
import { assertDocumentGranted } from './document-grants.js';
import {
  deleteBibleImage,
  readBible,
  readBibleImage,
  writeBible,
  writeBibleImage,
} from './bible.js';
import {
  createSnapshot,
  deleteSnapshot,
  inspectSnapshotCatalog,
  readSnapshot,
  renameSnapshot,
  repairSnapshotIndex,
} from './snapshots.js';
import type { SnapshotMeta } from '@shared/snapshots/index.js';

export async function grantedAppDataRead(path: string): Promise<AppData | null> {
  assertDocumentGranted(path);
  return readAppData(path);
}

export async function grantedAppDataWrite(path: string, data: AppData): Promise<void> {
  assertDocumentGranted(path);
  await writeAppData(path, data);
}

export async function grantedBibleRead(path: string): Promise<Bible> {
  assertDocumentGranted(path);
  return readBible(path);
}

export async function grantedBibleWrite(path: string, bible: Bible): Promise<Bible> {
  assertDocumentGranted(path);
  return writeBible(path, bible);
}

export async function grantedBibleImageRead(path: string, id: string): Promise<string | null> {
  assertDocumentGranted(path);
  return readBibleImage(path, id);
}

export async function grantedBibleImageWrite(
  path: string,
  id: string,
  dataUri: string,
): Promise<string> {
  assertDocumentGranted(path);
  return writeBibleImage(path, id, dataUri);
}

export async function grantedBibleImageDelete(path: string, id: string): Promise<void> {
  assertDocumentGranted(path);
  await deleteBibleImage(path, id);
}

export async function grantedSnapshotList(path: string): Promise<SnapshotCatalog> {
  assertDocumentGranted(path);
  return inspectSnapshotCatalog(path);
}

export async function grantedSnapshotRepair(path: string): Promise<SnapshotCatalog> {
  assertDocumentGranted(path);
  return repairSnapshotIndex(path);
}

export async function grantedSnapshotCreate(
  path: string,
  name: string,
  content: string,
): Promise<SnapshotMeta[]> {
  assertDocumentGranted(path);
  return createSnapshot(path, name, content);
}

export async function grantedSnapshotRead(path: string, id: string): Promise<string> {
  assertDocumentGranted(path);
  return readSnapshot(path, id);
}

export async function grantedSnapshotRename(
  path: string,
  id: string,
  name: string,
): Promise<SnapshotMeta[]> {
  assertDocumentGranted(path);
  return renameSnapshot(path, id, name);
}

export async function grantedSnapshotDelete(path: string, id: string): Promise<SnapshotMeta[]> {
  assertDocumentGranted(path);
  return deleteSnapshot(path, id);
}
