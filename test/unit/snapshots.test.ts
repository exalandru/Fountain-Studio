import { mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotMeta } from '../../src/shared/snapshots/index.js';
import {
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  readSnapshot,
  renameSnapshot,
} from '../../src/main/files/snapshots.js';
import {
  MAX_SNAPSHOTS,
  parseSnapshotIndex,
  sanitizeSnapshotName,
  serializeSnapshotIndex,
  snapshotDirectory,
  snapshotFileName,
  snapshotSlug,
  snapshotStamp,
} from '../../src/shared/snapshots/index.js';

function meta(overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    id: 'snap-1',
    name: 'Avant l’acte III',
    createdAt: 1_770_000_000_000,
    byteLength: 1_024,
    lineCount: 42,
    sceneCount: 3,
    ...overrides,
  };
}

describe('snapshot naming is a containment boundary', () => {
  // A snapshot name is free text typed into a dialog that ends up inside a path. These are
  // the cases that must never produce a separator, a parent reference or a leading dot.
  const hostile = [
    '../../../etc/passwd',
    '..',
    '.',
    '....//....//evasion',
    '/absolute/path',
    'C:\\Windows\\System32',
    'nom\\avec\\antislash',
    'nom/avec/slash',
    '.hidden',
    'espaces   partout',
    'accentué — ponctué !',
    'nul\u0000byte',
  ];

  it.each(hostile)('contains %j', (name) => {
    const slug = snapshotSlug(name);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('\\');
    expect(slug).not.toContain('..');
    expect(slug.startsWith('-')).toBe(false);
    expect(slug.startsWith('.')).toBe(false);
  });

  it('never yields an empty slug, whatever it is handed', () => {
    for (const name of ['', '   ', '...', '///', '???', '\u0000']) {
      expect(snapshotSlug(name).length).toBeGreaterThan(0);
    }
  });

  it('keeps the whole file name free of any path separator', () => {
    const name = snapshotFileName(meta({ name: '../../evasion', id: 'snap-abc' }));
    expect(name).not.toMatch(/[/\\]/);
    expect(name).toMatch(/\.fountain$/);
    // The id stays the authority on identity; the slug only makes the directory readable.
    expect(name).toContain('snap-abc');
  });

  it('folds accents and collapses runs rather than dropping the name', () => {
    expect(snapshotSlug('Avant l’acte III')).toBe('avant-l-acte-iii');
    expect(snapshotSlug('Réécriture — séquence 12')).toBe('reecriture-sequence-12');
  });

  it('bounds the slug length', () => {
    expect(snapshotSlug('a'.repeat(500)).length).toBeLessThanOrEqual(48);
  });
});

describe('snapshot names and stamps', () => {
  it('falls back when the name is unusable, and bounds a long one', () => {
    expect(sanitizeSnapshotName(undefined, 'Défaut')).toBe('Défaut');
    expect(sanitizeSnapshotName('   ', 'Défaut')).toBe('Défaut');
    expect(sanitizeSnapshotName(42, 'Défaut')).toBe('Défaut');
    expect(sanitizeSnapshotName('  deux   espaces  ', 'Défaut')).toBe('deux espaces');
    expect(sanitizeSnapshotName('x'.repeat(400), 'Défaut')).toHaveLength(120);
  });

  it('stamps in a form that sorts naturally', () => {
    const earlier = snapshotStamp(new Date(2026, 6, 30, 19, 12).getTime());
    const later = snapshotStamp(new Date(2026, 6, 31, 8, 40).getTime());
    expect(earlier).toBe('20260730-1912');
    expect(later).toBe('20260731-0840');
    expect(earlier < later).toBe(true);
  });

  it('derives the sidecar directory from the screenplay path', () => {
    expect(snapshotDirectory('/films/story.fountain')).toBe('/films/story.fountain.snapshots');
  });
});

