import type { Locale } from './i18n/index.js';
import type { AppData } from './appdata/index.js';
import type {
  AiChatRequest,
  AiConfig,
  AiConfigView,
  AiConnectionProfile,
  AiErrorCode,
  AiKeyUpdate,
} from './ai/index.js';

/**
 * Single IPC contract between the main process and the renderer.
 *
 * All communication goes through these types: the preload exposes an API derived from
 * `IpcRequests` / `IpcEvents`, and the main process registers its handlers under the
 * same keys. Adding a channel here is the only way to add one — no hand-written
 * `ipcRenderer.invoke` string buried in a component.
 */

/** Original line ending of the file, restored on write. */
export type Eol = 'lf' | 'crlf';

export interface DocumentSnapshot {
  /** Absolute path, or `null` for a document that has never been saved. */
  path: string | null;
  /** Content normalised to LF. The original line ending is kept in `eol`. */
  content: string;
  eol: Eol;
  /** Modification time of the file when read, used to detect external changes. */
  mtimeMs: number | null;
}

export interface SaveRequest {
  path: string;
  content: string;
  eol: Eol;
  /** mtime known to the renderer; the main process refuses to overwrite a changed file. */
  expectedMtimeMs: number | null;
  /**
   * Refuse an existing target when its previous state is unknown.
   *
   * This is used for legacy crash-recovery snapshots that predate persisted mtimes.
   * A native Save As confirmation is the explicit escape hatch.
   */
  refuseExisting?: boolean;
}

export type SaveOutcome =
  | { status: 'saved'; path: string; mtimeMs: number }
  | { status: 'cancelled' }
  | { status: 'conflict'; path: string; mtimeMs: number }
  | { status: 'error'; message: string };

