import type { ButtonHTMLAttributes, Ref } from 'react';

/**
 * The two ranks the interface uses.
 *
 * `compact` is the rank of a toolbar or a panel header; `standard` is the rank of anything a
 * dialog asks the author to read before pressing. Named `scale` rather than `size` because
 * `size` is a real HTML attribute on the input and the select this same vocabulary covers,
 * and shadowing it would mean an `Omit<>` on two of the three controls.
 */
export type ControlScale = 'compact' | 'standard';

/**
 * `primary` commits, `danger` destroys, `quiet` is an action that must not compete with the
 * text beside it, and `neutral` is everything else. There is deliberately no `secondary`: a
 * dialog with two ranks of emphasis below the primary reads as three primaries.
 */
export type ButtonVariant = 'neutral' | 'primary' | 'danger' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  scale?: ControlScale;
  /** Square, for a button whose glyph is its label. Pair with an `aria-label`. */
  icon?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Every button the interface asks the author to press.
 *
 * The emphasis is declared, never positional. The dialog footers used to take theirs from
 * `:last-child`, which meant a button added beside the committing one silently stole its
 * paint; here the commitment is stated on the button that carries it.
 */
export function Button({
  variant = 'neutral',
  scale = 'standard',
  icon = false,
  // Always written out: a button inside a form defaults to `submit`, and two of these live
  // in one. Every call site in this codebase already said so by hand; the default only makes
  // the discipline free.
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const classes = ['button', `button-${variant}`, `control-${scale}`];
  if (icon) classes.push('button-icon');
  if (className) classes.push(className);
  return <button type={type} className={classes.join(' ')} {...rest} />;
}
