import { create } from 'zustand';
import type { AppData } from '@shared/appdata/index.js';
import { createDefaultAppData } from '@shared/appdata/index.js';
import {
  detectPathPlatform,
  documentPathsEqual,
  findDocumentByPath,
  refuseRecoveredExistingFile,
  resolveSavedRevision,
  type PathPlatform,
} from '@shared/documents/index.js';
import type { AppSettings, DocumentSnapshot, Eol, SaveOutcome } from '@shared/ipc-contract.js';
import { DEFAULT_SETTINGS } from '@shared/ipc-contract.js';

function hostPlatform(): PathPlatform {
  // No DOM dependency: this store also ships in Node-only test projects.
  const runtime = globalThis as typeof globalThis & {
    window?: { quantum?: { platform?: string } };
  };
  const platform = runtime.window?.quantum?.platform;
  if (typeof platform === 'string') return platform;
  return detectPathPlatform();
}

/**
 * State of the open documents.
 *
 * The renderer is the sole owner of the text being edited; the main process only reads
 * and writes files. Each tab carries its own `revision`, which lets us discard parser
 * responses that arrive after a more recent keystroke.
 */

export interface OpenDocument {
  id: string;
  path: string | null;
  name: string;
  content: string;
  eol: Eol;
  mtimeMs: number | null;
  /**
   * Fingerprint (SHA-256) of the disk version this session is based on (H3).
   * `null` for documents without a filesystem base (new, or crash-recovered).
   * Never updated by a failed save: a conflict leaves it pointing at the old base.
   */
  fileHash: string | null;
  dirty: boolean;
  /** Incremented on every change — used to drop stale analyses. */
  revision: number;
  /**
   * A recovered legacy snapshot had no recorded disk mtime. Its original path must not
   * be overwritten until the author explicitly confirms it through Save As.
   */
  refuseExistingOnSave: boolean;
  /** Per-screenplay UI metadata persisted in the companion file. */
  appData: AppData;
  /** Zero after loading, incremented only by local UI changes. */
  appDataRevision: number;
}

/** Localised strings the store needs; supplied by the caller, which owns the translator. */
export interface NewDocumentStrings {
  /** Tab name for a document that has never been saved. */
  untitled: string;
  /** Value of the Fountain `Title:` field in the starter template. */
  titleValue: string;
  /** Value of the Fountain `Credit:` field in the starter template. */
  creditValue: string;
  /** Tab name for a document recovered after a crash. */
  recovered: string;
}

interface DocumentsState {
  documents: OpenDocument[];
  activeId: string | null;
  settings: AppSettings;

  active: () => OpenDocument | null;
  newDocument: (strings: NewDocumentStrings) => string;
  adopt: (snapshots: DocumentSnapshot[]) => string | null;
  restore: (
    path: string | null,
    content: string,
    strings: NewDocumentStrings,
    eol?: Eol,
    mtimeMs?: number | null,
    recoveryId?: string,
  ) => string;
  setContent: (id: string, content: string) => void;
  setAppData: (id: string, appData: AppData, changed?: boolean) => void;
  /**
   * Commits the metadata of a completed disk write. Returns true only when no newer
   * edit happened while the write was in flight. Never called for a conflicted save:
   * the previous `fileHash` remains the base, so the next save detects the conflict
   * again (H3 / H6 — a conflict never acknowledges dirty or pending state).
   */
  markSaved: (
    id: string,
    path: string,
    mtimeMs: number,
    savedRevision: number,
    fileHash: string,
  ) => boolean;
  setActive: (id: string) => void;
  close: (id: string) => void;
  setSettings: (settings: AppSettings) => void;
}

/**
 * Starter template for a new screenplay.
 *
 * The title-page keys (`Title:`, `Credit:`, `Author:`) are Fountain syntax and stay in
 * English in every locale; only their values are translated.
 */
function newDocumentTemplate(strings: NewDocumentStrings): string {
  return [
    `Title: ${strings.titleValue}`,
    `Credit: ${strings.creditValue}`,
    'Author:',
    'Draft date:',
    '',
    'INT. ',
  ].join('\n');
}

function nameFromPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function newId(): string {
  return crypto.randomUUID();
}

export interface SaveFingerprintCommit {
  id: string;
  path: string;
  mtimeMs: number;
  savedRevision: number;
  fileHash: string;
}

/**
 * Only a `saved` outcome may advance the session's filesystem base. Anything else
 * (conflict, error, cancelled) yields `null`, so the previous fingerprint stays as
 * the base and the next Save detects the same conflict again (H3.6).
 *
 * Extracted from the hook so the renderer wiring is unit-testable: a witness that
 * a conflict can never reach `markSaved` with a newer fingerprint.
 */
export function saveFingerprintCommit(
  outcome: SaveOutcome,
  id: string,
  savedRevision: number,
): SaveFingerprintCommit | null {
  return outcome.status === 'saved'
    ? {
        id,
        path: outcome.path,
        mtimeMs: outcome.mtimeMs,
        savedRevision,
        fileHash: outcome.hash,
      }
    : null;
}

