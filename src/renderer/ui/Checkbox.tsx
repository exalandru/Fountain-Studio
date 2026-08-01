import type { ReactNode } from 'react';

interface CheckboxProps {
  /** Drawn after the box, which is the one place a control's name does not come first. */
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (checked: boolean) => void;
}

/**
 * A tick and what it means.
 *
 * Its own component rather than a `Field` around an input, because the order is inverted: a
 * checkbox reads as "box, then statement", and a name rendered before it would leave the box
 * stranded in the middle of the sentence.
 */
export function Checkbox({ label, checked, disabled, className, onChange }: CheckboxProps) {
  return (
    <label className={className}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
