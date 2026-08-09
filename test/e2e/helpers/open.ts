import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Opens screenplay(s) through the main-process trusted open hook (M4.1).
 * Renderer-supplied `app:openFiles { paths }` no longer creates document grants.
 */
export async function openTrustedScreenplays(
  app: ElectronApplication,
  paths: string[],
): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, screenplayPaths) => {
    const open = (
      globalThis as typeof globalThis & {
        __fountainOpenTrustedPaths?: (
          paths: string[],
        ) => Promise<Array<{ path: string | null; content: string }>>;
      }
    ).__fountainOpenTrustedPaths;
    if (!open) throw new Error('Missing __fountainOpenTrustedPaths test hook');
    const documents = await open(screenplayPaths);
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:openFiles', {
      snapshots: documents,
    });
  }, paths);
}

export async function openTrustedScreenplay(
  app: ElectronApplication,
  page: Page,
  path: string,
): Promise<void> {
  await openTrustedScreenplays(app, [path]);
  const name = path.split('/').at(-1) ?? path;
  await expect(page.locator('.tab-active .tab-name')).toHaveText(name);
}

/** Mocks the native Save As dialog and reserves the destination like main would. */
export async function chooseSaveAsDestination(
  app: ElectronApplication,
  destination: string,
): Promise<void> {
  await app.evaluate(({ ipcMain }, nextPath) => {
    const reserve = (
      globalThis as typeof globalThis & {
        __fountainReserveSaveAsDestination?: (path: string) => void;
      }
    ).__fountainReserveSaveAsDestination;
    ipcMain.removeHandler('dialog:pickSaveAs');
    ipcMain.handle('dialog:pickSaveAs', () => {
      reserve?.(nextPath);
      return nextPath;
    });
  }, destination);
}
