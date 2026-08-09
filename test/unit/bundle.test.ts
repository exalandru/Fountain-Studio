import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultAppData } from '../../src/shared/appdata/index.js';
import { bibleImageName, createBible } from '../../src/shared/bible/index.js';
import type { SaveAsBundleRequest } from '../../src/shared/ipc-contract.js';
import { readAppData, writeAppData } from '../../src/main/files/appdata.js';
import {
  bibleImagesDirectory,
  biblePath,
  readBible,
  writeBible,
  writeBibleImage,
} from '../../src/main/files/bible.js';
import {
  documentBundlePaths,
  saveAsDocumentBundle,
  type SaveAsTransactionStep,
} from '../../src/main/files/bundle.js';
import { createSnapshot, listSnapshots, readSnapshot } from '../../src/main/files/snapshots.js';
import { snapshotDirectory } from '../../src/shared/snapshots/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fountain-save-as-bundle-'));
  roots.push(root);
  const source = join(root, 'A.fountain');
  const destination = join(root, 'B.fountain');
  await writeFile(source, 'INT. A - DAY\n\nOriginal.\n', 'utf8');
  return { destination, root, source };
}

async function request(
  sourcePath: string | null,
  destinationPath: string,
  content: string,
): Promise<SaveAsBundleRequest> {
  return {
    sourcePath,
    destinationPath,
    content,
    eol: 'lf',
    expectedMtimeMs: sourcePath ? (await stat(sourcePath)).mtimeMs : null,
    appData: createDefaultAppData(),
  };
}

async function populateBundle(path: string, label: string) {
  const content = `INT. ${label} - DAY\n\n${label} content.\n`;
  await writeFile(path, content, 'utf8');
  const snapshots = await createSnapshot(path, `${label} locked`, content);
  const snapshot = snapshots[0];
  if (!snapshot) throw new Error('Missing snapshot fixture');

  const appData = createDefaultAppData();
  appData.sidebar.filter = `${label} filter`;
  appData.revision = { snapshotId: snapshot.id, lockedAt: snapshot.createdAt, colour: 'blue' };
  await writeAppData(path, appData);

  const bibleId = `bib-${label.toLowerCase()}`;
  const image = bibleImageName(bibleId);
  await writeBible(path, {
    version: 1,
    entries: [
      {
        id: bibleId,
        kind: 'character',
        name: label,
        aliases: [],
        image,
        fields: { role: `${label} role` },
        draftedAt: null,
        updatedAt: 1,
      },
    ],
  });
  await writeBibleImage(path, bibleId, 'data:image/webp;base64,UklGRg==');
  return { appData, bibleId, content, snapshot };
}

