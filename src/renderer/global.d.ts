import type { RendererApi } from '@shared/ipc-contract.js';

declare global {
  interface Window {
    /** API exposed by the preload — the only bridge to the system (see src/preload). */
    readonly quantum: RendererApi;
  }
}
