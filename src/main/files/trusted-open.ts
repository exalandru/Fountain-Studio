/**
 * Trusted document open (M4.1).
 *
 * Grant creation is reserved for main-process authorities (native dialogs, OS/CLI,
 * confirmed drops, recovery). Opening already-granted paths never elevates a new path.
 */

import { basename } from 'node:path';
import { dialog } from 'electron';
import type { DocumentSnapshot } from '@shared/ipc-contract.js';
import {
  formatOpenByteLimit,
  MAX_OPEN_BATCH_BYTES,
  MAX_OPEN_FILE_BYTES,
  MAX_OPEN_PATHS,
} from '@shared/documents/limits.js';
import { DocumentOpenError, openDocumentPaths } from './document.js';
import { assertDocumentGranted, grantDocumentPath, isDocumentGranted } from './document-grants.js';
import { addRecent, getTranslator } from '../store.js';

function openErrorDetail(t: Awaited<ReturnType<typeof getTranslator>>['t'], error: Error): string {
  if (error instanceof DocumentOpenError) {
    switch (error.code) {
      case 'tooLarge':
        return t('dialog.openError.tooLarge', { limit: formatOpenByteLimit(MAX_OPEN_FILE_BYTES) });
      case 'notRegularFile':
        return t('dialog.openError.notRegularFile');
      case 'unstable':
        return t('dialog.openError.unstable');
      case 'tooManyFiles':
        return t('dialog.openError.tooManyFiles', { count: String(MAX_OPEN_PATHS) });
      case 'batchTooLarge':
        return t('dialog.openError.batchTooLarge', {
          limit: formatOpenByteLimit(MAX_OPEN_BATCH_BYTES),
        });
    }
  }
  return error.message;
}

async function reportOpenOutcome(
  outcome: Awaited<ReturnType<typeof openDocumentPaths>>,
): Promise<DocumentSnapshot[]> {
  const { t } = await getTranslator();

  for (const failure of outcome.failures) {
    dialog.showErrorBox(
      t('dialog.openError.title'),
      t('dialog.openError.body', {
        name: basename(failure.path),
        error: openErrorDetail(t, failure.error),
      }),
    );
  }

  if (outcome.batchError) {
    dialog.showErrorBox(t('dialog.openError.title'), openErrorDetail(t, outcome.batchError));
    return [];
  }

  return outcome.documents;
}

/**
 * Open paths from a trusted main-process source. Grants only paths that actually
 * open successfully (M2 failures never remain granted).
 *
 * Callers that own the native menu should rebuild it when documents are returned.
 */
export async function openTrustedDocumentPaths(paths: string[]): Promise<DocumentSnapshot[]> {
  const { t } = await getTranslator();

  let outcome;
  try {
    outcome = await openDocumentPaths(paths);
  } catch (error) {
    const detail =
      error instanceof Error
        ? openErrorDetail(t, error)
        : t('dialog.openError.tooManyFiles', { count: String(MAX_OPEN_PATHS) });
    dialog.showErrorBox(t('dialog.openError.title'), detail);
    return [];
  }

  const documents = await reportOpenOutcome(outcome);
  for (const snapshot of documents) {
    if (snapshot.path) {
      grantDocumentPath(snapshot.path);
      await addRecent(snapshot.path);
    }
  }
  return documents;
}

/**
 * Re-open paths that are already granted. Never creates grants — a renderer-supplied
 * absolute path cannot elevate itself through this entry point.
 */
export async function openGrantedDocumentPaths(paths: string[]): Promise<DocumentSnapshot[]> {
  for (const path of paths) {
    assertDocumentGranted(path);
  }

  const { t } = await getTranslator();
  let outcome;
  try {
    outcome = await openDocumentPaths(paths);
  } catch (error) {
    const detail =
      error instanceof Error
        ? openErrorDetail(t, error)
        : t('dialog.openError.tooManyFiles', { count: String(MAX_OPEN_PATHS) });
    dialog.showErrorBox(t('dialog.openError.title'), detail);
    return [];
  }

  const documents = await reportOpenOutcome(outcome);
  for (const snapshot of documents) {
    if (snapshot.path && isDocumentGranted(snapshot.path)) {
      await addRecent(snapshot.path);
    }
  }
  return documents;
}

/**
 * Drag/drop open: native confirmation is required before any grant is created.
 * A cancelled dialog must not elevate the proposed paths.
 */
export async function confirmAndOpenDroppedPaths(
  paths: string[],
  ask: (unique: string[]) => Promise<boolean>,
): Promise<DocumentSnapshot[]> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return [];
  if (!(await ask(unique))) return [];
  return openTrustedDocumentPaths(unique);
}
