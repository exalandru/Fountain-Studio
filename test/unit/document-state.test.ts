import { describe, expect, it } from 'vitest';
import {
  parseCrashRecovery,
  refuseRecoveredExistingFile,
  resolveSavedRevision,
} from '../../src/shared/documents/index.js';

describe('document save revisions', () => {
  it('does not mark edits made during a disk write as saved', () => {
    expect(resolveSavedRevision(2, 1, true)).toEqual({
      fullySaved: false,
      dirty: true,
    });
  });

  it('marks the exact submitted revision as clean', () => {
    expect(resolveSavedRevision(2, 2, true)).toEqual({
      fullySaved: true,
      dirty: false,
    });
  });
});

describe('autosave record validation', () => {
  it('accepts current records and preserves their disk state', () => {
    expect(
      parseCrashRecovery(
        JSON.stringify({
          path: '/tmp/a.fountain',
          content: 'text',
          eol: 'crlf',
          mtimeMs: 42,
          savedAt: 100,
        }),
      ),
    ).toEqual({
      path: '/tmp/a.fountain',
      content: 'text',
      eol: 'crlf',
      mtimeMs: 42,
      savedAt: 100,
    });
  });

  it('accepts legacy records but rejects malformed snapshots', () => {
    expect(parseCrashRecovery('{"path":null,"content":"old","savedAt":1}')).toEqual({
      path: null,
      content: 'old',
      savedAt: 1,
    });
    expect(parseCrashRecovery('not json')).toBeNull();
    expect(parseCrashRecovery('{"content":42}')).toBeNull();
  });
});

describe('crash recovery disk state', () => {
  it('requires Save As for a legacy recovered path without an mtime', () => {
    expect(refuseRecoveredExistingFile('/tmp/legacy.fountain', undefined)).toBe(true);
  });

  it('retains normal conflict detection when the mtime was recorded', () => {
    expect(refuseRecoveredExistingFile('/tmp/current.fountain', 42)).toBe(false);
  });

  it('does not constrain a recovered document that never had a path', () => {
    expect(refuseRecoveredExistingFile(null, undefined)).toBe(false);
  });
});
