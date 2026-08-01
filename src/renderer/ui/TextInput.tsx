import type { InputHTMLAttributes, Ref } from 'react';
import type { ControlScale } from './Button.js';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  scale?: ControlScale;
  ref?: Ref<HTMLInputElement>;
}

/**
 * A single-line field: text, search, url, password, number, date.
 *
 * Not for a checkbox, a radio or a range — those are widgets rather than fields, they carry
 * their own geometry, and the stylesheet excludes them from the field rank by attribute.
 */
export function TextInput({ scale = 'standard', className, ...rest }: TextInputProps) {
  return (
    <input className={`field control-${scale}${className ? ` ${className}` : ''}`} {...rest} />
  );
}
