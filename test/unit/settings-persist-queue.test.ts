import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M1 — settings persist queue must recover after a rejected write.
 *
 * The historical bug was:
 *   persistQueue = persistQueue.then(write)
 * so a rejected queue permanently skipped every later write.
 */

const harness = vi.hoisted(() => {
  let userData = '';
  let failNextWrite = false;
  let holdAtStartedIndex: number | null = null;
  let holdBarrier: Promise<void> | null = null;
  const started: string[] = [];
  const published: string[] = [];

  return {
    get userData() {
      return userData;
    },
    setUserData(path: string) {
      userData = path;
    },
    failNext() {
      failNextWrite = true;
    },
    /** Hold the write that will become `started[index]` (0-based). */
    holdAt(index: number, barrier: Promise<void>) {
      holdAtStartedIndex = index;
      holdBarrier = barrier;
    },
    resetIO() {
      failNextWrite = false;
      holdAtStartedIndex = null;
      holdBarrier = null;
      started.length = 0;
      published.length = 0;
    },
    started,
    published,
    async writeFileAtomic(path: string, data: string | Uint8Array) {
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const index = started.length;
      started.push(text);
      if (holdAtStartedIndex === index && holdBarrier) {
        const barrier = holdBarrier;
        holdAtStartedIndex = null;
        holdBarrier = null;
        await barrier;
      }
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('disk full');
      }
      const atomic = (await vi.importActual('../../src/main/files/atomic.js')) as {
        writeFileAtomic: (target: string, payload: string | Uint8Array) => Promise<void>;
      };
      await atomic.writeFileAtomic(path, data);
      published.push(text);
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => harness.userData,
    getLocale: () => 'en-US',
    addRecentDocument: vi.fn(),
    clearRecentDocuments: vi.fn(),
  },
}));

vi.mock('../../src/main/files/atomic.js', () => ({
  writeFileAtomic: (path: string, data: string | Uint8Array) => harness.writeFileAtomic(path, data),
}));

async function loadStore() {
  vi.resetModules();
  harness.resetIO();
  return import('../../src/main/store.js');
}

async function diskSettings(): Promise<unknown> {
  const raw = await readFile(join(harness.userData, 'settings.json'), 'utf8');
  return (JSON.parse(raw) as { settings: unknown }).settings;
}

