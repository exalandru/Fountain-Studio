/**
 * Pure document-lifecycle decisions shared with unit tests.
 *
 * The renderer store applies these decisions to Zustand state, while this module keeps
 * the data-loss invariants independent from React and Electron.
 */

export {
  comparableDocumentPath,
  detectPathPlatform,
  documentPathsEqual,
  findDocumentByPath,
  normalizeDocumentPath,
  type PathPlatform,
} from './paths.js';
export {
  DocumentPathCoordinator,
  resetSharedDocumentPathCoordinator,
  sharedDocumentPathCoordinator,
} from './path-ownership.js';
export {
  DEFAULT_DOCUMENT_OPEN_LIMITS,
  formatOpenByteLimit,
  MAX_OPEN_BATCH_BYTES,
  MAX_OPEN_FILE_BYTES,
  MAX_OPEN_PATHS,
  type DocumentOpenLimits,
} from './limits.js';

export interface SavedRevisionDecision {
  fullySaved: boolean;
  dirty: boolean;
}

export function resolveSavedRevision(
  currentRevision: number,
  savedRevision: number,
  wasDirty: boolean,
): SavedRevisionDecision {
  const fullySaved = currentRevision === savedRevision;
  return { fullySaved, dirty: fullySaved ? false : wasDirty };
}

export function refuseRecoveredExistingFile(
  path: string | null,
  recordedMtimeMs: number | null | undefined,
): boolean {
  return path !== null && recordedMtimeMs === undefined;
}

export interface ParsedCrashRecovery {
  path: string | null;
  content: string;
  eol?: 'lf' | 'crlf';
  mtimeMs?: number | null;
  savedAt: number;
}

/** Validates an autosave record without trusting JSON shapes read from disk. */
export function parseCrashRecovery(raw: string): ParsedCrashRecovery | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record['content'] !== 'string') return null;

    return {
      path: typeof record['path'] === 'string' ? record['path'] : null,
      content: record['content'],
      ...(record['eol'] === 'lf' || record['eol'] === 'crlf' ? { eol: record['eol'] } : {}),
      ...(typeof record['mtimeMs'] === 'number' || record['mtimeMs'] === null
        ? { mtimeMs: record['mtimeMs'] }
        : {}),
      savedAt: typeof record['savedAt'] === 'number' ? record['savedAt'] : 0,
    };
  } catch {
    return null;
  }
}
