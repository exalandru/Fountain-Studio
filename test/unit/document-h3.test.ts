import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * H3 — external-change detection and TOCTOU elimination.
 *
 * Every race witness here is deterministic: mutations are injected by call-count
 * into a mocked `readFile`, never by sleeping and hoping a write lands in a window.
 *
 * Historical bug pattern:
 *   1. `readFile` then `stat` associated OLD content with NEW metadata;
 *   2. a save conflict check happened once, before the expensive write work;
 *   3. a 1 ms mtime tolerance could mask two close writes.
 *
 * New model:
 *   - stable read: two independent observations of the exact bytes (SHA-256) must
 *     agree before a version is adopted; bounded retries, then a deterministic
 *     `unstable` failure;
 *   - the fingerprint of the adopted bytes becomes the save base;
 *   - the final disk check happens after the temp file is prepared and immediately
 *     before the atomic rename; byte identity (hash) is the sole authority.
 */

import type { readFile as ReadFileFn } from 'node:fs/promises';
import type { Stats } from 'node:fs';

type FsPromises = {
  readFile: typeof ReadFileFn;
  readdir: (path: string) => Promise<string[]>;
  writeFile: (
    path: string,
    data: string | NodeJS.ArrayBufferView,
    options?: BufferEncoding | object,
  ) => Promise<void>;
  access: (path: string) => Promise<void>;
  stat: (path: string) => Promise<Stats>;
};

/**
 * Deterministic read harness: each observed read can serve a captured version and
 * optionally let an "external writer" mutate the real file in the same instant.
 * No timing is involved — the sequence is prescribed by call order.
 */
const harness = vi.hoisted(() => {
  let readCalls = 0;
  let nextStep = 0;
  let statCalls = 0;
  let nextStatScript = 0;
  const steps: Array<{ serve?: Buffer; externalWrite?: string }> = [];
  const statScript: number[] = [];
  /** Sibling `.tmp` names present at each observed read (order preserved). */
  const observedTempSiblings: string[][] = [];
  return {
    get readCalls() {
      return readCalls;
    },
    get statCalls() {
      return statCalls;
    },
    get tempSiblingsAt() {
      return observedTempSiblings;
    },
    reset() {
      readCalls = 0;
      nextStep = 0;
      statCalls = 0;
      nextStatScript = 0;
      steps.length = 0;
      observedTempSiblings.length = 0;
      statScript.length = 0;
    },
    /** Plans the next observed read: `serve` is what the observation returns, `externalWrite` mutates the real file first. */
    plan(step: { serve?: Buffer; externalWrite?: string }) {
      steps.push(step);
    },
    /** Scripts the mtimeMs answered by the next `stat`; unconsumed entries are ignored. */
    planStat(mtimeMs: number) {
      statScript.push(mtimeMs);
    },
    async stat(path: string) {
      statCalls += 1;
      const fs = (await vi.importActual('node:fs/promises')) as FsPromises;
      const stats = await fs.stat(path);
      const scripted = nextStatScript < statScript.length ? statScript[nextStatScript] : undefined;
      if (scripted !== undefined) {
        nextStatScript += 1;
        // Keep the Stats prototype (isFile etc.) while overriding the mtimeMs getter.
        const altered = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats);
        Object.defineProperty(altered, 'mtimeMs', {
          value: scripted,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        return altered;
      }
      return stats;
    },
    async readFile(path: string, options?: BufferEncoding | object) {
      readCalls += 1;
      const fs = (await vi.importActual('node:fs/promises')) as FsPromises;
      const dir = join(path, '..');
      try {
        const entries = await fs.readdir(dir);
        observedTempSiblings.push(entries.filter((name) => name.endsWith('.tmp')));
      } catch {
        observedTempSiblings.push([]);
      }
      const step = steps[nextStep];
      if (step) nextStep += 1;
      if (step?.externalWrite !== undefined) {
        await fs.writeFile(path, step.externalWrite, 'utf8');
      }
      if (step?.serve !== undefined) return step.serve;
      return fs.readFile(path, options as never);
    },
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
  return {
    ...actual,
    readFile: harness.readFile,
    stat: harness.stat,
  };
});

async function loadDocument() {
  vi.resetModules();
  harness.reset();
  return import('../../src/main/files/document.js');
}

function bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fountain-studio-h3-'));
  harness.reset();
});

