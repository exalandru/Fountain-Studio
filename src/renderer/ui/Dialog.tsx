import { useEffect, useRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { CloseButton } from './CloseButton.js';

interface DialogProps extends Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'> {
  /** The surface's own class: `pdf-dialog`, `bible-dialog`, `consistency-dialog`… */
  className: string;
  /** The accessible name, and the `<h2>`. */
  title: string;
  /** A line under the title. Its presence is what wraps the two in a `<div>` — see below. */
  subtitle?: string;
  /** Controls belonging to the header, between the title and the close button. */
  headerActions?: ReactNode;
  /** The close button's accessible name: what is being closed, not "Close". */
  closeLabel: string;
  /** Footer contents. Left out, no `<footer>` is rendered at all. */
  footer?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The modal frame: a scrim, a surface, a header, the body, and an optional footer.
 *
 * Two structural rules, both load-bearing rather than aesthetic.
 *
 * The children are rendered as direct children of the surface, with no wrapper of any kind.
 * The stylesheet addresses these dialogs through the child combinator throughout
 * (`.pdf-dialog > header`, `.ai-settings-dialog > footer`, `.bible-dialog > header >
 * div:first-of-type`) and two of them are grids of exactly three rows. One wrapper `<div>`
 * would collapse the layout of every dialog at once.
 *
 * The `<div>` around the title is rendered only when there is a subtitle, because that is
 * exactly the split the stylesheet expects: `.consistency-dialog > header > div { flex: 1 }`
 * on one side, `.pdf-dialog > header h2 { flex: 1 }` on the other.
 *
 * What the frame adds over the copies it replaces is the behaviour none of them had in full:
 * Escape works before the author has touched anything, Tab cannot leave, and closing hands
 * focus back to whatever opened the dialog. Four of the panels attached their Escape handler
 * to the surface without focusing anything inside it, so the key did nothing at all until
 * the first click.
 */
export function Dialog({
  className,
  title,
  subtitle,
  headerActions,
  closeLabel,
  footer,
  children,
  onClose,
  ...surface
}: DialogProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The close button's `autoFocus` has already run by the time this fires, so this only
    // catches a dialog that claimed nothing — where Escape would otherwise be heard by the
    // document body and dropped.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !surfaceRef.current?.contains(active)) {
      surfaceRef.current?.focus();
    }
    return () => opener?.focus();
  }, []);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={surfaceRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Focusable so Escape has a listener, but out of the tab order.
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = surfaceRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
          if (!focusable || focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last && first) {
            event.preventDefault();
            first.focus();
          }
        }}
        {...surface}
      >
        <header>
          {subtitle === undefined ? (
            <h2>{title}</h2>
          ) : (
            <div>
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>
          )}
          {headerActions}
          <CloseButton label={closeLabel} autoFocus onClick={onClose} />
        </header>
        {children}
        {footer === undefined ? null : <footer>{footer}</footer>}
      </section>
    </div>
  );
}
