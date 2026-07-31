import { useId } from 'react';
import type { ReactNode } from 'react';
import type { AppSettings } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';

const DEFAULT_EDITOR_FONT_SIZE = 15;

type ToolbarIconName =
  | 'corkboard'
  | 'consistency'
  | 'voice'
  | 'repetition'
  | 'bible'
  | 'focus'
  | 'typewriter'
  | 'sceneNumbers'
  | 'sections'
  | 'comments'
  | 'notes'
  | 'synopses'
  | 'formatted'
  | 'system'
  | 'light'
  | 'dark'
  | 'zoomOut'
  | 'zoomReset'
  | 'zoomIn';

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  let path: ReactNode;
  switch (name) {
    case 'corkboard':
      // Four cards pinned side by side: the board seen from a distance.
      path = (
        <>
          <rect x="3.5" y="4.5" width="7" height="6" rx="1" />
          <rect x="13.5" y="4.5" width="7" height="6" rx="1" />
          <rect x="3.5" y="13.5" width="7" height="6" rx="1" />
          <rect x="13.5" y="13.5" width="7" height="6" rx="1" />
        </>
      );
      break;
    case 'consistency':
      path = (
        <>
          <path d="M12 3 4.5 6v5.5c0 4.5 3 7.7 7.5 9.5 4.5-1.8 7.5-5 7.5-9.5V6z" />
          <path d="m8.5 12 2.2 2.2 4.8-5" />
        </>
      );
      break;
    case 'voice':
      // A speech bubble with a waveform: what a character sounds like.
      path = (
        <>
          <path d="M4 5.5h16v10H8.5L4 19z" />
          <path d="M8.5 9v3M12 8v5.5M15.5 10v1.5" />
        </>
      );
      break;
    case 'repetition':
      // Two identical marks, one shadowing the other.
      path = (
        <>
          <rect x="4" y="5" width="10" height="6" rx="1.5" />
          <rect x="10" y="13" width="10" height="6" rx="1.5" />
        </>
      );
      break;
    case 'bible':
      // A bound volume with a ribbon.
      path = (
        <>
          <path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2z" />
          <path d="M8 4.5v10l2.2-1.6 2.3 1.6V4.5" />
        </>
      );
      break;
    case 'focus':
      path = (
        <>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </>
      );
      break;
    case 'typewriter':
      path = (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 9h.01M11 9h.01M15 9h.01M19 9h.01M7 13h.01M11 13h.01M15 13h.01M19 13h.01M8 16h8" />
        </>
      );
      break;
    case 'sceneNumbers':
      path = <path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16" />;
      break;
    case 'sections':
      path = (
        <>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="M4 5h2v2H4zM4 11h2v2H4zM4 17h2v2H4z" />
        </>
      );
      break;
    case 'comments':
      path = (
        <>
          <path d="M5 5h14v11H9l-4 4z" />
          <path d="M9 9h6M9 12h4" />
        </>
      );
      break;
    case 'notes':
      path = (
        <>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M15 3v5h4M9 12h7M9 16h7" />
        </>
      );
      break;
    case 'synopses':
      path = (
        <>
          <path d="M5 4h14v16H5z" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </>
      );
      break;
    case 'formatted':
      path = (
        <>
          <path d="M5 4h14M8 4v16M5 20h6" />
          <path d="M14 10h6M17 7v6" />
        </>
      );
      break;
    case 'system':
      path = (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      );
      break;
    case 'light':
      path = (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      );
      break;
    case 'dark':
      path = <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />;
      break;
    case 'zoomOut':
      path = (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5M7.5 10.5h6" />
        </>
      );
      break;
    case 'zoomReset':
      path = (
        <>
          <path d="M4 8V4h4M4.8 4.8a8 8 0 1 1-1 9.2" />
          <circle cx="12" cy="12" r="1" />
        </>
      );
      break;
    case 'zoomIn':
      path = (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5M7.5 10.5h6M10.5 7.5v6" />
        </>
      );
      break;
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {path}
    </svg>
  );
}

