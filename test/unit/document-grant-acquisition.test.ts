import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBible } from '../../src/shared/bible/index.js';
import { createDefaultAppData } from '../../src/shared/appdata/index.js';
import { MAX_OPEN_FILE_BYTES } from '../../src/shared/documents/limits.js';
import {
  assertDocumentGranted,
  assertSaveAsDestinationAllowed,
  DocumentGrantError,
  grantDocumentPath,
  isDocumentGranted,
  reserveSaveAsDestination,
  resetDocumentGrants,
} from '../../src/main/files/document-grants.js';
import {
  grantedAppDataWrite,
  grantedBibleWrite,
  grantedSnapshotCreate,
} from '../../src/main/files/document-ops.js';
import {
  openGrantedDocumentPaths,
  openTrustedDocumentPaths,
  confirmAndOpenDroppedPaths,
} from '../../src/main/files/trusted-open.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

vi.mock('electron', () => ({
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  app: {
    getPath: () => tmpdir(),
    addRecentDocument: vi.fn(),
  },
}));

vi.mock('../../src/main/store.js', () => ({
  addRecent: vi.fn(async () => undefined),
  getTranslator: async () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (!params) return key;
      return Object.entries(params).reduce(
        (message, [name, value]) => message.replace(`{${name}}`, String(value)),
        key,
      );
    },
  }),
}));

vi.mock('../../src/main/menu.js', () => ({
  buildMenu: vi.fn(async () => undefined),
}));

/**
 * M4.1 — document grants must not be creatable from renderer-supplied paths alone.
 */

describe('trusted grant acquisition (M4.1)', () => {
  let root: string;
  let screenplay: string;

  beforeEach(async () => {
    resetDocumentGrants();
    root = await mkdtemp(join(tmpdir(), 'm41-'));
    screenplay = join(root, 'story.fountain');
    await writeFile(screenplay, 'INT. LAB - DAY\n\nHello.\n', 'utf8');
  });

  afterEach(() => {
    resetDocumentGrants();
  });

  it('A — openGrantedDocumentPaths refuses an arbitrary ungranted path (no self-grant)', async () => {
    await expect(openGrantedDocumentPaths([screenplay])).rejects.toThrow(DocumentGrantError);
    expect(isDocumentGranted(screenplay)).toBe(false);
    await expect(grantedBibleWrite(screenplay, createBible())).rejects.toThrow(DocumentGrantError);
    await expect(grantedAppDataWrite(screenplay, createDefaultAppData())).rejects.toThrow(
      DocumentGrantError,
    );
    await expect(grantedSnapshotCreate(screenplay, 'x', 'INT. LAB - DAY\n')).rejects.toThrow(
      DocumentGrantError,
    );
  });

  it('B — openTrustedDocumentPaths grants only after a successful open', async () => {
    const documents = await openTrustedDocumentPaths([screenplay]);
    expect(documents).toHaveLength(1);
    expect(isDocumentGranted(screenplay)).toBe(true);
    await expect(grantedBibleWrite(screenplay, createBible())).resolves.toBeTruthy();
  });

  it('M2 — rejected oversized open does not leave a grant', async () => {
    const huge = join(root, 'huge.fountain');
    await writeFile(huge, 'x'.repeat(MAX_OPEN_FILE_BYTES + 1), 'utf8');
    const documents = await openTrustedDocumentPaths([huge]);
    expect(documents).toEqual([]);
    expect(isDocumentGranted(huge)).toBe(false);
  });

  it('F — Save As destination substitution is refused without a dialog reservation', () => {
    grantDocumentPath(screenplay);
    const attacker = join(root, 'attacker.fountain');
    grantDocumentPath(attacker);
    expect(() => assertSaveAsDestinationAllowed(screenplay, attacker)).toThrow(DocumentGrantError);

    reserveSaveAsDestination(attacker);
    expect(() => assertSaveAsDestinationAllowed(screenplay, attacker)).not.toThrow();
  });

  it('E — recovery-style grant requires a prior trusted grant before autosave metadata', () => {
    // autosave:write asserts grant; planting an arbitrary path without trust fails here.
    expect(() => assertDocumentGranted(join(root, 'forged.fountain'))).toThrow(DocumentGrantError);
  });

  it('openGrantedDocumentPaths can reopen an already trusted path without elevating others', async () => {
    await openTrustedDocumentPaths([screenplay]);
    const foreign = join(root, 'foreign.fountain');
    await writeFile(foreign, 'INT. OTHER - DAY\n\nNo.\n', 'utf8');

    await expect(openGrantedDocumentPaths([foreign])).rejects.toThrow(DocumentGrantError);
    const again = await openGrantedDocumentPaths([screenplay]);
    expect(again).toHaveLength(1);
    expect(isDocumentGranted(foreign)).toBe(false);
  });

  it('binds file:openPaths to openGrantedDocumentPaths in ipc source (not trusted open)', async () => {
    const ipcSource = await readFile(
      fileURLToPath(new URL('../../src/main/ipc.ts', import.meta.url)),
      'utf8',
    );
    const handler = ipcSource.slice(ipcSource.indexOf("handle('file:openPaths'"));
    const end = handler.indexOf("handle('file:openDropped'");
    const body = end === -1 ? handler.slice(0, 400) : handler.slice(0, end);
    expect(body).toContain('openGrantedDocumentPaths');
    expect(body).not.toContain('openTrustedDocumentPaths');
  });

  it('cancelled drop confirmation does not create a grant', async () => {
    const documents = await confirmAndOpenDroppedPaths([screenplay], async () => false);
    expect(documents).toEqual([]);
    expect(isDocumentGranted(screenplay)).toBe(false);
  });

  it('accepted drop confirmation grants after trusted open', async () => {
    const documents = await confirmAndOpenDroppedPaths([screenplay], async () => true);
    expect(documents).toHaveLength(1);
    expect(isDocumentGranted(screenplay)).toBe(true);
  });
});