describe('snapshot index', () => {
  it('round-trips', () => {
    const index = { version: 1 as const, snapshots: [meta()] };
    expect(parseSnapshotIndex(serializeSnapshotIndex(index))).toEqual(index);
  });

  it('returns an empty list rather than throwing on anything unusable', () => {
    // A corrupt index must never cost the author their snapshot *files*: the worst outcome
    // is an empty list beside intact .fountain files they can reopen by hand.
    for (const raw of ['', 'not json', 'null', '[]', '{}', '{"version":2,"snapshots":[]}']) {
      expect(parseSnapshotIndex(raw)).toEqual({ version: 1, snapshots: [] });
    }
  });

  it('drops malformed entries and keeps the sound ones', () => {
    const parsed = parseSnapshotIndex(
      JSON.stringify({
        version: 1,
        snapshots: [
          meta({ id: 'good-1' }),
          { id: 'no timestamp' },
          { id: 'spaces not allowed', createdAt: 1 },
          { createdAt: 1_770_000_000_000 },
          meta({ id: 'good-2', createdAt: 1_770_000_100_000 }),
        ],
      }),
    );
    expect(parsed.snapshots.map((snapshot) => snapshot.id)).toEqual(['good-2', 'good-1']);
  });

  it('rejects a duplicated id, keeping the first', () => {
    const parsed = parseSnapshotIndex(
      JSON.stringify({
        version: 1,
        snapshots: [meta({ id: 'same', name: 'Premier' }), meta({ id: 'same', name: 'Second' })],
      }),
    );
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0]?.name).toBe('Premier');
  });

  it('orders newest first and bounds the list', () => {
    const many = Array.from({ length: MAX_SNAPSHOTS + 20 }, (_, i) =>
      meta({ id: `snap-${i}`, createdAt: 1_770_000_000_000 + i * 1_000 }),
    );
    const parsed = parseSnapshotIndex(JSON.stringify({ version: 1, snapshots: many }));
    expect(parsed.snapshots).toHaveLength(MAX_SNAPSHOTS);
    const timestamps = parsed.snapshots.map((snapshot) => snapshot.createdAt);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it('repairs numeric fields instead of discarding the entry', () => {
    const parsed = parseSnapshotIndex(
      JSON.stringify({
        version: 1,
        snapshots: [
          {
            id: 'snap-1',
            name: 'Avec des nombres douteux',
            createdAt: 1_770_000_000_000,
            byteLength: -5,
            lineCount: Number.NaN,
            sceneCount: 3.7,
          },
        ],
      }),
    );
    expect(parsed.snapshots[0]).toMatchObject({ byteLength: 0, lineCount: 0, sceneCount: 3 });
  });
});

/**
 * The sidecar on disk.
 *
 * These cover the guarantees the interface cannot show: that two snapshots taken in quick
 * succession do not lose each other in the index, that two screenplays in the same folder
 * keep separate histories, and that the index never points at a file that is not there.
 */
