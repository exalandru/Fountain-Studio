import type { ReactNode, Ref, SelectHTMLAttributes } from 'react';
import type { ControlScale } from './Button.js';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  scale?: ControlScale;
  children: ReactNode;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * A native chooser.
 *
 * No wrapper element, deliberately. A wrapper would allow a stroked chevron drawn through a
 * mask, but five layout rules address the select as a direct child of its row
 * (`.voice-controls > select` among them) and would silently stop applying. The caret is
 * drawn on the control itself out of `--text-muted`, so it follows the theme — which a
 * data-URI SVG, whose fill is frozen at authoring time, cannot do.
 */
export function Select({ scale = 'standard', className, children, ...rest }: SelectProps) {
  return (
    <select className={`field control-${scale}${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </select>
  );
}
