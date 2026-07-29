import type { AiChatMode, AiConversation, AiConversationMessage } from '../ai/index.js';

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

export type SidebarTab = 'structure' | 'locations' | 'characters' | 'syntax';

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
  activeTab: 'preview' | 'statistics' | 'brainstorm';
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

export interface AppData {
  version: typeof APP_DATA_VERSION;
  sidebar: SidebarState;
  preview: PreviewState;
  timeline: TimelineState;
  brainstorm: BrainstormState;
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
};

export function createDefaultAppData(): AppData {
  return {
    version: APP_DATA_VERSION,
    sidebar: { ...DEFAULT_APP_DATA.sidebar },
    preview: { ...DEFAULT_APP_DATA.preview },
    timeline: { ...DEFAULT_APP_DATA.timeline },
    brainstorm: { activeConversationId: null, conversations: [] },
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

    if (typeof sidebar['visible'] === 'boolean') result.sidebar.visible = sidebar['visible'];
    if (
      sidebar['activeTab'] === 'structure' ||
      sidebar['activeTab'] === 'locations' ||
      sidebar['activeTab'] === 'characters' ||
      sidebar['activeTab'] === 'syntax'
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
      preview['activeTab'] === 'brainstorm'
    ) {
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
    result.brainstorm.conversations = parseConversations(brainstorm['conversations']);
    if (
      typeof brainstorm['activeConversationId'] === 'string' &&
      result.brainstorm.conversations.some(
        (conversation) => conversation.id === brainstorm['activeConversationId'],
      )
    ) {
      result.brainstorm.activeConversationId = brainstorm['activeConversationId'];
    }

    return result;
  } catch {
    return null;
  }
}

export function serializeAppData(data: AppData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
