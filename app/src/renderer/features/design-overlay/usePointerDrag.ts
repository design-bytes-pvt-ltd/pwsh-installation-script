import { useRef, type PointerEvent } from 'react';

interface DragOptions {
  disabled?: boolean;
  /** Position when the drag starts. */
  origin: () => { x: number; y: number };
  onMove: (x: number, y: number) => void;
}

/**
 * Drag with pointer capture: all events go to the element that started the drag, so no
 * window-level listeners are needed (and none can leak). Spread the result onto the handle.
 */
export function usePointerDrag({ disabled, origin, onMove }: DragOptions) {
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const end = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (disabled || e.button !== 0) return;
      const o = origin();
      drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      onMove(Math.round(d.ox + e.clientX - d.sx), Math.round(d.oy + e.clientY - d.sy));
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}
