import type { AiInconsistency, RewriteTone } from '../ai/index.js';
import type { RevisionColour } from '../revision/index.js';
import { isRevisionColour } from '../revision/index.js';
import { isSnapshotId } from '../snapshots/index.js';

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
export type RightPanelTab = 'statistics' | 'preview' | 'syntax';

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
  activeTab: RightPanelTab;
}

export interface TimelineState {
  visible: boolean;
  uniformWidth: boolean;
  colorMode: 'intExt' | 'timeOfDay';
  zoom: number;
}

export interface CorkboardState {
  visible: boolean;
  /** Card colour source. `none` gives a plain board, for a long screenplay. */
  colorMode: 'intExt' | 'timeOfDay' | 'none';
  /** Card width; the grid fits as many columns as the space allows. */
  cardWidth: number;
}

/**
 * Where a locked screenplay stands: what it is compared against, and which colour it is on.
 *
 * The reference is a snapshot rather than a copy kept here: the versions feature already stores
 * screenplays, names them and shows them, and a second mechanism would only be a second thing to
 * keep in step.
 */
export interface RevisionState {
  /** Snapshot holding the locked draft, `null` while the screenplay is not locked. */
  snapshotId: string | null;
  lockedAt: number | null;
  /** Colour of the revision being written now. */
  colour: RevisionColour;
}

export interface RewriteState {
  lastTone: RewriteTone;
  customStyle: string;
}

export interface InconsistencyState {
  items: AiInconsistency[];
  analyzedAt: number | null;
}

export interface AppData {
  version: typeof APP_DATA_VERSION;
  sidebar: SidebarState;
  preview: PreviewState;
  timeline: TimelineState;
  corkboard: CorkboardState;
  revision: RevisionState;
  rewrite: RewriteState;
  inconsistencies: InconsistencyState;
  voiceConsistency: Record<string, InconsistencyState>;
  repetitions: InconsistencyState;
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
    // The UI now expects the preview panel to start at the minimum size of the resize handle (320 px).
    width: 320,
    syncScroll: false,
    activeTab: 'statistics',
  },
  timeline: {
    visible: true,
    uniformWidth: false,
    colorMode: 'intExt',
    zoom: 1,
  },
  corkboard: {
    visible: false,
    colorMode: 'intExt',
    cardWidth: 240,
  },
  revision: {
    snapshotId: null,
    lockedAt: null,
    colour: 'blue',
  },
  rewrite: {
    lastTone: 'neutral',
    customStyle: '',
  },
  inconsistencies: {
    items: [],
    analyzedAt: null,
  },
  voiceConsistency: {},
  repetitions: {
    items: [],
    analyzedAt: null,
  },
};

