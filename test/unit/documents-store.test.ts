import { beforeEach, describe, expect, it } from 'vitest';
import { saveFingerprintCommit, useDocuments } from '../../src/renderer/store/documents.js';
import type { DocumentSnapshot } from '../../src/shared/ipc-contract.js';

/**
 * H3/H6 interlock at the renderer-store level.
 *
 * The filesystem base (`fileHash`) is installed only by `markSaved`, which the
 * document IO layer calls exclusively after a `saved` outcome. A conflicted save
 * therefore leaves the document dirty and its base pointing at the old disk
 * version — the next save must detect the same conflict again, and a close attempt
 * must not treat the document as persisted.
 */

const HASH_OLD = 'a'.repeat(64);
const HASH_NEW = 'b'.repeat(64);

function snapshot(hash: string): DocumentSnapshot {
  return {
    path: '/tmp/interlock.fountain',
    content: 'INT. X - DAY\n\nBase.\n',
    eol: 'lf',
    mtimeMs: 1000,
    hash,
  };
}

beforeEach(() => {
  useDocuments.setState({ documents: [], activeId: null });
});

describe('filesystem base lifecycle', () => {
  it('adopt installs the fingerprint of the opened disk version', () => {
    const id = useDocuments.getState().adopt([snapshot(HASH_OLD)]);
    const document = useDocuments.getState().documents.find((d) => d.id === id);
    expect(document?.fileHash).toBe(HASH_OLD);
    expect(document?.dirty).toBe(false);
  });

  it('a conflicted save leaves the document dirty with the old base — never a new one', () => {
    const id = useDocuments.getState().adopt([snapshot(HASH_OLD)]);
    useDocuments.getState().setContent(id!, 'INT. X - DAY\n\nEdited.\n');
    const before = useDocuments.getState().documents.find((d) => d.id === id);

    // The conflict path never reaches markSaved: the store is untouched, so a close
    // guard still sees dirty and the next save still compares against HASH_OLD.
    const after = useDocuments.getState().documents.find((d) => d.id === id);
    expect(after?.dirty).toBe(true);
    expect(after?.fileHash).toBe(before?.fileHash ?? null);
    expect(after?.fileHash).toBe(HASH_OLD);
  });

  it('markSaved after a successful write installs the published fingerprint and clears dirty', () => {
    const id = useDocuments.getState().adopt([snapshot(HASH_OLD)]);
    useDocuments.getState().setContent(id!, 'INT. X - DAY\n\nEdited.\n');

    const fullySaved = useDocuments
      .getState()
      .markSaved(id!, '/tmp/interlock.fountain', 2000, 1, HASH_NEW);

    expect(fullySaved).toBe(true);
    const document = useDocuments.getState().documents.find((d) => d.id === id);
    expect(document?.dirty).toBe(false);
    expect(document?.fileHash).toBe(HASH_NEW);
    expect(document?.mtimeMs).toBe(2000);
  });

  it('an edit during the disk write clears dirty only for the exact submitted revision', () => {
    const id = useDocuments.getState().adopt([snapshot(HASH_OLD)]);
    useDocuments.getState().setContent(id!, 'version 1\n'); // revision 1
    useDocuments.getState().setContent(id!, 'version 2\n'); // revision 2

    // The write that returned carried revision 1; a newer keystroke already landed.
    const fullySaved = useDocuments
      .getState()
      .markSaved(id!, '/tmp/interlock.fountain', 2000, 1, HASH_NEW);

    expect(fullySaved).toBe(false);
    const document = useDocuments.getState().documents.find((d) => d.id === id);
    expect(document?.dirty).toBe(true);
    // The base still advances: the disk really contains HASH_NEW, and the next save must
    // compare against those published bytes, not the stale HASH_OLD.
    expect(document?.fileHash).toBe(HASH_NEW);
  });
});

describe('saveFingerprintCommit (H3.6)', () => {
  it('a saved outcome commits the published fingerprint — and only that hash', () => {
    const outcome = {
      status: 'saved',
      path: '/tmp/interlock.fountain',
      mtimeMs: 2000,
      hash: HASH_NEW,
    } as const;

    const commit = saveFingerprintCommit(outcome, 'doc-id', 7);

    expect(commit).toEqual({
      id: 'doc-id',
      path: '/tmp/interlock.fountain',
      mtimeMs: 2000,
      savedRevision: 7,
      fileHash: HASH_NEW,
    });
  });

  it('every non-saved outcome yields no fingerprint commit', () => {
    const conflict = {
      status: 'conflict',
      path: '/tmp/interlock.fountain',
      mtimeMs: 1200,
      reason: 'changed-externally',
    } as const;
    const missing = {
      status: 'conflict',
      path: '/tmp/interlock.fountain',
      mtimeMs: null,
      reason: 'missing',
    } as const;
    const error = { status: 'error', message: 'disk full' } as const;
    const cancelled = { status: 'cancelled' } as const;

    expect(saveFingerprintCommit(conflict, 'doc-id', 7)).toBeNull();
    expect(saveFingerprintCommit(missing, 'doc-id', 7)).toBeNull();
    expect(saveFingerprintCommit(error, 'doc-id', 7)).toBeNull();
    expect(saveFingerprintCommit(cancelled, 'doc-id', 7)).toBeNull();
  });
});
