import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultAppData } from '../../src/shared/appdata/index.js';
import type { PdfExportOptions, SaveAsBundleRequest } from '../../src/shared/ipc-contract.js';
import {
  parseSnapshotFileName,
  snapshotDirectory,
  snapshotFileName,
} from '../../src/shared/snapshots/index.js';
import { saveAsDocumentBundle } from '../../src/main/files/bundle.js';
import { grantDocumentPath, resetDocumentGrants } from '../../src/main/files/document-grants.js';
import {
  createSnapshot,
  inspectSnapshotCatalog,
  listSnapshots,
  readSnapshot,
  repairSnapshotIndex,
} from '../../src/main/files/snapshots.js';
import { validatePdfRevisionBaseline } from '../../src/main/pdf/baseline.js';

/**
 * M3 — damaged snapshot indexes must not silently hide intact `.fountain` files,
 * and repair must only rebuild demonstrable identity from filenames + file bytes.
 */

const ordinaryPdf: PdfExportOptions = {
  format: 'a4',
  sceneNumbers: 'both',
  includeNotes: false,
  includeSynopses: false,
  headingsBold: true,
  watermark: '',
  pageFrom: null,
  pageTo: null,
  revision: null,
};

describe('parseSnapshotFileName', () => {
  it('round-trips through snapshotFileName for a real create()', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'snap-parse-'));
    const screenplay = join(directory, 'story.fountain');
    await writeFile(screenplay, 'INT. A - DAY\n\nHi.\n', 'utf8');
    const [meta] = await createSnapshot(screenplay, 'avant acte III', 'INT. A - DAY\n\nHi.\n');
    const fileName = snapshotFileName(meta!);
    const parsed = parseSnapshotFileName(fileName);
    expect(parsed).toMatchObject({ id: meta!.id });
    expect(snapshotFileName({ ...parsed!, byteLength: 0, lineCount: 0, sceneCount: 0 })).toBe(
      fileName,
    );
  });

  it('rejects unknown orphans that do not encode a snap- id', () => {
    expect(parseSnapshotFileName('notes.fountain')).toBeNull();
    expect(parseSnapshotFileName('20260101-1200-hello.fountain')).toBeNull();
  });
});

