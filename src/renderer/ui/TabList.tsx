import { useRef } from 'react';

interface TabListProps<Id extends string> {
  tabs: readonly Id[];
  active: Id;
  /** Renders a tab's visible name. */
  label: (id: Id) => string;
  /** Tab element ids are `${idPrefix}-${id}`; the panel points back at the active one. */
  idPrefix: string;
  /**
   * The id of the panel these tabs control.
   *
   * Constant, not per-tab. The sidebar used to point every tab at `sidebar-panel-${tab}`
   * while rendering only the active one, so two of its three tabs referenced an element that
   * did not exist.
   */
  panelId: string;
  /** `sidebar-tabs` or `right-panel-tabs`. */
  className: string;
  /** `sidebar-tab` or `right-panel-tab`. */
  tabClassName: string;
  onChange: (id: Id) => void;
}

/**
 * A row of tabs with the keyboard behaviour tabs are meant to have: one stop in the tab order
 * for the whole row, and the arrows moving between them.
 *
 * The handler was written twice, and had already begun to drift — one copy walked up with
 * `closest('[role="tablist"]')`, the other with `parentElement`, which only agree as long as
 * nobody wraps a tab.
 */
export function TabList<Id extends string>({
  tabs,
  active,
  label,
  idPrefix,
  panelId,
  className,
  tabClassName,
  onChange,
}: TabListProps<Id>) {
  const listRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className={className} role="tablist" ref={listRef}>
      {tabs.map((tab, index) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`${idPrefix}-${tab}`}
          aria-controls={panelId}
          aria-selected={tab === active}
          tabIndex={tab === active ? 0 : -1}
          className={`${tabClassName}${tab === active ? ' active' : ''}`}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => {
            const nextIndex =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index - 1 + tabs.length) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
            const next = tabs[nextIndex];
            if (nextIndex < 0 || !next) return;
            event.preventDefault();
            onChange(next);
            const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons?.[nextIndex]?.focus();
          }}
        >
          {label(tab)}
        </button>
      ))}
    </div>
  );
}