export type ExportOutcome =
  | { status: 'exported'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface PdfExportOptions {
  format: 'letter' | 'a4';
  sceneNumbers: 'none' | 'left' | 'right' | 'both';
  includeNotes: boolean;
  includeSynopses: boolean;
  headingsBold: boolean;
  watermark: string;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface PdfRenderRequest {
  source: string;
  options: PdfExportOptions;
}

export interface RecentFile {
  path: string;
  name: string;
  /** Time the file was opened, in epoch milliseconds. */
  openedAt: number;
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  editorFontSize: number;
  /** Autosave interval in seconds; 0 disables it. */
  autosaveSeconds: number;
  /** Number of `.bak` files kept per document. */
  backupCount: number;
  /** Estimated screenplay minutes represented by one formatted page. */
  minutesPerPage: number;
  showNotes: boolean;
  showBoneyard: boolean;
  showSynopses: boolean;
  showSections: boolean;
  /** Show the computed scene number on both sides of headings in editor and preview. */
  showSceneNumbers: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  /** Hide Fountain control markers while preserving the plain-text source. */
  formattedMode: boolean;
  /** Electron supports one active spell-check language on macOS. */
  spellcheckLanguage: 'en-US' | 'fr';
  /** Interface language. English is the fallback for every unknown locale. */
  language: Locale;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  editorFontSize: 15,
  autosaveSeconds: 30,
  backupCount: 3,
  minutesPerPage: 1,
  showNotes: true,
  showBoneyard: true,
  showSynopses: true,
  showSections: true,
  showSceneNumbers: true,
  focusMode: false,
  typewriterMode: false,
  formattedMode: false,
  spellcheckLanguage: 'en-US',
  language: 'en',
};

/** Document recovered after an abrupt shutdown. */
export interface CrashRecovery {
  /** Autosave file identifier; retained so dismissing recovery deletes the right file. */
  id: string;
  path: string | null;
  content: string;
  /** Original line ending and last known disk state, when recorded by a recent build. */
  eol?: Eol;
  mtimeMs?: number | null;
  savedAt: number;
}

/** Requests from renderer to main. Each key gives the argument and result types. */
export interface IpcRequests {
  'dialog:pickOpen': { arg: void; result: DocumentSnapshot[] };
  'dialog:pickSaveAs': { arg: { suggestedName: string }; result: string | null };
  'dialog:confirmDiscard': { arg: { name: string }; result: 'save' | 'discard' | 'cancel' };

  'file:openPaths': { arg: { paths: string[] }; result: DocumentSnapshot[] };
  'file:save': { arg: SaveRequest; result: SaveOutcome };
  'file:exportText': {
    arg: { suggestedName: string; content: string; format: 'csv' | 'json' };
    result: ExportOutcome;
  };
  'pdf:render': {
    arg: PdfRenderRequest;
    result: { bytes: ArrayBuffer; pageCount: number };
  };
  'pdf:export': {
    arg: PdfRenderRequest & { suggestedName: string };
    result: ExportOutcome;
  };

  'settings:get': { arg: void; result: AppSettings };
  'settings:patch': { arg: Partial<AppSettings>; result: AppSettings };
  'ai:config:get': { arg: void; result: AiConfigView };
  'ai:config:save': {
    arg: { config: AiConfig; keyUpdates: AiKeyUpdate[] };
    result: AiConfigView;
  };
  'ai:models:list': {
    arg: { profile: AiConnectionProfile; apiKey: string | null };
    result: string[];
  };
  'ai:connection:test': {
    arg: { profile: AiConnectionProfile; apiKey: string | null };
    result: { latencyMs: number; model: string };
  };
  'ai:chat:start': { arg: AiChatRequest; result: void };
  'ai:chat:cancel': { arg: { requestId: string }; result: boolean };

  'autosave:write': {
    arg: {
      id: string;
      path: string | null;
      content: string;
      eol: Eol;
      mtimeMs: number | null;
    };
    result: void;
  };
  'autosave:clear': { arg: { id: string }; result: void };
  'autosave:pending': { arg: void; result: CrashRecovery[] };

  'window:setDirty': { arg: { dirty: boolean; name: string }; result: void };
  /** Completes the close handshake initiated by `app:willQuit`. */
  'window:closeDecision': { arg: { proceed: boolean }; result: void };
  /** Companion file: read/write versioned metadata alongside the screenplay. */
  'appdata:read': { arg: { path: string }; result: AppData | null };
  'appdata:write': { arg: { path: string; data: AppData }; result: void };
}

/** Events from main to renderer. */
export interface IpcEvents {
  /** The OS or the menu asks to open files (double-click, dock drop, recent item). */
  'app:openFiles':
    { paths: string[]; snapshots?: never } | { paths?: never; snapshots: DocumentSnapshot[] };
  /** A menu command for the renderer to run (new, save, find…). */
  'menu:command': { command: MenuCommand };
  /** The OS colour scheme changed. */
  'app:themeChanged': { dark: boolean };
  /**
   * Settings were changed from the main process — currently only the language, via the
   * native menu. The renderer refreshes its copy instead of polling.
   */
  'app:settingsChanged': { settings: AppSettings };
  /** The provider is streaming hidden reasoning before its visible answer. */
  'ai:reasoning': { requestId: string };
  'ai:chunk': { requestId: string; chunk: string };
  'ai:done': { requestId: string; reasoningUsed: boolean };
  'ai:error': { requestId: string; code: AiErrorCode; message: string };
  /** The application is about to quit; the renderer should report unsaved state. */
  'app:willQuit': { reason: 'quit' | 'closeWindow' };
}

export type MenuCommand =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.exportPdf'
  | 'file.closeTab'
  | 'edit.find'
  | 'edit.replace'
  | 'view.toggleNotes'
  | 'view.toggleBoneyard'
  | 'view.toggleSynopses'
  | 'view.toggleSections'
  | 'view.toggleSceneNumbers'
  | 'view.increaseFont'
  | 'view.decreaseFont'
  | 'view.toggleTimeline'
  | 'view.toggleFocus'
  | 'view.toggleTypewriter'
  | 'view.toggleFormattedMode'
  | 'view.commandPalette'
  | 'ai.openSettings'
  | 'ai.synonyms'
  | 'ai.rewrite'
  | 'ai.renameCharacter'
  | 'ai.openInconsistencies'
  | 'scene.renumber'
  | 'help.about';

export type IpcChannel = keyof IpcRequests;
export type IpcEventChannel = keyof IpcEvents;

/** Shape of the API the preload exposes to the renderer. */
export type RendererApi = {
  invoke<C extends IpcChannel>(
    channel: C,
    arg: IpcRequests[C]['arg'],
  ): Promise<IpcRequests[C]['result']>;
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEvents[C]) => void): () => void;
  /**
   * Real path of a file dropped onto the window.
   *
   * `File.path`, the old shortcut, has been removed from Electron: only `webUtils` can
   * still resolve a disk path, and only from the preload. Returns an empty string when
   * the file does not come from the file system.
   */
  getPathForFile(file: File): string;
  readonly platform: 'darwin' | 'win32' | 'linux';
};