describe('document bundle Save As', () => {
  it('derives every project-owned path from the Fountain path', () => {
    expect(documentBundlePaths('/films/A.fountain')).toEqual({
      document: '/films/A.fountain',
      appData: '/films/A.fountain.appdata.json',
      bible: '/films/A.fountain.bible.json',
      bibleImages: '/films/A.fountain.bible.images',
      snapshots: '/films/A.fountain.snapshots',
    });
  });

  it('duplicates Fountain, appdata, Bible images and revision snapshots without changing A', async () => {
    const { destination, source } = await fixture();
    const original = await populateBundle(source, 'ALICE');
    const saveRequest = await request(source, destination, `${original.content}Revised.\n`);
    saveRequest.appData = original.appData;

    const outcome = await saveAsDocumentBundle(saveRequest, 3);

    expect(outcome.status).toBe('saved');
    expect(await readFile(destination, 'utf8')).toBe(`${original.content}Revised.\n`);
    expect(await readFile(source, 'utf8')).toBe(original.content);
    expect(await readAppData(destination)).toEqual(original.appData);
    expect(await readBible(destination)).toEqual(await readBible(source));
    expect(
      await readFile(join(bibleImagesDirectory(destination), bibleImageName(original.bibleId))),
    ).toEqual(await readFile(join(bibleImagesDirectory(source), bibleImageName(original.bibleId))));
    expect((await listSnapshots(destination)).map((entry) => entry.id)).toEqual([
      original.snapshot.id,
    ]);
    expect(await readSnapshot(destination, original.snapshot.id)).toBe(original.content);
  });

  it('replaces every known destination sidecar instead of mixing old B data into A', async () => {
    const { destination, source } = await fixture();
    const original = await populateBundle(source, 'ALICE');
    const obsolete = await populateBundle(destination, 'BOB');
    const saveRequest = await request(source, destination, original.content);
    saveRequest.appData = original.appData;

    await expect(saveAsDocumentBundle(saveRequest, 3)).resolves.toMatchObject({ status: 'saved' });

    expect(await readAppData(destination)).toEqual(original.appData);
    expect(await readBible(destination)).toEqual(await readBible(source));
    expect((await listSnapshots(destination)).map((entry) => entry.id)).toEqual([
      original.snapshot.id,
    ]);
    expect((await listSnapshots(destination)).map((entry) => entry.id)).not.toContain(
      obsolete.snapshot.id,
    );
  });

  it.each<SaveAsTransactionStep>(['destination-backed-up', 'published', 'validated'])(
    'rolls an existing destination bundle back when %s fails',
    async (failedStep) => {
      const { destination, source } = await fixture();
      const original = await populateBundle(source, 'ALICE');
      const destinationBefore = await populateBundle(destination, 'BOB');
      const destinationBibleBefore = await readBible(destination);
      const saveRequest = await request(source, destination, original.content);
      saveRequest.appData = original.appData;

      const outcome = await saveAsDocumentBundle(saveRequest, 3, (step) => {
        if (step === failedStep) throw new Error(`injected ${failedStep} failure`);
      });

      expect(outcome).toMatchObject({ status: 'error' });
      expect(await readFile(destination, 'utf8')).toBe(destinationBefore.content);
      expect(await readAppData(destination)).toEqual(destinationBefore.appData);
      expect(await readBible(destination)).toEqual(destinationBibleBefore);
      expect((await listSnapshots(destination)).map((entry) => entry.id)).toEqual([
        destinationBefore.snapshot.id,
      ]);
      expect(await readFile(source, 'utf8')).toBe(original.content);
    },
  );

  it('treats Save As to the same path as a normal save without duplicating sidecars', async () => {
    const { source } = await fixture();
    const original = await populateBundle(source, 'ALICE');
    const bibleBefore = await readFile(biblePath(source), 'utf8');
    const snapshotsBefore = await readFile(join(snapshotDirectory(source), 'index.json'), 'utf8');
    const saveRequest = await request(source, source, `${original.content}Same path edit.\n`);
    saveRequest.appData = original.appData;

    await expect(saveAsDocumentBundle(saveRequest, 3)).resolves.toMatchObject({ status: 'saved' });

    expect(await readFile(source, 'utf8')).toBe(`${original.content}Same path edit.\n`);
    expect(await readFile(biblePath(source), 'utf8')).toBe(bibleBefore);
    expect(await readFile(join(snapshotDirectory(source), 'index.json'), 'utf8')).toBe(
      snapshotsBefore,
    );
  });

  it('removes obsolete optional B sidecars when A has none', async () => {
    const { destination, source } = await fixture();
    await populateBundle(destination, 'BOB');
    const saveRequest = await request(source, destination, 'INT. CLEAN - DAY\n');

    await expect(saveAsDocumentBundle(saveRequest, 3)).resolves.toMatchObject({ status: 'saved' });

    await expect(readFile(biblePath(destination), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(snapshotDirectory(destination), 'index.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readBible(destination)).toEqual(createBible());
  });

  it('rejects sidecar and snapshot mutations that start during the identity transition', async () => {
    const { destination, source } = await fixture();
    const original = await populateBundle(source, 'ALICE');
    const saveRequest = await request(source, destination, original.content);
    saveRequest.appData = original.appData;
    let releasePrepared!: () => void;
    const preparedBlocked = new Promise<void>((resolve) => {
      releasePrepared = resolve;
    });
    let announcePrepared!: () => void;
    const prepared = new Promise<void>((resolve) => {
      announcePrepared = resolve;
    });

    const saving = saveAsDocumentBundle(saveRequest, 3, async (step) => {
      if (step !== 'prepared') return;
      announcePrepared();
      await preparedBlocked;
    });
    await prepared;

    const changedAppData = createDefaultAppData();
    changedAppData.sidebar.filter = 'late A write';
    await expect(writeAppData(source, changedAppData)).rejects.toThrow('project path is changing');
    await expect(writeBible(source, createBible())).rejects.toThrow('project path is changing');
    await expect(createSnapshot(source, 'late snapshot', original.content)).rejects.toThrow(
      'project path is changing',
    );

    releasePrepared();
    await expect(saving).resolves.toMatchObject({ status: 'saved' });
    expect(await readAppData(source)).toEqual(original.appData);
    expect(await readBible(source)).not.toEqual(createBible());
    expect((await listSnapshots(source)).map((entry) => entry.id)).toEqual([original.snapshot.id]);
    expect((await listSnapshots(destination)).map((entry) => entry.id)).toEqual([
      original.snapshot.id,
    ]);
  });
});
