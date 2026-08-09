import { describe, expect, it, vi } from 'vitest';
import {
  beginDocumentOperation,
  commitDocumentOperation,
  type DocumentOperationContext,
  validateDocumentOperation,
} from '../../src/shared/documents/operations.js';

const operation: DocumentOperationContext = {
  documentId: 'document-a',
  documentRevision: 7,
  requestId: 'request-current',
};

describe('document operation guard', () => {
  it('accepts the exact initiating document and revision', () => {
    expect(validateDocumentOperation([{ id: 'document-a', revision: 7 }], operation)).toBe(
      'current',
    );
  });

  it('rejects a result when the initiating document was closed', () => {
    expect(validateDocumentOperation([{ id: 'document-b', revision: 7 }], operation)).toBe(
      'missing',
    );
  });

  it('rejects offsets calculated from an older revision of the same document', () => {
    expect(validateDocumentOperation([{ id: 'document-a', revision: 8 }], operation)).toBe('stale');
  });

  it('rejects a response superseded by a newer request', () => {
    expect(
      validateDocumentOperation([{ id: 'document-a', revision: 7 }], operation, 'request-newer'),
    ).toBe('superseded');
  });

  it('rejects a sidecar operation after Save As changes the document path', () => {
    const pathOperation = beginDocumentOperation(
      { id: 'document-a', revision: 7, path: '/old/alpha.fountain' },
      'sidecar',
    );
    expect(
      validateDocumentOperation(
        [{ id: 'document-a', revision: 7, path: '/new/alpha.fountain' }],
        pathOperation,
      ),
    ).toBe('stale');
  });

  it('invokes the commit only for the exact target', () => {
    const commit = vi.fn();
    const documents = [
      { id: 'document-a', revision: 7, content: 'A' },
      { id: 'document-b', revision: 7, content: 'B' },
    ];

    expect(commitDocumentOperation(documents, operation, commit)).toBe('current');
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(documents[0]);

    commit.mockClear();
    expect(commitDocumentOperation(documents, { ...operation, documentRevision: 6 }, commit)).toBe(
      'stale',
    );
    expect(commit).not.toHaveBeenCalled();
  });
});
