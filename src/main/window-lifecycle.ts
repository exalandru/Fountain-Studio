import { app } from 'electron';
import type { BrowserWindow, Event } from 'electron';

/**
 * Native-window close handshake.
 *
 * The main process owns the close event, while the renderer owns the document state.
 * Every first close attempt is paused until the renderer has snapshotted dirty tabs and
 * obtained the author's decisions. A second, approved close is allowed through.
 */

interface CloseState {
  approved: boolean;
  requested: boolean;
}

const states = new WeakMap<BrowserWindow, CloseState>();
let applicationIsQuitting = false;

export function markApplicationQuitting(): void {
  applicationIsQuitting = true;
}

export function installCloseGuard(window: BrowserWindow): void {
  states.set(window, { approved: false, requested: false });

  window.on('close', (event: Event) => {
    const state = states.get(window);
    if (!state || state.approved) return;

    event.preventDefault();
    if (state.requested || window.webContents.isDestroyed()) return;

    state.requested = true;
    window.webContents.send('app:willQuit', {
      reason: applicationIsQuitting ? 'quit' : 'closeWindow',
    });
  });
}

export function resolveCloseDecision(window: BrowserWindow | null, proceed: boolean): void {
  if (!window) return;
  const state = states.get(window);
  if (!state) return;

  state.requested = false;
  if (!proceed) {
    applicationIsQuitting = false;
    return;
  }

  state.approved = true;
  const shouldQuit = applicationIsQuitting;
  // Let the IPC reply reach the renderer before destroying its WebContents.
  setImmediate(() => {
    if (!window.isDestroyed()) window.close();
    // On macOS, closing the last window does not quit the application. Resume the
    // original quit request explicitly after the renderer has approved it.
    if (shouldQuit) app.quit();
  });
}