export const useDocuments = create<DocumentsState>((set, get) => ({
  documents: [],
  activeId: null,
  settings: { ...DEFAULT_SETTINGS },

  active() {
    const { documents, activeId } = get();
    return documents.find((d) => d.id === activeId) ?? null;
  },

  newDocument(strings) {
    const id = newId();
    const document: OpenDocument = {
      id,
      path: null,
      name: strings.untitled,
      content: newDocumentTemplate(strings),
      eol: 'lf',
      mtimeMs: null,
      fileHash: null,
      dirty: false,
      revision: 0,
      refuseExistingOnSave: false,
      appData: createDefaultAppData(),
      appDataRevision: 0,
    };
    set((state) => ({ documents: [...state.documents, document], activeId: id }));
    return id;
  },

  adopt(snapshots) {
    if (snapshots.length === 0) return null;
    let lastId: string | null = null;
    const platform = hostPlatform();

    set((state) => {
      const documents = [...state.documents];

      for (const snapshot of snapshots) {
        if (snapshot.path === null) continue;

        // Equivalent paths share one open owner: reactivate that tab instead of duplicating.
        const existing = findDocumentByPath(documents, snapshot.path, platform);
        if (existing) {
          lastId = existing.id;
          continue;
        }

        const id = newId();
        lastId = id;
        documents.push({
          id,
          path: snapshot.path,
          name: nameFromPath(snapshot.path),
          content: snapshot.content,
          eol: snapshot.eol,
          mtimeMs: snapshot.mtimeMs,
          fileHash: snapshot.hash,
          dirty: false,
          revision: 0,
          refuseExistingOnSave: false,
          appData: createDefaultAppData(),
          appDataRevision: 0,
        });
      }

      return { documents, activeId: lastId ?? state.activeId };
    });

    return lastId;
  },

  /**
   * Reopens content recovered after an abrupt shutdown.
   *
   * New snapshots carry their last known mtime and therefore retain external-change
   * detection. Legacy snapshots do not; for those, saving to an existing original path
   * is refused until the author explicitly chooses Save As.
   */
  restore(path, content, strings, eol = 'lf', mtimeMs, recoveryId) {
    if (path !== null) {
      const existing = findDocumentByPath(get().documents, path, hostPlatform());
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
    }

    const id = recoveryId ?? newId();
    set((state) => ({
      documents: [
        ...state.documents,
        {
          id,
          path,
          name: path === null ? strings.recovered : nameFromPath(path),
          content,
          eol,
          mtimeMs: mtimeMs ?? null,
          // Recovery records predate fingerprints: mtime is the legacy authority.
          fileHash: null,
          dirty: true,
          revision: 0,
          refuseExistingOnSave: refuseRecoveredExistingFile(path, mtimeMs),
          appData: createDefaultAppData(),
          appDataRevision: 0,
        },
      ],
      activeId: state.activeId ?? id,
    }));
    return id;
  },

  setContent(id, content) {
    set((state) => ({
      documents: state.documents.map((document) =>
        document.id === id
          ? {
              ...document,
              content,
              dirty: true,
              revision: document.revision + 1,
            }
          : document,
      ),
    }));
  },

  setAppData(id, appData, changed = false) {
    set((state) => ({
      documents: state.documents.map((document) =>
        document.id === id
          ? {
              ...document,
              appData,
              appDataRevision: changed ? document.appDataRevision + 1 : document.appDataRevision,
            }
          : document,
      ),
    }));
  },

  markSaved(id, path, mtimeMs, savedRevision, fileHash) {
    let fullySaved = false;
    const platform = hostPlatform();
    set((state) => {
      const conflict = state.documents.find(
        (document) =>
          document.id !== id &&
          document.path !== null &&
          documentPathsEqual(document.path, path, platform),
      );
      // Fail closed: never let two open documents own the same path identity.
      if (conflict) return state;

      return {
        documents: state.documents.map((document) =>
          document.id === id
            ? (() => {
                const decision = resolveSavedRevision(
                  document.revision,
                  savedRevision,
                  document.dirty,
                );
                fullySaved = decision.fullySaved;
                return {
                  ...document,
                  path,
                  name: nameFromPath(path),
                  mtimeMs,
                  fileHash,
                  dirty: decision.dirty,
                  refuseExistingOnSave: false,
                };
              })()
            : document,
        ),
      };
    });
    return fullySaved;
  },

  setActive(id) {
    set({ activeId: id });
  },

  close(id) {
    set((state) => {
      const index = state.documents.findIndex((d) => d.id === id);
      const documents = state.documents.filter((d) => d.id !== id);

      // Activate the neighbouring tab, preferring the one on the right — the behaviour
      // every tabbed editor has.
      let activeId = state.activeId;
      if (state.activeId === id) {
        const neighbour = documents[index] ?? documents[index - 1] ?? null;
        activeId = neighbour?.id ?? null;
      }

      return { documents, activeId };
    });
  },

  setSettings(settings) {
    set({ settings });
  },
}));
