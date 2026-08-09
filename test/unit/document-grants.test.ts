import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBible } from '../../src/shared/bible/index.js';
import { createDefaultAppData } from '../../src/shared/appdata/index.js';
import { companionPath, readAppData } from '../../src/main/files/appdata.js';
import { biblePath, readBible } from '../../src/main/files/bible.js';
import {
  assertDocumentGranted,
  DocumentGrantError,
  grantDocumentPath,
  isDocumentGranted,
  resetDocumentGrants,
  revokeDocumentPath,
  setDocumentGrantPlatform,
  transferDocumentGrant,
} from '../../src/main/files/document-grants.js';
import {
  grantedAppDataWrite,
  grantedBibleWrite,
  grantedSnapshotRepair,
} from '../../src/main/files/document-ops.js';
import { createSnapshot, inspectSnapshotCatalog } from '../../src/main/files/snapshots.js';
import { snapshotDirectory } from '../../src/shared/snapshots/index.js';

/**
 * M4 filesystem boundary — tests the same granted* helpers the IPC handlers call.
 */

describe('document grants (M4)', () => {
  afterEach(() => {
    resetDocumentGrants();
    setDocumentGrantPlatform('darwin');
  });

  it('refuses ungranted absolute paths', () => {
    expect(() => assertDocumentGranted('/tmp/never-opened.fountain')).toThrow(DocumentGrantError);
  });

  it('treats macOS paths as case-insensitive', () => {
    setDocumentGrantPlatform('darwin');
    grantDocumentPath('/tmp/Story.fountain');
    expect(isDocumentGranted('/tmp/story.fountain')).toBe(true);
  });

  it('transfers authority on Save As A → B', () => {
    grantDocumentPath('/docs/a.fountain');
    transferDocumentGrant('/docs/a.fountain', '/docs/b.fountain');
    expect(isDocumentGranted('/docs/a.fountain')).toBe(false);
    expect(isDocumentGranted('/docs/b.fountain')).toBe(true);
  });

  it('revokes authority on close', () => {
    grantDocumentPath('/docs/a.fountain');
    revokeDocumentPath('/docs/a.fountain');
    expect(() => assertDocumentGranted('/docs/a.fountain')).toThrow(DocumentGrantError);
  });
});

describe('sidecar IPC boundary (M4 granted* helpers)', () => {
  let root: string;
  let granted: string;
  let foreign: string;

  beforeEach(async () => {
    resetDocumentGrants();
    root = await mkdtemp(join(tmpdir(), 'm4-fs-'));
    granted = join(root, 'granted.fountain');
    foreign = join(root, 'foreign.fountain');
    await writeFile(granted, 'INT. A - DAY\n\nHello.\n', 'utf8');
    await writeFile(foreign, 'INT. B - DAY\n\nNope.\n', 'utf8');
    grantDocumentPath(granted);
  });

  afterEach(() => {
    resetDocumentGrants();
  });

  it('A — refuses bible/appdata write on an ungranted path', async () => {
    await expect(grantedBibleWrite(foreign, createBible())).rejects.toThrow(DocumentGrantError);
    await expect(grantedAppDataWrite(foreign, createDefaultAppData())).rejects.toThrow(
      DocumentGrantError,
    );
    await expect(readFile(biblePath(foreign), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(companionPath(foreign), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('B — allows the same operations on the granted document', async () => {
    const bible = {
      ...createBible(),
      entries: [
        {
          id: 'bib-alice',
          kind: 'character' as const,
          name: 'Alice',
          aliases: [],
          image: null,
          fields: { role: 'hero' },
          draftedAt: null,
          updatedAt: 1,
        },
      ],
    };
    await grantedBibleWrite(granted, bible);
    await grantedAppDataWrite(granted, createDefaultAppData());
    expect((await readBible(granted)).entries[0]?.fields['role']).toBe('hero');
    expect(await readAppData(granted)).not.toBeNull();
  });

  it('C — after Save As transfer, stale A cannot mutate B sidecars', async () => {
    const destination = join(root, 'after-save-as.fountain');
    await writeFile(destination, 'INT. C - DAY\n\nMoved.\n', 'utf8');
    transferDocumentGrant(granted, destination);

    await expect(grantedBibleWrite(granted, createBible())).rejects.toThrow(DocumentGrantError);
    await grantedBibleWrite(destination, createBible());
    expect(await readFile(biblePath(destination), 'utf8')).toContain('"version"');
  });

  it('D — two grants are not interchangeable', async () => {
    const other = join(root, 'other.fountain');
    await writeFile(other, 'INT. D - DAY\n\nOther.\n', 'utf8');
    grantDocumentPath(other);

    await grantedBibleWrite(granted, createBible());
    await grantedBibleWrite(other, createBible());

    revokeDocumentPath(granted);
    await expect(grantedBibleWrite(granted, createBible())).rejects.toThrow(DocumentGrantError);
    await grantedBibleWrite(other, createBible());
  });

  it('E — closed/revoked capability cannot write again', async () => {
    revokeDocumentPath(granted);
    await expect(grantedAppDataWrite(granted, createDefaultAppData())).rejects.toThrow(
      DocumentGrantError,
    );
  });

  it('F — snapshot repair refuses an ungranted screenplay path', async () => {
    await createSnapshot(foreign, 'keep', 'INT. B - DAY\n\nNope.\n');
    await writeFile(join(snapshotDirectory(foreign), 'index.json'), '{ broken', 'utf8');

    await expect(grantedSnapshotRepair(foreign)).rejects.toThrow(DocumentGrantError);
    const catalog = await inspectSnapshotCatalog(foreign);
    expect(catalog.status).toBe('repairable');
  });

  it('F — snapshot repair succeeds for the granted document', async () => {
    await createSnapshot(granted, 'keep', 'INT. A - DAY\n\nHello.\n');
    await writeFile(join(snapshotDirectory(granted), 'index.json'), '{ broken', 'utf8');
    const repaired = await grantedSnapshotRepair(granted);
    expect(repaired.status).toBe('ok');
    expect(repaired.snapshots.length).toBe(1);
  });
});