afterEach(() => {
  harness.reset();
});

const ORIGINAL = 'INT. A - DAY\n\nOriginal version.\n';
const EXTERNAL = 'EXT. B - NIGHT\n\nExternal writer version.\n';
const LOCAL = 'INT. C - DAY\n\nLocal edition.\n';

async function writeInitial(name = 'script.fountain', content = ORIGINAL): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('historical TOCTOU patterns', () => {
  it('readFile followed by stat could pair OLD content with NEW metadata', async () => {
    const path = await writeInitial();

    // The historical sequence: one read, then a stat of "the" file.
    const old = await readFile(path, 'utf8');
    expect(old).toBe(ORIGINAL);
    // External write lands between read and stat.
    await writeFile(path, EXTERNAL, 'utf8');
    const stats = await stat(path);

    // The pairing is incoherent: OLD content attributed to NEW metadata.
    expect(old).not.toBe(EXTERNAL);
    expect(Buffer.byteLength(EXTERNAL, 'utf8')).toBe(stats.size);
  });

  it('the 1 ms mtime tolerance could pass while the bytes diverged', async () => {
    const path = await writeInitial();
    const open = await stat(path);

    // Same-size external rewrite whose mtime the historical check would accept:
    // |current - expected| <= 1 ms — only a content identity can see the change.
    const rewritten = 'EXT. B - NIG\n\nExternal rewrite!\n';
    expect(bytes(rewritten).length).toBe(bytes(ORIGINAL).length);
    await writeFile(path, rewritten, 'utf8');
    await utimes(path, open.atime, open.mtime);

    const current = await stat(path);
    // The historical early-check condition is satisfied (blind spot)…
    expect(Math.abs(current.mtimeMs - open.mtimeMs)).toBeLessThan(2);
    // …despite the byte content being a different author's.
    expect(bytes(await readFile(path, 'utf8'))).not.toEqual(bytes(ORIGINAL));
  });
});

describe('H3 stable read', () => {
  it('A: an unmodified file is read with the exact fingerprint of its bytes', async () => {
    const { readDocument } = await loadDocument();
    const path = await writeInitial();

    const snapshot = await readDocument(path);
    expect(snapshot.content).toBe('INT. A - DAY\n\nOriginal version.\n');
    expect(snapshot.hash).toBe(sha256Of(bytes('INT. A - DAY\n\nOriginal version.\n')));
  });

  it('B: one mutation during the read — retry adopts the final stable version, never OLD bytes with a NEW fingerprint', async () => {
    const { readDocument, sha256Hex } = await loadDocument();
    const path = await writeInitial();

    // Observation 1 sees the OLD bytes (externalWrite lands in the same instant),
    // observations 2 and 3 see the NEW version: attempt 2 vs 3 stabilise on NEW.
    harness.plan({ serve: bytes(ORIGINAL), externalWrite: EXTERNAL });
    harness.plan({ serve: bytes(EXTERNAL) });
    harness.plan({ serve: bytes(EXTERNAL) });

    const snapshot = await readDocument(path);

    expect(snapshot.content).toBe(EXTERNAL);
    expect(snapshot.hash).toBe(sha256Hex(bytes(EXTERNAL)));
    // The adopted fingerprint is the one of the adopted bytes — never of a later observation.
    expect(snapshot.hash).not.toBe(sha256Hex(bytes(ORIGINAL)));
    expect(harness.readCalls).toBe(3);
  });

  it('C: continuous mutation fails deterministically after the bounded retries', async () => {
    const { readDocument, MAX_STABLE_READ_ATTEMPTS } = await loadDocument();
    const path = await writeInitial();
    const versions = ['v1\n', 'v2\n', 'v3\n'];
    for (const version of versions) {
      harness.plan({ serve: bytes(version), externalWrite: version });
    }

    await expect(readDocument(path)).rejects.toMatchObject({ code: 'unstable' });
    expect(harness.readCalls).toBe(MAX_STABLE_READ_ATTEMPTS);
    // No inconsistent document was ever adopted: the file still holds the last
    // version the external writer produced.
    expect(await diskRead(path)).toBe('v3\n');
  });

  it('openDocumentPaths surfaces instability as a per-path failure, never a document', async () => {
    const { openDocumentPaths } = await loadDocument();
    const path = await writeInitial();
    const versions = ['x1\n', 'x2\n', 'x3\n'];
    for (const version of versions) {
      harness.plan({ serve: bytes(version), externalWrite: version });
    }

    const outcome = await openDocumentPaths([path]);
    expect(outcome.documents).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.error).toMatchObject({ code: 'unstable' });
  });

  it('M: the stable read never bypasses the M2 size gate', async () => {
    const { readDocument } = await loadDocument();
    const path = await writeInitial('small.fountain', 'small\n');

    // The file on disk is small, but the observation yields far more bytes than the
    // gate allowed: the defensive post-read bound must refuse, not adopt.
    harness.plan({ serve: Buffer.alloc(4096, 0x61) });
    harness.plan({ serve: Buffer.alloc(4096, 0x61) });

    await expect(readDocument(path, { maxBytes: 128 })).rejects.toMatchObject({
      code: 'tooLarge',
    });
    expect(harness.readCalls).toBe(1);
  });
});

