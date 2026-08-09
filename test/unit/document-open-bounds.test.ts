import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_OPEN_FILE_BYTES, MAX_OPEN_PATHS } from '../../src/shared/documents/limits.js';

/**
 * M2 — main-process open bounds: stat before read, per-file and batch budgets.
 *
 * `readFile` is wrapped so tests can prove oversize / batch refusal never allocates
 * file contents (ESM exports are not spyable with vi.spyOn).
 */

import type { readFile as ReadFileFn } from 'node:fs/promises';

type FsPromises = {
  readFile: typeof ReadFileFn;
  writeFile: (
    path: string,
    data: string | NodeJS.ArrayBufferView,
    options?: BufferEncoding | object,
  ) => Promise<void>;
  mkdir: (path: string, options?: object) => Promise<string | undefined>;
  symlink: (target: string, path: string) => Promise<void>;
  open: (
    path: string,
    flags: string,
  ) => Promise<{ truncate: (len: number) => Promise<void>; close: () => Promise<void> }>;
};

const harness = vi.hoisted(() => {
  let readCalls = 0;
  return {
    get readCalls() {
      return readCalls;
    },
    reset() {
      readCalls = 0;
    },
    async readFile(path: string, options?: BufferEncoding | object) {
      readCalls += 1;
      const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
      return actual.readFile(path, options as never);
    },
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
  return {
    ...actual,
    readFile: harness.readFile,
  };
});

async function loadDocument() {
  vi.resetModules();
  harness.reset();
  return import('../../src/main/files/document.js');
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fountain-studio-open-bounds-'));
  harness.reset();
});

afterEach(() => {
  harness.reset();
});

async function writeBytes(name: string, bytes: number, fill = 0x61): Promise<string> {
  const path = join(directory, name);
  const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
  await actual.writeFile(path, Buffer.alloc(bytes, fill));
  return path;
}

describe('historical unbounded open pattern', () => {
  it('shows why readFile-before-stat never refuses on size', async () => {
    const path = await writeBytes('huge.fountain', 64);
    let readCalls = 0;
    const maxBytes = 32;

    const buggyRead = async (target: string) => {
      readCalls += 1;
      const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
      return actual.readFile(target, 'utf8');
    };

    await expect(buggyRead(path)).resolves.toHaveLength(64);
    expect(readCalls).toBe(1);
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    expect(Buffer.byteLength(await actual.readFile(path))).toBeGreaterThan(maxBytes);
  });
});

describe('readDocument open bounds (M2)', () => {
  it('does not call readFile when stat.size exceeds the limit', async () => {
    const { readDocument } = await loadDocument();
    const path = await writeBytes('over.fountain', 40);

    await expect(readDocument(path, { maxBytes: 32 })).rejects.toMatchObject({
      code: 'tooLarge',
    });
    expect(harness.readCalls).toBe(0);
  });

  it('opens a file exactly at the byte limit (<=)', async () => {
    const { readDocument } = await loadDocument();
    const path = await writeBytes('exact.fountain', 32);
    const snapshot = await readDocument(path, { maxBytes: 32 });
    expect(snapshot.content).toHaveLength(32);
    expect(harness.readCalls).toBe(1);
  });

  it('opens a file just under the limit', async () => {
    const { readDocument } = await loadDocument();
    const path = await writeBytes('under.fountain', 31);
    await expect(readDocument(path, { maxBytes: 32 })).resolves.toMatchObject({ path });
    expect(harness.readCalls).toBe(1);
  });

  it('refuses a directory without reading it as UTF-8', async () => {
    const { readDocument } = await loadDocument();
    const path = join(directory, 'folder');
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    await actual.mkdir(path);

    await expect(readDocument(path, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'notRegularFile',
    });
    expect(harness.readCalls).toBe(0);
  });

  it('measures UTF-8 bytes from the filesystem, not string.length', async () => {
    const { readDocument } = await loadDocument();
    const path = join(directory, 'unicode.fountain');
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    await actual.writeFile(path, 'é'.repeat(20), 'utf8');
    expect(Buffer.byteLength(await actual.readFile(path))).toBe(40);
    expect((await actual.readFile(path, 'utf8')).length).toBe(20);

    await expect(readDocument(path, { maxBytes: 32 })).rejects.toMatchObject({
      code: 'tooLarge',
    });
    expect(harness.readCalls).toBe(0);
  });

  it('accepts a symlink to a regular file (stat follows)', async () => {
    const { readDocument } = await loadDocument();
    const target = await writeBytes('target.fountain', 16);
    const link = join(directory, 'alias.fountain');
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    await actual.symlink(target, link);
    const snapshot = await readDocument(link, { maxBytes: 32 });
    expect(snapshot.content).toHaveLength(16);
  });

  it('opens a normal Fountain screenplay under the default limit', async () => {
    const { readDocument } = await loadDocument();
    const path = join(directory, 'scene.fountain');
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    await actual.writeFile(path, 'INT. CAFE - DAY\n\nALICE\nHello.\n', 'utf8');
    const snapshot = await readDocument(path);
    expect(snapshot.content).toContain('INT. CAFE - DAY');
  });
});

