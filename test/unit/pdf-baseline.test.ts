import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PdfExportOptions } from '../../src/shared/ipc-contract.js';
import { snapshotDirectory, snapshotFileName } from '../../src/shared/snapshots/index.js';
import { grantDocumentPath, resetDocumentGrants } from '../../src/main/files/document-grants.js';
import { createSnapshot, listSnapshots } from '../../src/main/files/snapshots.js';
import { validatePdfRevisionBaseline } from '../../src/main/pdf/baseline.js';

afterEach(() => {
  resetDocumentGrants();
});

const ordinary: PdfExportOptions = {
  format: 'a4',
  sceneNumbers: 'both',
  includeNotes: false,
  includeSynopses: false,
  headingsBold: true,
  watermark: '',
  pageFrom: null,
  pageTo: null,
  revision: null,
};

async function fixture(content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'fountain-pdf-baseline-'));
  const path = join(directory, 'script.fountain');
  await writeFile(path, content, 'utf8');
  grantDocumentPath(path);
  const [meta] = await createSnapshot(path, 'Locked draft', content);
  if (!meta) throw new Error('Missing snapshot fixture');
  const options: PdfExportOptions = {
    ...ordinary,
    revision: {
      baseline: { path, snapshotId: meta.id, source: content },
      header: 'BLUE REVISION',
      colour: 'blue',
      colourMode: 'header',
      marks: true,
      lockedPages: true,
      onlyRevisedPages: false,
    },
  };
  return { meta, options, path };
}

describe('PDF production baseline validation', () => {
  it('does not require a baseline for an ordinary export', async () => {
    await expect(validatePdfRevisionBaseline(ordinary)).resolves.toBeUndefined();
  });

  it('accepts an empty snapshot as a validated baseline', async () => {
    const { options } = await fixture('');
    await expect(validatePdfRevisionBaseline(options)).resolves.toBeUndefined();
  });

  it('rejects a missing referenced snapshot', async () => {
    const { options } = await fixture('INT. A - DAY\n');
    if (options.revision) options.revision.baseline.snapshotId = 'snap-missing';
    await expect(validatePdfRevisionBaseline(options)).rejects.toThrow(
      'PDF_REVISION_BASELINE_UNAVAILABLE',
    );
  });

  it('rejects snapshot content that no longer matches its metadata', async () => {
    const { meta, options, path } = await fixture('INT. A - DAY\n');
    const [listed] = await listSnapshots(path);
    if (!listed) throw new Error('Missing listed snapshot');
    await writeFile(
      join(snapshotDirectory(path), snapshotFileName(listed)),
      'CORRUPTED SNAPSHOT CONTENT',
      'utf8',
    );

    expect(listed.id).toBe(meta.id);
    await expect(validatePdfRevisionBaseline(options)).rejects.toThrow(
      'PDF_REVISION_BASELINE_CORRUPT',
    );
  });

  it('rejects cached content that differs from the current validated snapshot', async () => {
    const { options } = await fixture('INT. A - DAY\n');
    if (options.revision) options.revision.baseline.source = 'INT. B - NIGHT\n';
    await expect(validatePdfRevisionBaseline(options)).rejects.toThrow(
      'PDF_REVISION_BASELINE_CHANGED',
    );
  });

  it('rejects a revision baseline for an ungranted screenplay path', async () => {
    const { options, path } = await fixture('INT. LAB - NIGHT\n\nLocked.\n');
    resetDocumentGrants();
    await expect(validatePdfRevisionBaseline(options)).rejects.toThrow(/not granted/i);
    grantDocumentPath(path);
    await expect(validatePdfRevisionBaseline(options)).resolves.toBeUndefined();
  });
});
