import { beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentPathCoordinator,
  comparableDocumentPath,
  documentPathsEqual,
  findDocumentByPath,
  normalizeDocumentPath,
  resetSharedDocumentPathCoordinator,
  sharedDocumentPathCoordinator,
} from '../../src/shared/documents/index.js';

describe('document path identity', () => {
  it('normalises redundant separators and relative segments', () => {
    expect(normalizeDocumentPath('/tmp/project/../project/./A.fountain')).toBe(
      '/tmp/project/A.fountain',
    );
  });

  it('folds case on macOS and Windows but not on Linux', () => {
    expect(documentPathsEqual('/tmp/A.fountain', '/tmp/a.fountain', 'darwin')).toBe(true);
    expect(documentPathsEqual('/tmp/A.fountain', '/tmp/a.fountain', 'win32')).toBe(true);
    expect(documentPathsEqual('/tmp/A.fountain', '/tmp/a.fountain', 'linux')).toBe(false);
  });

  it('finds an open owner through equivalent paths', () => {
    const documents = [
      { id: 'a', path: '/Scripts/Show.fountain' },
      { id: 'b', path: null },
    ];
    expect(findDocumentByPath(documents, '/scripts/show.fountain', 'darwin')?.id).toBe('a');
    expect(findDocumentByPath(documents, '/scripts/show.fountain', 'linux')).toBeUndefined();
  });

  it('builds a stable comparable key', () => {
    expect(comparableDocumentPath('/tmp/./X.fountain', 'darwin')).toBe('/tmp/x.fountain');
  });
});

describe('document path coordinator', () => {
  beforeEach(() => {
    resetSharedDocumentPathCoordinator();
  });

  it('serialises competing claims so only one Save As binds the destination', async () => {
    const coordinator = new DocumentPathCoordinator('darwin');
    let owner: string | null = null;
    const events: string[] = [];

    const first = coordinator.runExclusive('/tmp/B.fountain', async () => {
      events.push('first-enter');
      await Promise.resolve();
      if (owner && owner !== 'A1') return 'busy';
      owner = 'A1';
      events.push('first-commit');
      return 'ok';
    });

    const second = coordinator.runExclusive('/tmp/B.fountain', async () => {
      events.push('second-enter');
      if (owner && owner !== 'A2') return 'busy';
      owner = 'A2';
      events.push('second-commit');
      return 'ok';
    });

    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('busy');
    expect(owner).toBe('A1');
    expect(events).toEqual(['first-enter', 'first-commit', 'second-enter']);
  });

  it('lets Open observe the owner published by a preceding Save As claim', async () => {
    const coordinator = new DocumentPathCoordinator('darwin');
    const documents: { id: string; path: string | null }[] = [{ id: 'A', path: '/tmp/A.fountain' }];

    const saveAs = coordinator.runExclusive('/tmp/B.fountain', async () => {
      await Promise.resolve();
      const target = documents.find((document) => document.id === 'A');
      if (target) target.path = '/tmp/B.fountain';
      return 'saved';
    });

    const open = coordinator.runExclusive('/tmp/B.fountain', async () => {
      const existing = findDocumentByPath(documents, '/tmp/B.fountain', 'darwin');
      if (existing) return `focused:${existing.id}`;
      documents.push({ id: 'B', path: '/tmp/B.fountain' });
      return 'opened';
    });

    await expect(saveAs).resolves.toBe('saved');
    await expect(open).resolves.toBe('focused:A');
    expect(documents.filter((document) => document.path === '/tmp/B.fountain')).toHaveLength(1);
  });

  it('serialises recovery against an in-flight Save As on the shared coordinator', async () => {
    const coordinator = sharedDocumentPathCoordinator('darwin');
    const documents: { id: string; path: string | null }[] = [{ id: 'A', path: null }];
    let diskB = 'ORIGINAL_B';

    const saveAs = coordinator.runExclusive('/tmp/B.fountain', async () => {
      await Promise.resolve();
      diskB = 'FROM_A';
      const conflict = findDocumentByPath(documents, '/tmp/B.fountain', 'darwin');
      if (conflict && conflict.id !== 'A') return 'path-busy';
      documents[0]!.path = '/tmp/B.fountain';
      return 'saved';
    });

    const recovery = coordinator.runExclusive('/tmp/B.fountain', async () => {
      const existing = findDocumentByPath(documents, '/tmp/B.fountain', 'darwin');
      if (existing) return `focused:${existing.id}`;
      documents.push({ id: 'recovered', path: '/tmp/B.fountain' });
      return 'restored';
    });

    await expect(saveAs).resolves.toBe('saved');
    await expect(recovery).resolves.toBe('focused:A');
    expect(diskB).toBe('FROM_A');
    expect(documents.filter((document) => document.path === '/tmp/B.fountain')).toHaveLength(1);
  });
});