describe('H3 save conflict detection', () => {
  it('D: an external edit before Save is a conflict; EXTERNAL stays intact and no new base is returned', async () => {
    const { readDocument, saveDocument } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);

    await writeFile(path, EXTERNAL, 'utf8');
    const outcome = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      expect(outcome.reason).toBe('changed-externally');
      expect('hash' in outcome).toBe(false);
    }
    expect(await diskRead(path)).toBe(EXTERNAL);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('E: an external edit landing during Save, before the final check, is detected and never published over', async () => {
    const { readDocument, saveDocument } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);
    // The renderer then edits locally; Save starts with the OLD base hash.

    // Attempt 1 of the final verification observes ORIGINAL; the external writer
    // lands in that same instant; attempts 2–3 observe EXTERNAL (stable).
    harness.plan({ serve: bytes(ORIGINAL), externalWrite: EXTERNAL });
    harness.plan({ serve: bytes(EXTERNAL) });
    harness.plan({ serve: bytes(EXTERNAL) });

    const outcome = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') expect(outcome.reason).toBe('changed-externally');
    expect(await diskRead(path)).toBe(EXTERNAL);
    // LOCAL must not have been published despite the temp having been prepared.
    expect(await diskRead(path)).not.toBe(LOCAL);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Ordering witness: the sibling temporary was already on disk when the final
    // verification began (open consumed two harness observations first, so the
    // third is the verification's first read). A save that verified before
    // preparing the temp — the historical pattern — shows an empty observation
    // exactly there.
    expect(harness.tempSiblingsAt[0] ?? []).toEqual([]);
    expect(harness.tempSiblingsAt[1] ?? []).toEqual([]);
    const atFirstVerificationRead = harness.tempSiblingsAt[2] ?? [];
    expect(atFirstVerificationRead.some((name) => name.endsWith('.tmp'))).toBe(true);
  });

  it('F: mtime changed but bytes identical — no false conflict, save succeeds', async () => {
    const { readDocument, saveDocument } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);

    // External tool only touches the timestamp.
    const current = await stat(path);
    await utimes(path, current.atime, new Date(current.mtimeMs + 5000));

    const outcome = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );

    expect(outcome.status).toBe('saved');
    expect(await readFile(path, 'utf8')).toBe(LOCAL);
  });

  it('G: bytes changed with an identical mtime — the hash is the sole authority and the save refuses', async () => {
    const { readDocument, saveDocument } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);
    const openMtime = opened.mtimeMs;
    expect(openMtime).not.toBeNull();

    // Same-size external rewrite…
    const rewritten = 'EXT. B - NIG\n\nExternal rewrite!\n';
    expect(bytes(rewritten).length).toBe(bytes(ORIGINAL).length);
    await writeFile(path, rewritten, 'utf8');
    // …and the mtime pinned back to the exact value the renderer recorded.
    await utimes(path, new Date(openMtime as number), new Date(openMtime as number));
    const pinned = await stat(path);

    // The mtime the historical check would compare is identical within 1 ms…
    expect(Math.abs(pinned.mtimeMs - (openMtime as number))).toBeLessThan(2);
    const outcome = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        // ...even when the renderer passes the pinned mtime verbatim.
        expectedMtimeMs: pinned.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') expect(outcome.reason).toBe('changed-externally');
    // The historical mtime-only check would have passed here and overwritten silently.
    expect(await readFile(path, 'utf8')).toBe(rewritten);
  });

  it('H: a source deleted externally is a missing-source conflict, never silently recreated', async () => {
    const { readDocument, saveDocument } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);

    await unlink(path);

    const outcome = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      expect(outcome.reason).toBe('missing');
      expect('hash' in outcome).toBe(false);
    }
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('H-l: the legacy mtime fallback also fails closed on a deleted source', async () => {
    const { saveDocument } = await loadDocument();
    const path = await writeInitial();
    const openedStats = await stat(path);

    await unlink(path);

    const outcome = await saveDocument(
      { path, content: LOCAL, eol: 'lf', expectedMtimeMs: openedStats.mtimeMs },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') expect(outcome.reason).toBe('missing');
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('I: a source replaced through rename-over is a conflict', async () => {
    const { readDocument, saveDocument } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);

    const replacement = join(directory, 'replacement.tmp');
    await writeFile(replacement, EXTERNAL, 'utf8');
    await rename(replacement, path);

    const outcome = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') expect(outcome.reason).toBe('changed-externally');
    expect(await diskRead(path)).toBe(EXTERNAL);
  });

  it('J: a successful save installs the fingerprint of the exact published bytes, and the next save works against it', async () => {
    const { readDocument, saveDocument, sha256Hex } = await loadDocument();
    const path = await writeInitial();
    const opened = await readDocument(path);

    const first = await saveDocument(
      {
        path,
        content: LOCAL,
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );
    expect(first.status).toBe('saved');
    if (first.status !== 'saved') return;
    // The new base matches the bytes actually published — not a later disk reread.
    expect(first.hash).toBe(sha256Hex(Buffer.from(LOCAL, 'utf8')));
    expect(await readFile(path, 'utf8')).toBe(LOCAL);

    // A second save against the fresh base succeeds even though time passed.
    const second = await saveDocument(
      {
        path,
        content: `${LOCAL}More.\n`,
        eol: 'lf',
        expectedMtimeMs: first.mtimeMs,
        expectedHash: first.hash,
      },
      0,
    );
    expect(second.status).toBe('saved');
    if (second.status !== 'saved') return;
    expect(second.hash).toBe(sha256Hex(Buffer.from(`${LOCAL}More.\n`, 'utf8')));
  });

  it('K: CRLF — the hash covers the exact raw bytes, and the republished hash matches too', async () => {
    const { readDocument, saveDocument, sha256Hex } = await loadDocument();
    const crlf = 'INT. A - JOUR\r\n\r\nElle entre.\r\n';
    const path = await writeInitial('crlf.fountain', crlf);

    const opened = await readDocument(path);
    expect(opened.content).toBe('INT. A - JOUR\n\nElle entre.\n');
    expect(opened.hash).toBe(sha256Hex(bytes(crlf)));

    const outcome = await saveDocument(
      {
        path,
        content: 'INT. A - JOUR\n\nElle entre à nouveau.\n',
        eol: 'crlf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.hash).toBe(sha256Hex(bytes('INT. A - JOUR\r\n\r\nElle entre à nouveau.\r\n')));
  });

  it('L: Unicode multibyte content hashes and round-trips coherently', async () => {
    const { readDocument, saveDocument, sha256Hex } = await loadDocument();
    const text = 'Élodie s’éloigne. — « Ça va ! »\n';
    const path = await writeInitial('unicode.fountain', text);

    const opened = await readDocument(path);
    expect(opened.hash).toBe(sha256Hex(bytes(text)));
    expect(opened.content).toBe(text);

    const outcome = await saveDocument(
      {
        path,
        content: 'Çа marche déjà.\n',
        eol: 'lf',
        expectedMtimeMs: opened.mtimeMs,
        expectedHash: opened.hash,
      },
      0,
    );
    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.hash).toBe(sha256Hex(bytes('Çа marche déjà.\n')));
  });

  it('J2: a file larger than the open limit that the app itself published still verifies by fingerprint and saves', async () => {
    const { saveDocument, sha256Hex } = await loadDocument();
    // 101 MiB of ASCII — beyond MAX_OPEN_FILE_BYTES (100 MiB): reopenable requires
    // the owner to trim it, but an in-place Save must not falsely report conflict.
    const big = Buffer.alloc(101 * 1024 * 1024, 0x61);
    const path = await writeInitial('big.fountain');
    await writeFile(path, big);

    const outcome = await saveDocument(
      {
        path,
        content: big.toString('utf8'),
        eol: 'lf',
        expectedMtimeMs: 0,
        expectedHash: sha256Hex(big),
      },
      0,
    );

    expect(outcome.status).toBe('saved');
    if (outcome.status !== 'saved') return;
    expect(outcome.hash).toBe(sha256Hex(big));
    expect((await diskRead(path)).length).toBe(big.length);
  });

  it('J3: an entry beyond any publishable size is a conflict declared without reading it', async () => {
    const { saveDocument, sha256Hex } = await loadDocument();
    // 401 MiB > 4 × MAX_OPEN_FILE_BYTES: too large to be any version this app
    // authored — the verification must refuse without loading it into memory.
    const monster = Buffer.alloc(401 * 1024 * 1024, 0x62);
    const path = await writeInitial('monster.fountain');
    await writeFile(path, monster);

    const outcome = await saveDocument(
      {
        path,
        content: 'LOCAL\n',
        eol: 'lf',
        expectedMtimeMs: 0,
        expectedHash: sha256Hex(bytes('not the monster\n')),
      },
      0,
    );

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') expect(outcome.reason).toBe('changed-externally');
    // No read reached the harness: the refusal happens from the stat alone.
    expect(harness.readCalls).toBe(0);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('N: the reported mtime is the gate observation preceding the adopted read — never a post-adoption stat (recovery pairing)', async () => {
    const { readDocument, sha256Hex } = await loadDocument();
    const path = await writeInitial();

    // Both stable attempts serve the ORIGINAL version. The gate observations see
    // mtime 1000. A trailing observation taken after adoption would see the
    // external writer's mtime 9000 — attaching a newer version's timestamp to the
    // adopted bytes would let the legacy recovery path later accept and silently
    // overwrite the EXTERNAL version on disk.
    harness.plan({ serve: bytes(ORIGINAL) });
    harness.plan({ serve: bytes(ORIGINAL) });
    harness.planStat(1000);
    harness.planStat(1000);
    harness.planStat(9000);

    const snapshot = await readDocument(path);

    // No observation may follow the accepted read: the post-adoption trailing stat
    // must not exist (the old code performed 3 stats and adopted mtime 9000).
    expect(harness.statCalls).toBe(2);
    expect(snapshot.mtimeMs).toBe(1000);
    expect(snapshot.hash).toBe(sha256Hex(bytes(ORIGINAL)));
  });
});

function sha256Of(buffer: Buffer): string {
  // Reimplemented here so the test never trusts the production helper to hash itself.
  return createHash('sha256').update(buffer).digest('hex');
}

/** Disk truth checked through the real fs module, bypassing the read harness. */
async function diskRead(path: string): Promise<string> {
  const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
  return actual.readFile(path, 'utf8');
}
