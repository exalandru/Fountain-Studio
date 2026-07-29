/**
 * Versioned schema for `<screenplay>.fountain.appdata.json`.
 *
 * The companion belongs to one screenplay, so it only contains state that should
 * follow that screenplay from one machine to another. Global application preferences
 * remain in `settings.json`.
 *
 * This module is pure TypeScript: both IPC sides and unit tests use the exact same
 * validation and defaults.
 */

export const APP_DATA_VERSION = 1 as const;

export type SidebarTab = 'structure' | 'locations' | 'characters';

export interface SidebarState {
  visible: boolean;
  activeTab: SidebarTab;
  width: number;
  filter: string;
  /** Structure-view option; synopses remain excluded from the paper preview. */
  showSynopses: boolean;
}

export interface PreviewState {
  visible: boolean;
  width: number;
  syncScroll: boolean;
  activeTab: 'preview' | 'statistics';
}

export interface TimelineState {
  visible: boolean;
  uniformWidth: boolean;
  colorMode: 'intExt' | 'timeOfDay';
  zoom: number;
}

export interface AppData {
  version: typeof APP_DATA_VERSION;
  sidebar: SidebarState;
  preview: PreviewState;
  timeline: TimelineState;
}

export const DEFAULT_APP_DATA: Readonly<AppData> = {
  version: APP_DATA_VERSION,
  sidebar: {
    visible: true,
    activeTab: 'structure',
    width: 280,
    filter: '',
    showSynopses: true,
  },
  preview: {
    visible: true,
    width: 480,
    syncScroll: false,
    activeTab: 'preview',
  },
  timeline: {
    visible: true,
    uniformWidth: false,
    colorMode: 'intExt',
    zoom: 1,
  },
};

export function createDefaultAppData(): AppData {
  return {
    version: APP_DATA_VERSION,
    sidebar: { ...DEFAULT_APP_DATA.sidebar },
    preview: { ...DEFAULT_APP_DATA.preview },
    timeline: { ...DEFAULT_APP_DATA.timeline },
  };
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/**
 * Parses, validates and bounds a companion file.
 *
 * Unknown keys are deliberately discarded. Missing keys receive defaults so a
 * compatible addition to version 1 does not invalidate existing companion files.
 */
export function parseAppData(raw: string): AppData | null {
  try {
    const input = JSON.parse(raw) as unknown;
    if (typeof input !== 'object' || input === null) return null;

    const root = input as Record<string, unknown>;
    if (root['version'] !== APP_DATA_VERSION) return null;

    const result = createDefaultAppData();
    const sidebar =
      typeof root['sidebar'] === 'object' && root['sidebar'] !== null
        ? (root['sidebar'] as Record<string, unknown>)
        : {};
    const preview =
      typeof root['preview'] === 'object' && root['preview'] !== null
        ? (root['preview'] as Record<string, unknown>)
        : {};
    const timeline =
      typeof root['timeline'] === 'object' && root['timeline'] !== null
        ? (root['timeline'] as Record<string, unknown>)
        : {};

    if (typeof sidebar['visible'] === 'boolean') result.sidebar.visible = sidebar['visible'];
    if (
      sidebar['activeTab'] === 'structure' ||
      sidebar['activeTab'] === 'locations' ||
      sidebar['activeTab'] === 'characters'
    ) {
      result.sidebar.activeTab = sidebar['activeTab'];
    }
    result.sidebar.width = clamp(sidebar['width'], DEFAULT_APP_DATA.sidebar.width, 220, 480);
    if (typeof sidebar['filter'] === 'string') {
      result.sidebar.filter = sidebar['filter'].slice(0, 200);
    }
    if (typeof sidebar['showSynopses'] === 'boolean') {
      result.sidebar.showSynopses = sidebar['showSynopses'];
    }

    if (typeof preview['visible'] === 'boolean') result.preview.visible = preview['visible'];
    result.preview.width = clamp(preview['width'], DEFAULT_APP_DATA.preview.width, 320, 760);
    if (typeof preview['syncScroll'] === 'boolean') {
      result.preview.syncScroll = preview['syncScroll'];
    }
    if (preview['activeTab'] === 'preview' || preview['activeTab'] === 'statistics') {
      result.preview.activeTab = preview['activeTab'];
    }
    if (typeof timeline['visible'] === 'boolean') result.timeline.visible = timeline['visible'];
    if (typeof timeline['uniformWidth'] === 'boolean') {
      result.timeline.uniformWidth = timeline['uniformWidth'];
    }
    if (timeline['colorMode'] === 'intExt' || timeline['colorMode'] === 'timeOfDay') {
      result.timeline.colorMode = timeline['colorMode'];
    }
    if (typeof timeline['zoom'] === 'number' && Number.isFinite(timeline['zoom'])) {
      result.timeline.zoom =
        clamp(timeline['zoom'] * 100, DEFAULT_APP_DATA.timeline.zoom * 100, 50, 250) / 100;
    }

    return result;
  } catch {
    return null;
  }
}

export function serializeAppData(data: AppData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
