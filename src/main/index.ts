import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, session, shell } from 'electron';
import { buildMenu } from './menu.js';
import { openPaths, registerIpcHandlers } from './ipc.js';
import { applySpellCheckerLanguage } from './spellcheck.js';
import { getSettings } from './store.js';

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
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Any attempt to open an external URL goes to the browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    await window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }

  applySpellCheckerLanguage(settings.language);

  return window;
}

function flushPendingFiles(): void {
  if (pendingFiles.length === 0 || !mainWindow) return;
  const paths = pendingFiles.splice(0, pendingFiles.length);
  void openPaths(paths).then((documents) => {
    if (documents.length > 0) {
      mainWindow?.webContents.send('app:openFiles', { paths: documents.map((d) => d.path ?? '') });
    }
  });
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

    registerIpcHandlers();
    await buildMenu();

    mainWindow = await createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    flushPendingFiles();

    nativeTheme.on('updated', () => {
      mainWindow?.webContents.send('app:themeChanged', {
        dark: nativeTheme.shouldUseDarkColors,
      });
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = await createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
