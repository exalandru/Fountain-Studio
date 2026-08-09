import type { PdfExportOptions } from '@shared/ipc-contract.js';
import { PDF_BASELINE_ERROR, type PdfBaselineErrorCode } from '@shared/pdf/index.js';
import { parse } from '@shared/fountain/index.js';
import { assertDocumentGranted } from '../files/document-grants.js';
import { listSnapshots, readSnapshot } from '../files/snapshots.js';

export class PdfBaselineError extends Error {
  constructor(readonly code: PdfBaselineErrorCode) {
    super(code);
    this.name = 'PdfBaselineError';
  }
}

function lineCount(source: string): number {
  return source.length === 0 ? 0 : source.split(/\r?\n/).length;
}

/** Re-resolves the exact snapshot and rejects missing, modified or metadata-corrupt content. */
export async function validatePdfRevisionBaseline(options: PdfExportOptions): Promise<void> {
  const reference = options.revision?.baseline;
  if (!reference) return;

  assertDocumentGranted(reference.path);

  const meta = (await listSnapshots(reference.path)).find(
    (candidate) => candidate.id === reference.snapshotId,
  );
  if (!meta) throw new PdfBaselineError(PDF_BASELINE_ERROR.unavailable);

  let current: string;
  try {
    current = await readSnapshot(reference.path, reference.snapshotId);
  } catch {
    throw new PdfBaselineError(PDF_BASELINE_ERROR.unavailable);
  }

  if (
    new TextEncoder().encode(current).byteLength !== meta.byteLength ||
    lineCount(current) !== meta.lineCount ||
    parse(current).scenes.length !== meta.sceneCount
  ) {
    throw new PdfBaselineError(PDF_BASELINE_ERROR.corrupt);
  }
  if (current !== reference.source) {
    throw new PdfBaselineError(PDF_BASELINE_ERROR.changed);
  }
}
