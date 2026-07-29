import { create } from 'zustand';
import type { AppData } from '@shared/appdata/index.js';
import { createDefaultAppData } from '@shared/appdata/index.js';
import { refuseRecoveredExistingFile, resolveSavedRevision } from '@shared/documents/index.js';
import type { AppSettings, DocumentSnapshot, Eol } from '@shared/ipc-contract.js';
import { DEFAULT_SETTINGS } from '@shared/ipc-contract.js';

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
   * edit happened while the write was in flight.
   */
  markSaved: (id: string, path: string, mtimeMs: number, savedRevision: number) => boolean;
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

    set((state) => {
      const documents = [...state.documents];

      for (const snapshot of snapshots) {
        if (snapshot.path === null) continue;

        // A file already open is not duplicated: its tab is reactivated instead.
        const existing = documents.find((d) => d.path === snapshot.path);
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

  markSaved(id, path, mtimeMs, savedRevision) {
    let fullySaved = false;
    set((state) => ({
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
                dirty: decision.dirty,
                refuseExistingOnSave: false,
              };
            })()
          : document,
      ),
    }));
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
