/**
 * Main-process document path grants (M4 / M4.1).
 *
 * Type-2 document operations succeed only when the screenplay path was granted by a
 * trusted main-process source (native Open/Save As dialogs, OS/CLI open, confirmed
 * drop, or recovery of a previously authorised path). Renderer-supplied absolute paths
 * via `file:openPaths` never create grants.
 *
 * Paths stay absolute screenplay paths (same identity as H2.1). Sidecar locations are
 * derived by the filesystem helpers from that granted path.
 */

import {
  comparableDocumentPath,
  detectPathPlatform,
  type PathPlatform,
} from '@shared/documents/paths.js';

export class DocumentGrantError extends Error {
  constructor(message = 'Document path is not granted') {
    super(message);
    this.name = 'DocumentGrantError';
  }
}

const grants = new Set<string>();
let platform: PathPlatform = detectPathPlatform();

function keyFor(path: string): string {
  return comparableDocumentPath(path, platform);
}

/** Test-only: pin the comparison platform (darwin vs linux case rules). */
export function setDocumentGrantPlatform(next: PathPlatform): void {
  platform = next;
}

/** Test-only: clear every grant between isolated cases. */
export function resetDocumentGrants(): void {
  grants.clear();
  pendingSaveAsDestinations.clear();
}

export function isDocumentGranted(path: string): boolean {
  return grants.has(keyFor(path));
}

export function grantDocumentPath(path: string): void {
  const normalized = path.trim();
  if (!normalized) return;
  grants.add(keyFor(normalized));
}

export function revokeDocumentPath(path: string): void {
  grants.delete(keyFor(path));
}

/** After Save As A → B: B is authoritative; A must not keep write authority. */
export function transferDocumentGrant(fromPath: string | null, toPath: string): void {
  grantDocumentPath(toPath);
  if (fromPath !== null && keyFor(fromPath) !== keyFor(toPath)) {
    revokeDocumentPath(fromPath);
  }
}

/** Destinations reserved by a native Save As dialog until consumed or superseded. */
const pendingSaveAsDestinations = new Set<string>();

export function reserveSaveAsDestination(path: string): void {
  const normalized = path.trim();
  if (!normalized) return;
  grantDocumentPath(normalized);
  pendingSaveAsDestinations.add(keyFor(normalized));
}

export function isSaveAsDestinationReserved(path: string): boolean {
  return pendingSaveAsDestinations.has(keyFor(path));
}

export function consumeSaveAsDestination(path: string): void {
  pendingSaveAsDestinations.delete(keyFor(path));
}

export function assertSaveAsDestinationAllowed(
  sourcePath: string | null,
  destinationPath: string,
): void {
  assertDocumentGranted(destinationPath);
  if (sourcePath !== null && keyFor(sourcePath) === keyFor(destinationPath)) return;
  if (!isSaveAsDestinationReserved(destinationPath)) {
    throw new DocumentGrantError(
      `Save As destination was not reserved by a native dialog: ${destinationPath}`,
    );
  }
}

export function assertDocumentGranted(path: string): void {
  if (!isDocumentGranted(path)) {
    throw new DocumentGrantError(`Document path is not granted: ${path}`);
  }
}

/**
 * Main-process-only hooks for E2E. The renderer cannot reach these globals;
 * Playwright's `app.evaluate` runs in the main process. Packaged builds omit them.
 */
export function installDocumentGrantTestHook(enabled = true): void {
  const target = globalThis as typeof globalThis & {
    __fountainGrantDocumentPath?: typeof grantDocumentPath;
    __fountainReserveSaveAsDestination?: typeof reserveSaveAsDestination;
  };
  if (enabled) {
    target.__fountainGrantDocumentPath = grantDocumentPath;
    target.__fountainReserveSaveAsDestination = reserveSaveAsDestination;
  } else {
    delete target.__fountainGrantDocumentPath;
    delete target.__fountainReserveSaveAsDestination;
  }
}

/** Test-only: clear Save As reservations between isolated cases. */
export function resetPendingSaveAsDestinations(): void {
  pendingSaveAsDestinations.clear();
}
