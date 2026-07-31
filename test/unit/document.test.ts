import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectEol,
  fromLf,
  readDocument,
  saveDocument,
  toLf,
} from '../../src/main/files/document.js';

/**
 * The file layer is testable in plain Node: it imports nothing from Electron but types.
 * That is what makes it possible to cover the "no data loss" guarantee (§7) without
 * launching the application.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fountain-studio-doc-'));
});

describe('line-ending detection and restitution', () => {
  it('recognises LF', () => {
    expect(detectEol('a\nb\nc')).toBe('lf');
  });

  it('recognises CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('crlf');
  });

  it('picks the majority style in a mixed file', () => {
    expect(detectEol('a\r\nb\r\nc\nd')).toBe('crlf');
    expect(detectEol('a\nb\nc\nd\r\ne')).toBe('lf');
  });

  it('normalises then restores without loss', () => {
    const original = 'INT. A - JOUR\r\n\r\nElle entre.\r\n';
    expect(fromLf(toLf(original), 'crlf')).toBe(original);
  });
});

describe('readDocument', () => {
  it('reads content, line ending and mtime', async () => {
    const path = join(directory, 'a.fountain');
    await writeFile(path, 'INT. A - JOUR\r\n\r\nElle entre.\r\n', 'utf8');

    const snapshot = await readDocument(path);
    expect(snapshot.content).toBe('INT. A - JOUR\n\nElle entre.\n');
    expect(snapshot.eol).toBe('crlf');
    expect(snapshot.mtimeMs).toBeGreaterThan(0);
  });

  it('strips the UTF-8 BOM so it never reaches the parser', async () => {
    const path = join(directory, 'bom.fountain');
    await writeFile(path, '﻿INT. A - JOUR\n', 'utf8');

    const snapshot = await readDocument(path);
    expect(snapshot.content.startsWith('INT.')).toBe(true);
  });

  it('preserves accented characters', async () => {
    const path = join(directory, 'accents.fountain');
    await writeFile(path, 'EXT. CRÉPUSCULE - AUBE\n\nÉlodie s’éloigne.\n', 'utf8');

    const snapshot = await readDocument(path);
    expect(snapshot.content).toContain('Élodie s’éloigne.');
  });
});

describe('saveDocument — atomic write', () => {
  it('creates the file and returns the new mtime', async () => {
    const path = join(directory, 'neuf.fountain');
    const outcome = await saveDocument(
      { path, content: 'INT. A - JOUR\n', eol: 'lf', expectedMtimeMs: null },
      3,
    );

    expect(outcome.status).toBe('saved');
    expect(await readFile(path, 'utf8')).toBe('INT. A - JOUR\n');
  });

  it('restores the requested CRLF endings', async () => {
    const path = join(directory, 'crlf.fountain');
    await saveDocument({ path, content: 'a\nb\n', eol: 'crlf', expectedMtimeMs: null }, 0);
    expect(await readFile(path, 'utf8')).toBe('a\r\nb\r\n');
  });

  it('leaves no temporary file behind', async () => {
    const path = join(directory, 'propre.fountain');
    await saveDocument({ path, content: 'x\n', eol: 'lf', expectedMtimeMs: null }, 0);

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to overwrite a file changed outside the application', async () => {
    const path = join(directory, 'conflit.fountain');
    await writeFile(path, 'version disque\n', 'utf8');

    // The renderer believes it knows an mtime that is no longer the file's.
    const outcome = await saveDocument(
      { path, content: 'version editeur\n', eol: 'lf', expectedMtimeMs: 1000 },
      3,
    );

    expect(outcome.status).toBe('conflict');
    // The user's file is intact: nothing was overwritten.
    expect(await readFile(path, 'utf8')).toBe('version disque\n');
  });

  it('refuses an existing legacy recovery target whose previous state is unknown', async () => {
    const path = join(directory, 'legacy-recovery.fountain');
    await writeFile(path, 'newer disk version\n', 'utf8');

    const outcome = await saveDocument(
      {
        path,
        content: 'unknown recovered version\n',
        eol: 'lf',
        expectedMtimeMs: null,
        refuseExisting: true,
      },
      3,
    );

    expect(outcome.status).toBe('conflict');
    expect(await readFile(path, 'utf8')).toBe('newer disk version\n');
  });

  it('accepts the write when the mtime matches', async () => {
    const path = join(directory, 'suite.fountain');
    await writeFile(path, 'v1\n', 'utf8');
    const { mtimeMs } = await stat(path);

    const outcome = await saveDocument(
      { path, content: 'v2\n', eol: 'lf', expectedMtimeMs: mtimeMs },
      3,
    );

    expect(outcome.status).toBe('saved');
    expect(await readFile(path, 'utf8')).toBe('v2\n');
  });

  it('reports an error instead of throwing when the path is invalid', async () => {
    // An existing file used as a parent directory: the write cannot succeed.
    const blocker = join(directory, 'bloqueur');
    await writeFile(blocker, 'x', 'utf8');

    const outcome = await saveDocument(
      {
        path: join(blocker, 'impossible.fountain'),
        content: 'x',
        eol: 'lf',
        expectedMtimeMs: null,
      },
      1,
    );

    expect(outcome.status).toBe('error');
  });
});

describe('saveDocument — rotating .bak backups', () => {
  it('creates no .bak on the first write', async () => {
    const path = join(directory, 'premier.fountain');
    await saveDocument({ path, content: 'v1\n', eol: 'lf', expectedMtimeMs: null }, 3);

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.includes('.bak'))).toEqual([]);
  });

  it('sets the previous version aside on every write', async () => {
    const path = join(directory, 'rotation.fountain');
    let mtime: number | null = null;

    for (const version of ['v1', 'v2', 'v3', 'v4']) {
      const outcome = await saveDocument(
        { path, content: `${version}\n`, eol: 'lf', expectedMtimeMs: mtime },
        3,
      );
      if (outcome.status !== 'saved') throw new Error(`unexpected failure: ${outcome.status}`);
      mtime = outcome.mtimeMs;
    }

    // v4 is the current file; the three previous versions are kept, most recent first.
    expect(await readFile(path, 'utf8')).toBe('v4\n');
    expect(await readFile(`${path}.bak`, 'utf8')).toBe('v3\n');
    expect(await readFile(`${path}.bak2`, 'utf8')).toBe('v2\n');
    expect(await readFile(`${path}.bak3`, 'utf8')).toBe('v1\n');
  });

  it('keeps no more backups than requested', async () => {
    const path = join(directory, 'plafond.fountain');
    let mtime: number | null = null;

    for (let i = 0; i < 6; i++) {
      const outcome = await saveDocument(
        { path, content: `v${i}\n`, eol: 'lf', expectedMtimeMs: mtime },
        2,
      );
      if (outcome.status !== 'saved') throw new Error('unexpected failure');
      mtime = outcome.mtimeMs;
    }

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.includes('.bak')).sort()).toEqual([
      'plafond.fountain.bak',
      'plafond.fountain.bak2',
    ]);
  });

  it('disables backups entirely when the count is zero', async () => {
    const path = join(directory, 'sansbak.fountain');
    await saveDocument({ path, content: 'v1\n', eol: 'lf', expectedMtimeMs: null }, 0);
    const { mtimeMs } = await stat(path);
    await saveDocument({ path, content: 'v2\n', eol: 'lf', expectedMtimeMs: mtimeMs }, 0);

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.includes('.bak'))).toEqual([]);
  });
});