function ToolbarButton({
  icon,
  label,
  tooltip,
  active,
  disabled,
  onClick,
}: {
  icon: ToolbarIconName;
  label: string;
  tooltip?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const tooltipId = useId();

  return (
    <span className="toolbar-button-wrap">
      <button
        type="button"
        className={`toolbar-icon-button${active ? ' is-active' : ''}`}
        aria-label={label}
        aria-describedby={tooltipId}
        aria-pressed={active === undefined ? undefined : active}
        disabled={disabled}
        onClick={onClick}
      >
        <ToolbarIcon name={icon} />
      </button>
      <span className="toolbar-tooltip" id={tooltipId} role="tooltip">
        {tooltip ?? label}
      </span>
    </span>
  );
}

interface TopToolbarProps {
  settings: AppSettings;
  corkboardVisible: boolean;
  t: Translator['t'];
  onSettingsChange: (patch: Partial<AppSettings>) => void;
  onToggleCorkboard: () => void;
  onOpenInconsistencies: () => void;
  onOpenVoiceConsistency: () => void;
  onOpenRepetitions: () => void;
  onOpenBible: () => void;
}

/** Four compact groups: writing modes, visibility, theme and editor zoom. */
export function TopToolbar({
  settings,
  corkboardVisible,
  t,
  onSettingsChange,
  onToggleCorkboard,
  onOpenInconsistencies,
  onOpenVoiceConsistency,
  onOpenRepetitions,
  onOpenBible,
}: TopToolbarProps) {
  return (
    <div className="topbar-actions" role="toolbar" aria-label={t('toolbar.modes')}>
      <div className="topbar-group" role="group" aria-label={t('toolbar.aiTools')}>
        <ToolbarButton
          icon="consistency"
          label={t('consistency.analyse')}
          tooltip={t('consistency.toolbarHint')}
          onClick={onOpenInconsistencies}
        />
        <ToolbarButton
          icon="voice"
          label={t('voice.title')}
          tooltip={t('voice.subtitle')}
          onClick={onOpenVoiceConsistency}
        />
        <ToolbarButton
          icon="repetition"
          label={t('repetition.title')}
          tooltip={t('repetition.subtitle')}
          onClick={onOpenRepetitions}
        />
        <ToolbarButton
          icon="bible"
          label={t('bible.title')}
          tooltip={t('bible.subtitle')}
          onClick={onOpenBible}
        />
      </div>
      <div className="topbar-group" role="group" aria-label={t('toolbar.writingModes')}>
        <ToolbarButton
          icon="corkboard"
          label={t('corkboard.title')}
          tooltip={t('corkboard.moveHint')}
          active={corkboardVisible}
          onClick={onToggleCorkboard}
        />
        <ToolbarButton
          icon="focus"
          label={t('toolbar.focus')}
          tooltip={`${t('toolbar.focus')} — ${t('toolbar.focusHint')}`}
          active={settings.focusMode}
          onClick={() => onSettingsChange({ focusMode: !settings.focusMode })}
        />
        <ToolbarButton
          icon="typewriter"
          label={t('toolbar.typewriter')}
          tooltip={`${t('toolbar.typewriter')} — ${t('toolbar.typewriterHint')}`}
          active={settings.typewriterMode}
          onClick={() => onSettingsChange({ typewriterMode: !settings.typewriterMode })}
        />
      </div>

      <div className="topbar-group" role="group" aria-label={t('toolbar.displayOptions')}>
        <ToolbarButton
          icon="sceneNumbers"
          label={t('menu.view.showSceneNumbers')}
          active={settings.showSceneNumbers}
          onClick={() => onSettingsChange({ showSceneNumbers: !settings.showSceneNumbers })}
        />
        <ToolbarButton
          icon="sections"
          label={t('menu.view.showSections')}
          active={settings.showSections}
          onClick={() => onSettingsChange({ showSections: !settings.showSections })}
        />
        <ToolbarButton
          icon="comments"
          label={t('menu.view.showBoneyard')}
          active={settings.showBoneyard}
          onClick={() => onSettingsChange({ showBoneyard: !settings.showBoneyard })}
        />
        <ToolbarButton
          icon="notes"
          label={t('menu.view.showNotes')}
          active={settings.showNotes}
          onClick={() => onSettingsChange({ showNotes: !settings.showNotes })}
        />
        <ToolbarButton
          icon="synopses"
          label={t('menu.view.showSynopses')}
          active={settings.showSynopses}
          onClick={() => onSettingsChange({ showSynopses: !settings.showSynopses })}
        />
        <ToolbarButton
          icon="formatted"
          label={t('menu.view.formattedMode')}
          active={settings.formattedMode}
          onClick={() => onSettingsChange({ formattedMode: !settings.formattedMode })}
        />
      </div>

      <div className="topbar-group" role="group" aria-label={t('toolbar.theme')}>
        {(
          [
            ['system', 'system', t('menu.view.themeSystem')],
            ['light', 'light', t('menu.view.themeLight')],
            ['dark', 'dark', t('menu.view.themeDark')],
          ] as const
        ).map(([theme, icon, label]) => (
          <ToolbarButton
            key={theme}
            icon={icon}
            label={label}
            active={settings.theme === theme}
            onClick={() => onSettingsChange({ theme })}
          />
        ))}
      </div>

      <div className="topbar-group" role="group" aria-label={t('toolbar.zoom')}>
        <ToolbarButton
          icon="zoomOut"
          label={t('menu.view.decreaseFont')}
          disabled={settings.editorFontSize <= 10}
          onClick={() =>
            onSettingsChange({ editorFontSize: Math.max(10, settings.editorFontSize - 1) })
          }
        />
        <ToolbarButton
          icon="zoomReset"
          label={t('toolbar.resetZoom', { size: settings.editorFontSize })}
          disabled={settings.editorFontSize === DEFAULT_EDITOR_FONT_SIZE}
          onClick={() => onSettingsChange({ editorFontSize: DEFAULT_EDITOR_FONT_SIZE })}
        />
        <ToolbarButton
          icon="zoomIn"
          label={t('menu.view.increaseFont')}
          disabled={settings.editorFontSize >= 28}
          onClick={() =>
            onSettingsChange({ editorFontSize: Math.min(28, settings.editorFontSize + 1) })
          }
        />
      </div>
    </div>
  );
}
