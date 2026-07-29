import type { Locale } from './i18n/index.js';

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
}

export type SaveOutcome =
  | { status: 'saved'; path: string; mtimeMs: number }
  | { status: 'cancelled' }
  | { status: 'conflict'; path: string; mtimeMs: number }
  | { status: 'error'; message: string };

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
  showNotes: boolean;
  showSynopses: boolean;
  showSections: boolean;
  /** Interface language. English is the fallback for every unknown locale. */
  language: Locale;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  editorFontSize: 15,
  autosaveSeconds: 30,
  backupCount: 3,
  showNotes: true,
  showSynopses: true,
  showSections: true,
  language: 'en',
};

/** Document recovered after an abrupt shutdown. */
export interface CrashRecovery {
  path: string | null;
  content: string;
  savedAt: number;
}

/** Requests from renderer to main. Each key gives the argument and result types. */
export interface IpcRequests {
  'dialog:pickOpen': { arg: void; result: DocumentSnapshot[] };
  'dialog:pickSaveAs': { arg: { suggestedName: string }; result: string | null };
  'dialog:confirmDiscard': { arg: { name: string }; result: 'save' | 'discard' | 'cancel' };

  'file:read': { arg: { path: string }; result: DocumentSnapshot };
  'file:save': { arg: SaveRequest; result: SaveOutcome };
  'file:exists': { arg: { path: string }; result: boolean };

  'recent:list': { arg: void; result: RecentFile[] };
  'recent:clear': { arg: void; result: void };

  'settings:get': { arg: void; result: AppSettings };
  'settings:patch': { arg: Partial<AppSettings>; result: AppSettings };

  'autosave:write': { arg: { id: string; path: string | null; content: string }; result: void };
  'autosave:clear': { arg: { id: string }; result: void };
  'autosave:pending': { arg: void; result: CrashRecovery[] };

  'window:setDirty': { arg: { dirty: boolean; name: string }; result: void };
  'shell:showItemInFolder': { arg: { path: string }; result: void };
}

/** Events from main to renderer. */
export interface IpcEvents {
  /** The OS or the menu asks to open files (double-click, dock drop, recent item). */
  'app:openFiles': { paths: string[] };
  /** A menu command for the renderer to run (new, save, find…). */
  'menu:command': { command: MenuCommand };
  /** The OS colour scheme changed. */
  'app:themeChanged': { dark: boolean };
  /**
   * Settings were changed from the main process — currently only the language, via the
   * native menu. The renderer refreshes its copy instead of polling.
   */
  'app:settingsChanged': { settings: AppSettings };
  /** The application is about to quit; the renderer should report unsaved state. */
  'app:willQuit': { reason: 'quit' | 'closeWindow' };
}

export type MenuCommand =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.closeTab'
  | 'edit.find'
  | 'edit.replace'
  | 'view.toggleNotes'
  | 'view.toggleSynopses'
  | 'view.toggleSections'
  | 'view.increaseFont'
  | 'view.decreaseFont'
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