describe('settings persist queue (M1)', () => {
  beforeEach(async () => {
    harness.setUserData(await mkdtemp(join(tmpdir(), 'fountain-settings-queue-')));
  });

  afterEach(() => {
    harness.resetIO();
  });

  it('recovers so a second write succeeds after the first write fails', async () => {
    const store = await loadStore();

    harness.failNext();
    await expect(store.patchSettings({ theme: 'dark' })).rejects.toThrow('disk full');
    expect(harness.started).toHaveLength(1);
    expect(harness.published).toHaveLength(0);

    await expect(store.patchSettings({ theme: 'light' })).resolves.toMatchObject({
      theme: 'light',
    });
    expect(harness.started).toHaveLength(2);
    expect(harness.published).toHaveLength(1);
    await expect(diskSettings()).resolves.toMatchObject({ theme: 'light' });
  });

  it('keeps A→B→C order when A fails and B/C were queued immediately', async () => {
    const store = await loadStore();
    // Warm the in-memory cache so concurrent patchSettings do not race on first load.
    await store.getSettings();

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    harness.holdAt(0, holdA);
    harness.failNext();

    const a = store.patchSettings({ editorFontSize: 11 });
    const b = store.patchSettings({ editorFontSize: 12 });
    const c = store.patchSettings({ editorFontSize: 13 });

    // A has started and is held before its forced failure; B/C must not have begun.
    await expect.poll(() => harness.started.length).toBe(1);
    expect(harness.started).toHaveLength(1);

    releaseA();
    await expect(a).rejects.toThrow('disk full');
    await expect(b).resolves.toMatchObject({ editorFontSize: 13 });
    await expect(c).resolves.toMatchObject({ editorFontSize: 13 });

    expect(harness.started).toHaveLength(3);
    expect(harness.published).toHaveLength(2);
    // Both successful writes ran after A and observed the latest memory (C).
    expect(JSON.parse(harness.published[0]!).settings.editorFontSize).toBe(13);
    expect(JSON.parse(harness.published[1]!).settings.editorFontSize).toBe(13);
    await expect(diskSettings()).resolves.toMatchObject({ editorFontSize: 13 });
  });

  it('does not start C until B has settled after A fails', async () => {
    const store = await loadStore();
    await store.getSettings();

    let releaseB!: () => void;
    const holdB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    harness.failNext();
    // Hold the second write (B); C must remain unstarted while B is pending.
    harness.holdAt(1, holdB);

    const a = store.patchSettings({ autosaveSeconds: 10 });
    const b = store.patchSettings({ autosaveSeconds: 20 });
    const c = store.patchSettings({ autosaveSeconds: 30 });

    await expect(a).rejects.toThrow('disk full');
    await expect.poll(() => harness.started.length).toBe(2);
    expect(harness.started).toHaveLength(2);
    expect(harness.published).toHaveLength(0);

    releaseB();
    await expect(b).resolves.toMatchObject({ autosaveSeconds: 30 });
    await expect(c).resolves.toMatchObject({ autosaveSeconds: 30 });
    expect(harness.started).toHaveLength(3);
    expect(harness.published).toHaveLength(2);
    await expect(diskSettings()).resolves.toMatchObject({ autosaveSeconds: 30 });
  });

  it('still recovers after consecutive failures', async () => {
    const store = await loadStore();

    harness.failNext();
    await expect(store.patchSettings({ language: 'fr' })).rejects.toThrow('disk full');
    harness.failNext();
    await expect(store.patchSettings({ language: 'en' })).rejects.toThrow('disk full');
    await expect(store.patchSettings({ language: 'fr' })).resolves.toMatchObject({
      language: 'fr',
    });
    await expect(diskSettings()).resolves.toMatchObject({ language: 'fr' });
  });

  it('does not start B until A has settled', async () => {
    const store = await loadStore();
    await store.getSettings();

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    harness.holdAt(0, holdA);

    const a = store.patchSettings({ showNotes: false });
    const b = store.patchSettings({ showNotes: true });

    await expect.poll(() => harness.started.length).toBe(1);
    expect(harness.started).toHaveLength(1);

    releaseA();
    await a;
    await b;
    expect(harness.started).toHaveLength(2);
    expect(harness.published).toHaveLength(2);
    expect(JSON.parse(harness.published[0]!).settings.showNotes).toBe(true);
    expect(JSON.parse(harness.published[1]!).settings.showNotes).toBe(true);
  });

  it('keeps optimistic memory on failure and converges with disk after a later success', async () => {
    const store = await loadStore();

    harness.failNext();
    await expect(store.patchSettings({ focusMode: true })).rejects.toThrow('disk full');
    // Memory already advanced before persistence; callers treat patch as optimistic.
    await expect(store.getSettings()).resolves.toMatchObject({ focusMode: true });

    await expect(store.patchSettings({ typewriterMode: true })).resolves.toMatchObject({
      focusMode: true,
      typewriterMode: true,
    });
    await expect(store.getSettings()).resolves.toMatchObject({
      focusMode: true,
      typewriterMode: true,
    });
    await expect(diskSettings()).resolves.toMatchObject({
      focusMode: true,
      typewriterMode: true,
    });
  });

  it('persists a mutation made while a failing write is still in flight', async () => {
    const store = await loadStore();
    await store.getSettings();

    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    harness.holdAt(0, holdA);
    harness.failNext();

    const a = store.patchSettings({ theme: 'dark' });
    await expect.poll(() => harness.started.length).toBe(1);

    // Mutation B while A is still pending; A must not win the disk afterward.
    const b = store.patchSettings({ theme: 'light' });
    releaseA();

    await expect(a).rejects.toThrow('disk full');
    await expect(b).resolves.toMatchObject({ theme: 'light' });
    await expect(store.getSettings()).resolves.toMatchObject({ theme: 'light' });
    await expect(diskSettings()).resolves.toMatchObject({ theme: 'light' });
    expect(harness.started).toHaveLength(2);
    expect(harness.published).toHaveLength(1);
  });

  it('preserves the nominal multi-write path', async () => {
    const store = await loadStore();
    await store.patchSettings({ theme: 'dark' });
    await store.patchSettings({ theme: 'system' });
    await expect(diskSettings()).resolves.toMatchObject({ theme: 'system' });
    expect(harness.published).toHaveLength(2);
  });
});

describe('historical poisoned-queue pattern', () => {
  it('shows why a bare persistQueue.then(write) never runs the second write', async () => {
    let queue: Promise<void> = Promise.resolve();
    const ran: string[] = [];

    const buggyPersist = (label: string, fail: boolean) => {
      queue = queue.then(async () => {
        ran.push(label);
        if (fail) throw new Error('disk full');
      });
      return queue;
    };

    await expect(buggyPersist('A', true)).rejects.toThrow('disk full');
    await expect(buggyPersist('B', false)).rejects.toThrow('disk full');
    expect(ran).toEqual(['A']);
  });
});
