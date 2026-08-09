import { detectPathPlatform, documentPathsEqual } from './paths.js';

export interface DocumentVersion {
  id: string;
  revision: number;
  path?: string | null;
}

/** Identity captured before document-dependent asynchronous work begins. */
export interface DocumentOperationContext {
  documentId: string;
  documentRevision: number;
  /** Captured only for operations whose side effects belong beside a specific file. */
  documentPath?: string | null;
  requestId: string;
}

export type DocumentOperationStatus = 'current' | 'missing' | 'stale' | 'superseded';

export function beginDocumentOperation(
  document: DocumentVersion,
  requestPrefix: string,
): DocumentOperationContext {
  return {
    documentId: document.id,
    documentRevision: document.revision,
    ...(document.path !== undefined ? { documentPath: document.path } : {}),
    requestId: `${requestPrefix}-${crypto.randomUUID()}`,
  };
}

function pathIdentityChanged(
  captured: string | null,
  current: string | null | undefined,
  platform: string,
): boolean {
  const right = current ?? null;
  if (captured === null || right === null) return captured !== right;
  return !documentPathsEqual(captured, right, platform);
}

/**
 * Checks identity, lifetime, source revision and optional latest-request ownership.
 * Callers still choose whether a document-scoped result may commit while its tab is inactive.
 */
export function validateDocumentOperation(
  documents: readonly DocumentVersion[],
  operation: DocumentOperationContext,
  latestRequestId: string = operation.requestId,
  platform: string = detectPathPlatform(),
): DocumentOperationStatus {
  if (latestRequestId !== operation.requestId) return 'superseded';
  const target = documents.find((document) => document.id === operation.documentId);
  if (!target) return 'missing';
  if (
    operation.documentPath !== undefined &&
    pathIdentityChanged(operation.documentPath, target.path, platform)
  ) {
    return 'stale';
  }
  return target.revision === operation.documentRevision ? 'current' : 'stale';
}

/** Validates and commits synchronously, leaving no event-loop gap between the two steps. */
export function commitDocumentOperation<T extends DocumentVersion>(
  documents: readonly T[],
  operation: DocumentOperationContext,
  commit: (target: T) => void,
  latestRequestId: string = operation.requestId,
): DocumentOperationStatus {
  const status = validateDocumentOperation(documents, operation, latestRequestId);
  if (status === 'current') {
    const target = documents.find((document) => document.id === operation.documentId);
    if (target) commit(target);
  }
  return status;
}
