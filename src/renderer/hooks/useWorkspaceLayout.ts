import { useCallback } from 'react';
import type {
  AppData,
  CorkboardState,
  RightPanelTab,
  SidebarTab,
  TimelineState,
} from '@shared/appdata/index.js';

/**
 * Sidebar / preview / timeline / corkboard layout patches.
 *
 * All of these are thin `updateAppData` setters; keeping them together stops App from
 * being a factory of one-line callbacks.
 */
export function useWorkspaceLayout(updateAppData: (update: (current: AppData) => AppData) => void) {
  const toggleTimeline = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        timeline: { ...data.timeline, visible: !data.timeline.visible },
      })),
    [updateAppData],
  );
  const updateCorkboard = useCallback(
    (patch: Partial<CorkboardState>) =>
      updateAppData((data) => ({ ...data, corkboard: { ...data.corkboard, ...patch } })),
    [updateAppData],
  );
  const closeCorkboard = useCallback(() => updateCorkboard({ visible: false }), [updateCorkboard]);
  const toggleCorkboard = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        corkboard: { ...data.corkboard, visible: !data.corkboard.visible },
      })),
    [updateAppData],
  );
  const resizePreview = useCallback(
    (width: number) => updateAppData((data) => ({ ...data, preview: { ...data.preview, width } })),
    [updateAppData],
  );
  const setPreviewSync = useCallback(
    (syncScroll: boolean) =>
      updateAppData((data) => ({ ...data, preview: { ...data.preview, syncScroll } })),
    [updateAppData],
  );
  const closePreview = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        preview: { ...data.preview, visible: false },
      })),
    [updateAppData],
  );
  const setRightPanelTab = useCallback(
    (activeTab: RightPanelTab) =>
      updateAppData((data) => ({
        ...data,
        preview: { ...data.preview, activeTab },
      })),
    [updateAppData],
  );
  const resizeSidebar = useCallback(
    (width: number) => updateAppData((data) => ({ ...data, sidebar: { ...data.sidebar, width } })),
    [updateAppData],
  );
  const setSidebarTab = useCallback(
    (activeTab: SidebarTab) =>
      updateAppData((data) => ({ ...data, sidebar: { ...data.sidebar, activeTab } })),
    [updateAppData],
  );
  const setSidebarFilter = useCallback(
    (filter: string) =>
      updateAppData((data) => ({ ...data, sidebar: { ...data.sidebar, filter } })),
    [updateAppData],
  );
  const setSidebarSynopses = useCallback(
    (showSynopses: boolean) =>
      updateAppData((data) => ({
        ...data,
        sidebar: { ...data.sidebar, showSynopses },
      })),
    [updateAppData],
  );
  const closeSidebar = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        sidebar: { ...data.sidebar, visible: false },
      })),
    [updateAppData],
  );
  const showPreview = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        preview: { ...data.preview, visible: true },
      })),
    [updateAppData],
  );
  const showSidebar = useCallback(
    () =>
      updateAppData((data) => ({
        ...data,
        sidebar: { ...data.sidebar, visible: true },
      })),
    [updateAppData],
  );
  const updateTimeline = useCallback(
    (patch: Partial<TimelineState>) =>
      updateAppData((data) => ({
        ...data,
        timeline: { ...data.timeline, ...patch },
      })),
    [updateAppData],
  );
  const closeTimeline = useCallback(() => updateTimeline({ visible: false }), [updateTimeline]);
  const showTimeline = useCallback(() => updateTimeline({ visible: true }), [updateTimeline]);

  return {
    toggleTimeline,
    updateCorkboard,
    closeCorkboard,
    toggleCorkboard,
    resizePreview,
    setPreviewSync,
    closePreview,
    setRightPanelTab,
    resizeSidebar,
    setSidebarTab,
    setSidebarFilter,
    setSidebarSynopses,
    closeSidebar,
    showPreview,
    showSidebar,
    updateTimeline,
    closeTimeline,
    showTimeline,
  };
}
