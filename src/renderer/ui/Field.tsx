import type { ReactNode } from 'react';

interface FieldProps {
  /**
   * A node rather than a string: the API key field composes its name from the provider's
   * requirement and from whether a key is already stored, and the E2E suite matches both
   * spellings.
   */
  label: ReactNode;
  /**
   * Hides the label from sight while leaving it in the accessibility tree — for the fields
   * whose visible name is a heading, a legend, or the placement itself. Never drop the label
   * instead: `getByLabel` is how some thirty E2E assertions find these controls.
   */
  labelHidden?: boolean;
  /** A note or a hint drawn under the control, inside the same label. */
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * A control with its name.
 *
 * A wrapping `<label>` rather than `htmlFor`/`id`: the association survives a control moving
 * between files, and there is no generated id to collide with another dialog's.
 */
export function Field({ label, labelHidden = false, hint, className, children }: FieldProps) {
  return (
    <label className={className}>
      <span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
      {children}
      {hint}
    </label>
  );
}
