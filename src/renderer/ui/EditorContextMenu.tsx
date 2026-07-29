import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { EditorContextAction, IpcEvents } from '@shared/ipc-contract.js';
import type { Translator } from '@shared/i18n/index.js';

type MenuState = IpcEvents['editor:contextMenu'];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICONS = {
  synonyms: (
    <Icon>
      <path d="m4 17 8-12 8 12M7 13h10M5 20h14" />
    </Icon>
  ),
  rewrite: (
    <Icon>
      <path d="M4 7h11a5 5 0 0 1 0 10H9M4 7l3-3M4 7l3 3M9 17l-3-3M9 17l-3 3" />
    </Icon>
  ),
  character: (
    <Icon>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.7-4 2.5-6 5.5-6s4.8 2 5.5 6M16 8h5M18.5 5.5v5" />
    </Icon>
  ),
  undo: (
    <Icon>
      <path d="m9 7-5 5 5 5M5 12h8a6 6 0 0 1 6 6" />
    </Icon>
  ),
  redo: (
    <Icon>
      <path d="m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6" />
    </Icon>
  ),
  cut: (
    <Icon>
      <circle cx="6" cy="7" r="3" />
      <circle cx="6" cy="17" r="3" />
      <path d="m8.5 8.5 11 7M8.5 15.5l11-7" />
    </Icon>
  ),
  copy: (
    <Icon>
      <rect x="8" y="8" width="11" height="12" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3" />
    </Icon>
  ),
  paste: (
    <Icon>
      <path d="M9 5h6M9 3h6v4H9zM7 5H5v16h14V5h-2" />
    </Icon>
  ),
  select: (
    <Icon>
      <path d="M7 3H3v4M17 3h4v4M7 21H3v-4M17 21h4v-4M8 9h8M8 13h8M8 17h5" />
    </Icon>
  ),
  spelling: (
    <Icon>
      <path d="M4 18 9 5l5 13M6 13h6M15 15l2 2 4-5" />
    </Icon>
  ),
};

interface EditorContextMenuProps {
  t: Translator['t'];
  onSynonyms: () => void;
  onRewrite: () => void;
  onRenameCharacter: () => void;
}

export function EditorContextMenu({
  t,
  onSynonyms,
  onRewrite,
  onRenameCharacter,
}: EditorContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => window.quantum.on('editor:contextMenu', setMenu), []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [menu]);

  if (!menu) return null;
  const runSystem = (action: EditorContextAction, value?: string) => {
    setMenu(null);
    void window.quantum.invoke('editor:contextAction', { action, value });
  };
  const runAi = (callback: () => void) => {
    setMenu(null);
    callback();
  };
  const left = Math.min(menu.x, window.innerWidth - 276);
  const top = Math.min(menu.y, window.innerHeight - 430);

  return (
    <div
      className="editor-context-menu"
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.misspelledWord ? (
        <>
          <div className="context-menu-heading">{menu.misspelledWord}</div>
          {menu.suggestions.length > 0 ? (
            menu.suggestions.map((suggestion) => (
              <button
                type="button"
                role="menuitem"
                key={suggestion}
                onClick={() => runSystem('replaceMisspelling', suggestion)}
              >
                {ICONS.spelling}
                <span>{suggestion}</span>
              </button>
            ))
          ) : (
            <button type="button" role="menuitem" disabled>
              {ICONS.spelling}
              <span>{t('spell.noSuggestions')}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => runSystem('addToDictionary', menu.misspelledWord)}
          >
            {ICONS.spelling}
            <span>{t('spell.addGlobal', { word: menu.misspelledWord })}</span>
          </button>
          <hr />
        </>
      ) : null}

      <button
        type="button"
        role="menuitem"
        disabled={!menu.singleWord}
        onClick={() => runAi(onSynonyms)}
      >
        {ICONS.synonyms}
        <span>{t('menu.ai.synonyms')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!menu.selectedText || menu.singleWord}
        onClick={() => runAi(onRewrite)}
      >
        {ICONS.rewrite}
        <span>{t('menu.ai.rewrite')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!menu.characterLike}
        onClick={() => runAi(onRenameCharacter)}
      >
        {ICONS.character}
        <span>{t('menu.ai.renameCharacter')}</span>
      </button>
      <hr />
      <div className="context-menu-grid">
        <button
          type="button"
          role="menuitem"
          disabled={!menu.editFlags.canUndo}
          onClick={() => runSystem('undo')}
        >
          {ICONS.undo}
          <span>{t('menu.edit.undo')}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={!menu.editFlags.canRedo}
          onClick={() => runSystem('redo')}
        >
          {ICONS.redo}
          <span>{t('menu.edit.redo')}</span>
        </button>
      </div>
      <hr />
      {(
        [
          ['cut', menu.editFlags.canCut, ICONS.cut, t('menu.edit.cut')],
          ['copy', menu.editFlags.canCopy, ICONS.copy, t('menu.edit.copy')],
          ['paste', menu.editFlags.canPaste, ICONS.paste, t('menu.edit.paste')],
          ['selectAll', menu.editFlags.canSelectAll, ICONS.select, t('menu.edit.selectAll')],
        ] as const
      ).map(([action, enabled, icon, label]) => (
        <button
          type="button"
          role="menuitem"
          key={action}
          disabled={!enabled}
          onClick={() => runSystem(action)}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
