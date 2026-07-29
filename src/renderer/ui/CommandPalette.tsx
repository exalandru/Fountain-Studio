import { useEffect, useMemo, useRef, useState } from 'react';
import type { MenuCommand } from '@shared/ipc-contract.js';
import { useTranslator } from '../hooks/useTranslator.js';

export interface PaletteCommand {
  id: MenuCommand;
  label: string;
  shortcut?: string;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onRun: (command: MenuCommand) => void;
  onClose: () => void;
}

export function CommandPalette({ commands, onRun, onClose }: CommandPaletteProps) {
  const { t } = useTranslator();
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? commands.filter((command) => command.label.toLocaleLowerCase().includes(needle))
      : commands;
  }, [commands, query]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const run = (command: MenuCommand) => {
    onClose();
    onRun(command);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Tab') {
            const focusable =
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ) ?? [];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first && last) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last && first) {
              event.preventDefault();
              first.focus();
            }
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelected((index) => Math.min(filtered.length - 1, index + 1));
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected((index) => Math.max(0, index - 1));
          }
          if (event.key === 'Enter') {
            const command = filtered[selected];
            if (command) run(command.id);
          }
        }}
      >
        <input
          ref={inputRef}
          type="search"
          value={query}
          aria-label={t('palette.search')}
          placeholder={t('palette.search')}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
        />
        <div className="command-list" role="listbox">
          {filtered.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={index === selected ? 'selected' : ''}
              onMouseEnter={() => setSelected(index)}
              onClick={() => run(command.id)}
            >
              <span>{command.label}</span>
              {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="command-empty">{t('palette.empty')}</div> : null}
        </div>
      </section>
    </div>
  );
}
