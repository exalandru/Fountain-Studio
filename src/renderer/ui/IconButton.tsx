import { useId } from 'react';
import type { ReactNode, Ref } from 'react';

interface IconButtonProps {
  /** An icon has no text, so the accessible name is not optional. */
  label: string;
  /**
   * A longer hint, drawn on hover and on keyboard focus.
   *
   * Left out, no tooltip element is rendered at all and the control is a bare `<button>` —
   * which is what lets this drop into the formatting toolbar without changing its DOM.
   *
   * A rendered element rather than the `title` attribute on purpose: `title` appears after a
   * delay the platform chooses, cannot be styled, and never appears for a keyboard user. A
   * test asserts these buttons carry no `title`.
   */
  tooltip?: string;
  /** `aria-pressed`. Left undefined for an action that does not toggle. */
  active?: boolean;
  disabled?: boolean;
  /** A layout hook, for the rare icon button that also has to sit in a grid area. */
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
}

/**
 * A square, borderless, icon-only control.
 *
 * This was a private function inside the top toolbar; exporting it is what gives the
 * formatting toolbar the same focus ring, the same pressed state and the same tooltip
 * contract instead of a second implementation of all three.
 */
export function IconButton({
  label,
  tooltip,
  active,
  disabled,
  className,
  children,
  ref,
  onClick,
}: IconButtonProps) {
  const tooltipId = useId();

  const control = (
    <button
      ref={ref}
      type="button"
      className={`toolbar-icon-button${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-describedby={tooltip === undefined ? undefined : tooltipId}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );

  if (tooltip === undefined) return control;

  return (
    <span className="toolbar-button-wrap">
      {control}
      <span className="toolbar-tooltip" id={tooltipId} role="tooltip">
        {tooltip}
      </span>
    </span>
  );
}