describe('planDocumentOpen batch bounds (M2)', () => {
  it('refuses an over-budget batch before any full-file read', async () => {
    const { planDocumentOpen } = await loadDocument();
    const a = await writeBytes('a.fountain', 20);
    const b = await writeBytes('b.fountain', 20);
    const c = await writeBytes('c.fountain', 20);

    const plan = await planDocumentOpen([a, b, c], {
      maxFileBytes: 32,
      maxBatchBytes: 50,
      maxPaths: 10,
    });

    expect(plan.batchError).toMatchObject({ code: 'batchTooLarge' });
    expect(plan.accepted).toEqual([]);
    expect(harness.readCalls).toBe(0);
  });

  it('keeps partial success for one oversize file among valid peers', async () => {
    const { planDocumentOpen, DocumentOpenError } = await loadDocument();
    const ok = await writeBytes('ok.fountain', 10);
    const big = await writeBytes('big.fountain', 40);
    const plan = await planDocumentOpen([ok, big], {
      maxFileBytes: 32,
      maxBatchBytes: 100,
      maxPaths: 10,
    });

    expect(plan.accepted.map((entry) => entry.path)).toEqual([ok]);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0]?.error).toBeInstanceOf(DocumentOpenError);
    expect((plan.failures[0]?.error as InstanceType<typeof DocumentOpenError>).code).toBe(
      'tooLarge',
    );
    expect(plan.batchError).toBeNull();
    expect(harness.readCalls).toBe(0);
  });

  it('allows max paths and rejects max + 1', async () => {
    const { assertOpenPathCount, DocumentOpenError } = await loadDocument();
    const max = Array.from({ length: MAX_OPEN_PATHS }, (_, i) => `/tmp/f-${i}.fountain`);
    expect(() => assertOpenPathCount(max)).not.toThrow();
    expect(() => assertOpenPathCount([...max, '/tmp/extra.fountain'])).toThrow(DocumentOpenError);
    try {
      assertOpenPathCount([...max, '/tmp/extra.fountain']);
    } catch (error) {
      expect(error).toMatchObject({ code: 'tooManyFiles' });
    }
  });

  it('rejects a cumulative overflow that would wrap a naïve sum', async () => {
    const { assertOpenBatchBudget, DocumentOpenError } = await loadDocument();
    expect(() =>
      assertOpenBatchBudget([Number.MAX_SAFE_INTEGER - 1, 2], Number.MAX_SAFE_INTEGER),
    ).toThrow(DocumentOpenError);
  });

  it('openDocumentPaths skips readFile when the batch budget fails', async () => {
    const { openDocumentPaths } = await loadDocument();
    const a = await writeBytes('oa.fountain', 20);
    const b = await writeBytes('ob.fountain', 20);
    const c = await writeBytes('oc.fountain', 20);

    const outcome = await openDocumentPaths([a, b, c], {
      maxFileBytes: 32,
      maxBatchBytes: 50,
      maxPaths: 10,
    });

    expect(outcome.batchError).toMatchObject({ code: 'batchTooLarge' });
    expect(outcome.documents).toEqual([]);
    expect(harness.readCalls).toBe(0);
  });

  it('openDocumentPaths reads only the accepted peer after an oversize sibling', async () => {
    const { openDocumentPaths } = await loadDocument();
    const ok = await writeBytes('peer-ok.fountain', 10);
    const big = await writeBytes('peer-big.fountain', 40);

    const outcome = await openDocumentPaths([ok, big], {
      maxFileBytes: 32,
      maxBatchBytes: 100,
      maxPaths: 10,
    });

    expect(outcome.documents.map((document) => document.path)).toEqual([ok]);
    expect(outcome.failures).toHaveLength(1);
    expect(harness.readCalls).toBe(1);
  });

  it('planDocumentOpen throws tooManyFiles before stating paths', async () => {
    const { planDocumentOpen } = await loadDocument();
    const paths = Array.from({ length: 4 }, (_, i) => join(directory, `${i}.fountain`));
    await expect(
      planDocumentOpen(paths, { maxFileBytes: 32, maxBatchBytes: 100, maxPaths: 3 }),
    ).rejects.toMatchObject({ code: 'tooManyFiles' });
    expect(harness.readCalls).toBe(0);
  });
});

describe('performance fixture remains openable', () => {
  it('keeps the 120-page generated screenplay under MAX_OPEN_FILE_BYTES', async () => {
    const { readDocument } = await loadDocument();
    const pages = 120;
    const out: string[] = ['Title: Load', 'Author: Test', '', '# ACT I', ''];
    let line = 0;
    let scene = 0;
    while (line < pages * 54) {
      scene += 1;
      out.push(`INT. ROOM - DAY #${scene}#`, '', 'Action.', '');
      line += 4;
      for (let i = 0; i < 4; i++) {
        out.push('ALICE', 'A line of dialogue.', '');
        line += 3;
      }
    }
    const script = out.join('\n');
    expect(Buffer.byteLength(script, 'utf8')).toBeLessThan(MAX_OPEN_FILE_BYTES);

    const path = join(directory, 'perf.fountain');
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    await actual.writeFile(path, script, 'utf8');
    const snapshot = await readDocument(path);
    expect(snapshot.content.length).toBeGreaterThan(1000);
  });
});

describe('sparse oversize gate', () => {
  it('refuses a sparse file whose st_size exceeds the limit without reading contents', async () => {
    const { readDocument } = await loadDocument();
    const path = join(directory, 'sparse.fountain');
    const actual = (await vi.importActual('node:fs/promises')) as FsPromises;
    const handle = await actual.open(path, 'w');
    try {
      await handle.truncate(1024);
    } finally {
      await handle.close();
    }

    await expect(readDocument(path, { maxBytes: 512 })).rejects.toMatchObject({
      code: 'tooLarge',
    });
    expect(harness.readCalls).toBe(0);
  });
});
