import type {
  AiChatMode,
  AiConversation,
  AiConversationMessage,
  AiInconsistency,
  RewriteTone,
} from '../ai/index.js';

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
export type RightPanelTab = 'statistics' | 'preview' | 'ai' | 'syntax';

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

export interface BrainstormState {
  activeConversationId: string | null;
  conversations: AiConversation[];
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
  brainstorm: BrainstormState;
  rewrite: RewriteState;
  inconsistencies: InconsistencyState;
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
    activeTab: 'statistics',
  },
  timeline: {
    visible: true,
    uniformWidth: false,
    colorMode: 'intExt',
    zoom: 1,
  },
  brainstorm: {
    activeConversationId: null,
    conversations: [],
  },
  rewrite: {
    lastTone: 'neutral',
    customStyle: '',
  },
  inconsistencies: {
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
    brainstorm: { activeConversationId: null, conversations: [] },
    rewrite: { ...DEFAULT_APP_DATA.rewrite },
    inconsistencies: { items: [], analyzedAt: null },
  };
}

function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function parseMessage(value: unknown): AiConversationMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (
    typeof message['id'] !== 'string' ||
    (message['role'] !== 'user' && message['role'] !== 'assistant') ||
    typeof message['content'] !== 'string'
  ) {
    return null;
  }
  return {
    id: message['id'].slice(0, 100),
    role: message['role'],
    content: message['content'].slice(0, 1_000_000),
    createdAt:
      typeof message['createdAt'] === 'number' && Number.isFinite(message['createdAt'])
        ? message['createdAt']
        : 0,
    attachments: Array.isArray(message['attachments'])
      ? message['attachments'].slice(0, 4).flatMap((candidate) => {
          if (typeof candidate !== 'object' || candidate === null) return [];
          const attachment = candidate as Record<string, unknown>;
          if (
            typeof attachment['id'] !== 'string' ||
            typeof attachment['label'] !== 'string' ||
            (attachment['kind'] !== 'script' &&
              attachment['kind'] !== 'scene' &&
              attachment['kind'] !== 'selection' &&
              attachment['kind'] !== 'statistics')
          ) {
            return [];
          }
          return [
            {
              id: attachment['id'].slice(0, 100),
              kind: attachment['kind'],
              label: attachment['label'].slice(0, 200),
              approximateTokens: clamp(attachment['approximateTokens'], 0, 0, 10_000_000),
            },
          ];
        })
      : undefined,
  };
}

function parseConversations(value: unknown): AiConversation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return [];
    const conversation = candidate as Record<string, unknown>;
    if (typeof conversation['id'] !== 'string' || typeof conversation['title'] !== 'string') {
      return [];
    }
    const mode: AiChatMode = conversation['mode'] === 'creative' ? 'creative' : 'factual';
    return [
      {
        id: conversation['id'].slice(0, 100),
        title: conversation['title'].slice(0, 200),
        mode,
        messages: Array.isArray(conversation['messages'])
          ? conversation['messages'].slice(0, 500).flatMap((message) => {
              const parsed = parseMessage(message);
              return parsed ? [parsed] : [];
            })
          : [],
        createdAt:
          typeof conversation['createdAt'] === 'number' &&
          Number.isFinite(conversation['createdAt'])
            ? conversation['createdAt']
            : 0,
        updatedAt:
          typeof conversation['updatedAt'] === 'number' &&
          Number.isFinite(conversation['updatedAt'])
            ? conversation['updatedAt']
            : 0,
      },
    ];
  });
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
        item['type'] !== 'dialogue') ||
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
    const brainstorm =
      typeof root['brainstorm'] === 'object' && root['brainstorm'] !== null
        ? (root['brainstorm'] as Record<string, unknown>)
        : {};
    const rewrite =
      typeof root['rewrite'] === 'object' && root['rewrite'] !== null
        ? (root['rewrite'] as Record<string, unknown>)
        : {};
    const inconsistencies =
      typeof root['inconsistencies'] === 'object' && root['inconsistencies'] !== null
        ? (root['inconsistencies'] as Record<string, unknown>)
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
    if (
      preview['activeTab'] === 'preview' ||
      preview['activeTab'] === 'statistics' ||
      preview['activeTab'] === 'ai' ||
      preview['activeTab'] === 'syntax'
    ) {
      result.preview.activeTab = preview['activeTab'];
    } else if (
      preview['activeTab'] === 'brainstorm' ||
      preview['activeTab'] === 'inconsistencies'
    ) {
      result.preview.activeTab = 'ai';
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
    result.brainstorm.conversations = parseConversations(brainstorm['conversations']);
    if (
      typeof brainstorm['activeConversationId'] === 'string' &&
      result.brainstorm.conversations.some(
        (conversation) => conversation.id === brainstorm['activeConversationId'],
      )
    ) {
      result.brainstorm.activeConversationId = brainstorm['activeConversationId'];
    }
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

    return result;
  } catch {
    return null;
  }
}

export function serializeAppData(data: AppData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
