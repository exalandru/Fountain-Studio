import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, session, shell } from 'electron';
import { buildMenu } from './menu.js';
import { openPaths, registerIpcHandlers } from './ipc.js';
import { applySpellCheckerLanguage, installSpellcheckContextMenu } from './spellcheck.js';
import { getSettings } from './store.js';
import { installCloseGuard, markApplicationQuitting } from './window-lifecycle.js';

/**
 * Main process entry point.
 *
 * Security policy (PLAN.md, M0): `contextIsolation` on, `nodeIntegration` off, external
 * navigation refused. The renderer only reaches the system through the typed API the
 * preload exposes.
 */

/** Files handed to us on the command line or by the OS before a window exists. */
const pendingFiles: string[] = [];
let mainWindow: BrowserWindow | null = null;

function collectCliFiles(argv: string[]): string[] {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((arg) => !arg.startsWith('-') && /\.(fountain|txt)$/i.test(arg));
}

async function createWindow(): Promise<BrowserWindow> {
  const settings = await getSettings();
  // The background colour has to be set before the first paint, otherwise the window
  // flashes white for a fraction of a second before the dark theme applies.
  const dark =
    settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors);

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Quantum Draft',
    backgroundColor: dark ? '#1c1c1e' : '#faf9f7',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Any attempt to open an external URL goes to the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url);
    } catch {
      // Invalid URLs are denied like every unsupported scheme.
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  installSpellcheckContextMenu(window);
  installCloseGuard(window);

  if (process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  applySpellCheckerLanguage(settings.spellcheckLanguage);

  return window;
}

function flushPendingFiles(): void {
  if (pendingFiles.length === 0 || !mainWindow || mainWindow.isDestroyed()) return;
  const paths = pendingFiles.splice(0, pendingFiles.length);
  void openPaths(paths).then((documents) => {
    if (documents.length > 0) {
      mainWindow?.webContents.send('app:openFiles', { snapshots: documents });
    }
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = await createWindow();
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

// Single instance: files opened from the OS join the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    pendingFiles.push(...collectCliFiles(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      flushPendingFiles();
    }
  });

  // macOS: double-clicking a .fountain file in the Finder.
  app.on('open-file', (event, path) => {
    event.preventDefault();
    pendingFiles.push(path);
    flushPendingFiles();
  });

  pendingFiles.push(...collectCliFiles(process.argv));

  void app.whenReady().then(async () => {
    // Strict CSP: no remote script, no outbound connection from the renderer. The
    // Phase 2 AI requests will leave from the main process, not from here.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
          ],
        },
      });
    });
    // Writer Studio does not need camera, microphone, geolocation, notifications or
    // other web permissions. Electron otherwise approves permission requests by
    // default, so both request and check paths are explicitly denied.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    registerIpcHandlers();
    await buildMenu();

    await createMainWindow();

    flushPendingFiles();

    nativeTheme.on('updated', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('app:themeChanged', {
        dark: nativeTheme.shouldUseDarkColors,
      });
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  });

  app.on('before-quit', markApplicationQuitting);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