describe('snapshot catalog diagnose + repair (M3)', () => {
  let directory: string;
  let screenplay: string;
  const SOURCE = 'INT. LAB - NIGHT\n\nAlice waits.\n';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'snap-m3-'));
    screenplay = join(directory, 'story.fountain');
    await writeFile(screenplay, SOURCE, 'utf8');
    grantDocumentPath(screenplay);
  });

  afterEach(() => {
    resetDocumentGrants();
  });

  it('distinguishes a healthy empty history from a corrupt index', async () => {
    expect(await inspectSnapshotCatalog(screenplay)).toEqual({
      status: 'ok',
      snapshots: [],
      issues: [],
    });

    const [meta] = await createSnapshot(screenplay, 'keep', SOURCE);
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), '{ not json', 'utf8');

    const catalog = await inspectSnapshotCatalog(screenplay);
    expect(catalog.status).toBe('repairable');
    expect(catalog.snapshots.map((entry) => entry.id)).toEqual([meta!.id]);
    expect(catalog.issues.some((issue) => issue.code === 'indexUnreadable')).toBe(true);
    // Trusted list used by H1 stays empty until repair (fail-closed).
    expect(await listSnapshots(screenplay)).toEqual([]);
  });

  it('does not rewrite the index during diagnose', async () => {
    const [meta] = await createSnapshot(screenplay, 'keep', SOURCE);
    const damaged = '{ not json';
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), damaged, 'utf8');
    await inspectSnapshotCatalog(screenplay);
    expect(await readFile(join(snapshotDirectory(screenplay), 'index.json'), 'utf8')).toBe(damaged);
    expect(await readSnapshot(screenplay, meta!.id)).toBe(SOURCE);
  });

  it('repairs an unreadable index while preserving ids and leaving a damaged copy', async () => {
    const [first] = await createSnapshot(screenplay, 'one', SOURCE);
    const [second] = await createSnapshot(screenplay, 'two', `${SOURCE}\nEXT. STREET - DAY\n`);
    const ids = [second!.id, first!.id];

    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), '{ broken', 'utf8');
    const repaired = await repairSnapshotIndex(screenplay);

    expect(repaired.status).toBe('ok');
    expect(repaired.snapshots.map((entry) => entry.id).sort()).toEqual([...ids].sort());
    expect(await listSnapshots(screenplay)).toHaveLength(2);
    expect(await readFile(join(snapshotDirectory(screenplay), 'index.json.damaged'), 'utf8')).toBe(
      '{ broken',
    );
    expect(await readSnapshot(screenplay, first!.id)).toBe(SOURCE);
  });

  it('classifies a missing index beside intact files as repairable', async () => {
    const [meta] = await createSnapshot(screenplay, 'solo', SOURCE);
    const dir = snapshotDirectory(screenplay);
    await unlink(join(dir, 'index.json'));

    const catalog = await inspectSnapshotCatalog(screenplay);
    expect(catalog.status).toBe('repairable');
    expect(catalog.issues.some((issue) => issue.code === 'indexMissing')).toBe(true);
    expect(catalog.snapshots[0]?.id).toBe(meta!.id);
  });

  it('does not adopt an unparseable orphan during repair', async () => {
    await createSnapshot(screenplay, 'real', SOURCE);
    await writeFile(
      join(snapshotDirectory(screenplay), 'stray-notes.fountain'),
      'NOT A SNAP\n',
      'utf8',
    );
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), '{ broken', 'utf8');

    const repaired = await repairSnapshotIndex(screenplay);
    expect(repaired.status).toBe('ok');
    expect(repaired.snapshots).toHaveLength(1);
    const entries = await readdir(snapshotDirectory(screenplay));
    expect(entries).toContain('stray-notes.fountain');
  });

  it('reports metadata mismatch without auto-normalising on inspect', async () => {
    const [meta] = await createSnapshot(screenplay, 'meta', SOURCE);
    expect(meta).toBeDefined();
    const indexPath = join(snapshotDirectory(screenplay), 'index.json');
    const raw = JSON.parse(await readFile(indexPath, 'utf8')) as {
      version: 1;
      snapshots: Array<Record<string, unknown>>;
    };
    raw.snapshots[0] = { ...raw.snapshots[0], byteLength: 1, lineCount: 1, sceneCount: 99 };
    await writeFile(indexPath, JSON.stringify(raw), 'utf8');

    const catalog = await inspectSnapshotCatalog(screenplay);
    expect(catalog.status).toBe('ok');
    expect(catalog.issues.some((issue) => issue.code === 'metadataMismatch')).toBe(true);
    expect(catalog.snapshots[0]?.byteLength).toBe(1);
    expect(await readFile(indexPath, 'utf8')).toContain('"sceneCount":99');
  });

  it('keeps a production revision id through corrupt→repair', async () => {
    const [meta] = await createSnapshot(screenplay, 'lock', SOURCE);
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), 'null', 'utf8');

    const locked: PdfExportOptions = {
      ...ordinaryPdf,
      revision: {
        baseline: { path: screenplay, snapshotId: meta!.id, source: SOURCE },
        header: 'BLUE REVISION',
        colour: 'blue',
        colourMode: 'header',
        marks: true,
        lockedPages: true,
        onlyRevisedPages: false,
      },
    };

    await expect(validatePdfRevisionBaseline(locked)).rejects.toMatchObject({
      code: 'PDF_REVISION_BASELINE_UNAVAILABLE',
    });

    const repaired = await repairSnapshotIndex(screenplay);
    expect(repaired.snapshots.map((entry) => entry.id)).toEqual([meta!.id]);
    await expect(validatePdfRevisionBaseline(locked)).resolves.toBeUndefined();
  });

  it('refuses to invent an empty index when snapshot files are ambiguous', async () => {
    const [meta] = await createSnapshot(screenplay, 'keep', SOURCE);
    const damaged = '{ broken-atomic';
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), damaged, 'utf8');

    const fileName = snapshotFileName({
      id: meta!.id,
      name: 'dup',
      createdAt: meta!.createdAt + 60_000,
      byteLength: 1,
      lineCount: 1,
      sceneCount: 0,
    });
    await writeFile(join(snapshotDirectory(screenplay), fileName), 'INT. OTHER - DAY\n', 'utf8');

    await expect(repairSnapshotIndex(screenplay)).rejects.toMatchObject({ code: 'repairFailed' });
    expect(await readFile(join(snapshotDirectory(screenplay), 'index.json'), 'utf8')).toBe(damaged);
    const entries = await readdir(snapshotDirectory(screenplay));
    expect(entries).not.toContain('index.json.damaged');
    expect(entries.filter((name) => name.endsWith('.fountain')).length).toBeGreaterThanOrEqual(2);
  });

  it('does not overwrite an existing index.json.damaged on a second repair', async () => {
    await createSnapshot(screenplay, 'once', SOURCE);
    const firstDamage = '{ first-damage';
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), firstDamage, 'utf8');
    await repairSnapshotIndex(screenplay);
    expect(await readFile(join(snapshotDirectory(screenplay), 'index.json.damaged'), 'utf8')).toBe(
      firstDamage,
    );

    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), '{ second-damage', 'utf8');
    await repairSnapshotIndex(screenplay);
    expect(await readFile(join(snapshotDirectory(screenplay), 'index.json.damaged'), 'utf8')).toBe(
      firstDamage,
    );
  });

  it('refuses Save As while the source index is damaged, then allows it after repair', async () => {
    const [meta] = await createSnapshot(screenplay, 'bundle', SOURCE);
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), '{ broken', 'utf8');
    const destination = join(directory, 'copy.fountain');

    const damagedRequest: SaveAsBundleRequest = {
      sourcePath: screenplay,
      destinationPath: destination,
      content: SOURCE,
      eol: 'lf',
      expectedMtimeMs: null,
      appData: createDefaultAppData(),
    };
    await expect(saveAsDocumentBundle(damagedRequest, 3)).resolves.toMatchObject({
      status: 'error',
      message: expect.stringMatching(/damaged|repair/i),
    });

    await repairSnapshotIndex(screenplay);
    const outcome = await saveAsDocumentBundle(
      {
        ...damagedRequest,
        appData: createDefaultAppData(),
      },
      3,
    );
    expect(outcome.status).toBe('saved');
    expect((await listSnapshots(destination)).map((entry) => entry.id)).toEqual([meta!.id]);
  });
});
