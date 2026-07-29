import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEvents,
  IpcRequests,
  RendererApi,
} from '@shared/ipc-contract.js';

/**
 * The single bridge between the renderer and the system.
 *
 * The renderer receives only these members: no `require`, no file-system access, no raw
 * `ipcRenderer`. Granting the renderer a new capability necessarily goes through a
 * channel declared in the shared contract.
 */
const api: RendererApi = {
  invoke<C extends IpcChannel>(channel: C, arg: IpcRequests[C]['arg']) {
    return ipcRenderer.invoke(channel, arg) as Promise<IpcRequests[C]['result']>;
  },

  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEvents[C]) => void) {
    const wrapped = (_event: unknown, payload: IpcEvents[C]): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    // The return value is the unsubscribe function, called when components unmount.
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  getPathForFile(file: File) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // Synthetic file (dragged from a web page, for instance): no path available.
      return '';
    }
  },

  platform: process.platform as RendererApi['platform'],
};

contextBridge.exposeInMainWorld('quantum', api);
