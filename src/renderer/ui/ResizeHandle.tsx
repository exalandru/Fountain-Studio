import { useRef } from 'react';

export interface ResizeHandleProps {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  /** The controlled pane is immediately to the right of the handle. */
  onChange: (value: number) => void;
}

export function ResizeHandle({ label, value, minimum, maximum, onChange }: ResizeHandleProps) {
  const start = useRef({ x: 0, value: 0 });

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    start.current = { x: event.clientX, value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const next = start.current.value - (event.clientX - start.current.x);
    onChange(Math.min(maximum, Math.max(minimum, Math.round(next))));
  };

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 25 : 10;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onChange(Math.min(maximum, value + step));
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onChange(Math.max(minimum, value - step));
        }
      }}
    />
  );
}