export function createDefaultAppData(): AppData {
  return {
    version: APP_DATA_VERSION,
    sidebar: { ...DEFAULT_APP_DATA.sidebar },
    preview: { ...DEFAULT_APP_DATA.preview },
    timeline: { ...DEFAULT_APP_DATA.timeline },
    corkboard: { ...DEFAULT_APP_DATA.corkboard },
    revision: { ...DEFAULT_APP_DATA.revision },
    rewrite: { ...DEFAULT_APP_DATA.rewrite },
    inconsistencies: { items: [], analyzedAt: null },
    voiceConsistency: {},
    repetitions: { items: [], analyzedAt: null },
  };
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

const REWRITE_TONES = new Set<RewriteTone>([
  'neutral',
  'concise',
  'cinematic',
  'dramatic',
  'comic',
  'formal',
  'colloquial',
  'custom',
]);

/** More characters than any screenplay has speaking parts, and a hard stop on a bad file. */
const MAX_VOICES = 300;

function parseInconsistencyItems(value: unknown): AiInconsistency[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const item = candidate as Record<string, unknown>;
    if (
      typeof item['id'] !== 'string' ||
      typeof item['description'] !== 'string' ||
      (item['type'] !== 'continuity' &&
        item['type'] !== 'chronology' &&
        item['type'] !== 'character' &&
        item['type'] !== 'location' &&
        item['type'] !== 'plot' &&
        item['type'] !== 'dialogue' &&
        item['type'] !== 'voice' &&
        item['type'] !== 'repetition') ||
      (item['severity'] !== 'info' && item['severity'] !== 'minor' && item['severity'] !== 'major')
    ) {
      return [];
    }
    const status =
      item['status'] === 'ignored' || item['status'] === 'resolved' ? item['status'] : 'open';
    return [
      {
        id: item['id'].slice(0, 100),
        type: item['type'],
        severity: item['severity'],
        description: item['description'].slice(0, 4_000),
        suggestion:
          typeof item['suggestion'] === 'string' ? item['suggestion'].slice(0, 4_000) : '',
        status,
        references: Array.isArray(item['references'])
          ? item['references'].slice(0, 20).flatMap((candidateReference) => {
              if (typeof candidateReference !== 'object' || candidateReference === null) return [];
              const reference = candidateReference as Record<string, unknown>;
              if (
                typeof reference['sceneNumber'] !== 'string' ||
                typeof reference['heading'] !== 'string' ||
                typeof reference['quote'] !== 'string'
              ) {
                return [];
              }
              return [
                {
                  sceneNumber: reference['sceneNumber'].slice(0, 40),
                  heading: reference['heading'].slice(0, 300),
                  quote: reference['quote'].slice(0, 500),
                },
              ];
            })
          : [],
      },
    ];
  });
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
    const corkboard =
      typeof root['corkboard'] === 'object' && root['corkboard'] !== null
        ? (root['corkboard'] as Record<string, unknown>)
        : {};
    const revision =
      typeof root['revision'] === 'object' && root['revision'] !== null
        ? (root['revision'] as Record<string, unknown>)
        : {};
    const rewrite =
      typeof root['rewrite'] === 'object' && root['rewrite'] !== null
        ? (root['rewrite'] as Record<string, unknown>)
        : {};
    const inconsistencies =
      typeof root['inconsistencies'] === 'object' && root['inconsistencies'] !== null
        ? (root['inconsistencies'] as Record<string, unknown>)
        : {};
    const voiceConsistency =
      typeof root['voiceConsistency'] === 'object' && root['voiceConsistency'] !== null
        ? (root['voiceConsistency'] as Record<string, unknown>)
        : {};
    const repetitions =
      typeof root['repetitions'] === 'object' && root['repetitions'] !== null
        ? (root['repetitions'] as Record<string, unknown>)
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
    // The floor sits below the default, so a narrower preview than the one shipped is a
    // legitimate choice rather than a value the parser quietly raises on the next open.
    result.preview.width = clamp(preview['width'], DEFAULT_APP_DATA.preview.width, 240, 760);
    if (typeof preview['syncScroll'] === 'boolean') {
      result.preview.syncScroll = preview['syncScroll'];
    }
    if (
      preview['activeTab'] === 'preview' ||
      preview['activeTab'] === 'statistics' ||
      preview['activeTab'] === 'syntax'
    ) {
      result.preview.activeTab = preview['activeTab'];
    } else if (preview['activeTab'] === 'inconsistencies') {
      // A retired tab value: fall back rather than leave the panel on nothing.
      result.preview.activeTab = 'statistics';
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
    if (typeof corkboard['visible'] === 'boolean') result.corkboard.visible = corkboard['visible'];
    if (
      corkboard['colorMode'] === 'intExt' ||
      corkboard['colorMode'] === 'timeOfDay' ||
      corkboard['colorMode'] === 'none'
    ) {
      result.corkboard.colorMode = corkboard['colorMode'];
    }
    result.corkboard.cardWidth = clamp(
      corkboard['cardWidth'],
      DEFAULT_APP_DATA.corkboard.cardWidth,
      180,
      420,
    );
    // A reference that is not a snapshot id is no reference at all: rather than trust it and
    // read a path from it later, the screenplay reads as unlocked.
    if (isSnapshotId(revision['snapshotId'])) {
      result.revision.snapshotId = revision['snapshotId'];
      if (typeof revision['lockedAt'] === 'number' && Number.isFinite(revision['lockedAt'])) {
        result.revision.lockedAt = revision['lockedAt'];
      }
    }
    if (isRevisionColour(revision['colour'])) result.revision.colour = revision['colour'];

    if (REWRITE_TONES.has(rewrite['lastTone'] as RewriteTone)) {
      result.rewrite.lastTone = rewrite['lastTone'] as RewriteTone;
    }
    if (typeof rewrite['customStyle'] === 'string') {
      result.rewrite.customStyle = rewrite['customStyle'].slice(0, 500);
    }
    result.inconsistencies.items = parseInconsistencyItems(inconsistencies['items']);
    if (
      typeof inconsistencies['analyzedAt'] === 'number' &&
      Number.isFinite(inconsistencies['analyzedAt'])
    ) {
      result.inconsistencies.analyzedAt = inconsistencies['analyzedAt'];
    }

    result.repetitions.items = parseInconsistencyItems(repetitions['items']);
    if (
      typeof repetitions['analyzedAt'] === 'number' &&
      Number.isFinite(repetitions['analyzedAt'])
    ) {
      result.repetitions.analyzedAt = repetitions['analyzedAt'];
    }

    // Findings are keyed by character name, which comes from the screenplay and so is
    // bounded like every other string read here — a companion file is data on disk, not a
    // trusted structure.
    for (const [character, value] of Object.entries(voiceConsistency).slice(0, MAX_VOICES)) {
      if (typeof value !== 'object' || value === null) continue;
      const name = character.slice(0, 200);
      if (name.length === 0) continue;
      const state = value as Record<string, unknown>;
      result.voiceConsistency[name] = {
        items: parseInconsistencyItems(state['items']),
        analyzedAt: typeof state['analyzedAt'] === 'number' ? state['analyzedAt'] : null,
      };
    }

    return result;
  } catch {
    return null;
  }
}

export function serializeAppData(data: AppData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