describe('snapshot storage', () => {
  let directory: string;
  let screenplay: string;

  const SOURCE = 'INT. LABO - NUIT\n\nAlice attend.\n';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quantum-snapshots-'));
    screenplay = join(directory, 'story.fountain');
    await writeFile(screenplay, SOURCE, 'utf8');
  });

  it('writes a readable screenplay and records metadata for the list', async () => {
    const list = await createSnapshot(screenplay, 'avant acte III', SOURCE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'avant acte III', sceneCount: 1, lineCount: 4 });

    const entries = await readdir(snapshotDirectory(screenplay));
    expect(entries).toContain('index.json');
    const file = entries.find((entry) => entry.endsWith('.fountain')) ?? '';
    expect(file).toContain('avant-acte-iii');
    // The whole point of the sidecar: recoverable by hand, without the application.
    expect(await readFile(join(snapshotDirectory(screenplay), file), 'utf8')).toBe(SOURCE);
    expect(await readSnapshot(screenplay, list[0]?.id ?? '')).toBe(SOURCE);
  });

  it('does not lose either of two snapshots taken at the same moment', async () => {
    // Both calls read the index before either writes it; without serialisation the second
    // write would overwrite the first entry and one version would vanish silently.
    await Promise.all([
      createSnapshot(screenplay, 'un', SOURCE),
      createSnapshot(screenplay, 'deux', `${SOURCE}\nEXT. RUE - JOUR\n`),
    ]);
    const list = await listSnapshots(screenplay);
    expect(list).toHaveLength(2);
    expect(list.map((meta) => meta.name).sort()).toEqual(['deux', 'un']);
    // And each entry still resolves to its own file.
    for (const meta of list) expect(await readSnapshot(screenplay, meta.id)).toContain('INT. LABO');
  });

  it('keeps two screenplays in one folder from mixing their histories', async () => {
    const other = join(directory, 'other.fountain');
    await writeFile(other, SOURCE, 'utf8');
    await createSnapshot(screenplay, 'story', SOURCE);
    await createSnapshot(other, 'other', SOURCE);

    expect((await listSnapshots(screenplay)).map((meta) => meta.name)).toEqual(['story']);
    expect((await listSnapshots(other)).map((meta) => meta.name)).toEqual(['other']);
    expect(snapshotDirectory(screenplay)).not.toBe(snapshotDirectory(other));
  });

  it('refuses past the limit rather than dropping the author’s oldest version', async () => {
    for (let index = 0; index < MAX_SNAPSHOTS; index++) {
      await createSnapshot(screenplay, `v${index}`, SOURCE);
    }
    await expect(createSnapshot(screenplay, 'one too many', SOURCE)).rejects.toThrow('limitReached');
    expect(await listSnapshots(screenplay)).toHaveLength(MAX_SNAPSHOTS);
  });

  it('moves the file when a snapshot is renamed, keeping its content', async () => {
    const [created] = await createSnapshot(screenplay, 'brouillon', SOURCE);
    const id = created?.id ?? '';
    const list = await renameSnapshot(screenplay, id, 'v2 producteur');
    expect(list[0]?.name).toBe('v2 producteur');

    const entries = (await readdir(snapshotDirectory(screenplay))).filter((entry) =>
      entry.endsWith('.fountain'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('v2-producteur');
    expect(await readSnapshot(screenplay, id)).toBe(SOURCE);
  });

  it('cannot be renamed out of its folder', async () => {
    const [created] = await createSnapshot(screenplay, 'sain', SOURCE);
    await renameSnapshot(screenplay, created?.id ?? '', '../../evasion');
    const beside = await readdir(directory);
    expect(beside.filter((entry) => entry.includes('evasion'))).toEqual([]);
    const entries = await readdir(snapshotDirectory(screenplay));
    expect(entries.some((entry) => entry.includes('..'))).toBe(false);
  });

  it('hides an index entry whose file has disappeared, and still lists the others', async () => {
    const [first] = await createSnapshot(screenplay, 'premier', SOURCE);
    await createSnapshot(screenplay, 'second', SOURCE);
    const meta = first as SnapshotMeta;
    await unlink(join(snapshotDirectory(screenplay), snapshotFileName(meta)));

    const list = await listSnapshots(screenplay);
    expect(list.map((entry) => entry.name)).toEqual(['second']);
    await expect(readSnapshot(screenplay, meta.id)).rejects.toThrow('notFound');
  });

  it('removes both the file and the entry on delete, and reports an unknown id', async () => {
    const [created] = await createSnapshot(screenplay, 'jetable', SOURCE);
    expect(await deleteSnapshot(screenplay, created?.id ?? '')).toEqual([]);
    expect(
      (await readdir(snapshotDirectory(screenplay))).filter((entry) => entry.endsWith('.fountain')),
    ).toEqual([]);
    await expect(readSnapshot(screenplay, 'snap-unknown')).rejects.toThrow('notFound');
    await expect(renameSnapshot(screenplay, 'snap-unknown', 'x')).rejects.toThrow('notFound');
  });

  it('lists nothing, without failing, when the index is corrupt', async () => {
    await createSnapshot(screenplay, 'intact', SOURCE);
    await writeFile(join(snapshotDirectory(screenplay), 'index.json'), '{ not json', 'utf8');
    expect(await listSnapshots(screenplay)).toEqual([]);
    // The version itself is still on disk, which is the point of the sidecar.
    expect(
      (await readdir(snapshotDirectory(screenplay))).filter((entry) => entry.endsWith('.fountain')),
    ).toHaveLength(1);
  });
});
