import { cn } from '@/lib/utils';
import type { ReferenceLayout } from '../diff';
import type { BlendMode } from '../state';
import { usePointerDrag } from '../usePointerDrag';

interface ReferenceLayerProps {
  src: string;
  name: string;
  layout: ReferenceLayout;
  opacity: number;
  blend: BlendMode;
  /** True when the image takes the mouse (unlocked, click-through off); otherwise clicks pass through. */
  draggable: boolean;
  onMove: (x: number, y: number) => void;
}

/**
 * The reference image, fixed above the whole app. The layer itself never takes the mouse; the
 * image does only while it can be dragged. Geometry and opacity change continuously, so they go
 * in `style` (set through the DOM, which the CSP's `style-src 'self'` allows).
 */
export function ReferenceLayer({ src, name, layout, opacity, blend, draggable, onMove }: ReferenceLayerProps) {
  const drag = usePointerDrag({
    disabled: !draggable,
    origin: () => ({ x: layout.x, y: layout.y }),
    onMove,
  });
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[2147483000] overflow-hidden">
      <img
        src={src}
        alt=""
        title={draggable ? `${name} (drag to move)` : undefined}
        draggable={false}
        data-testid="design-overlay-image"
        className={cn(
          'absolute top-0 left-0 max-w-none select-none',
          draggable ? 'pointer-events-auto cursor-move' : 'pointer-events-none'
        )}
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${layout.x}px, ${layout.y}px)`,
          opacity,
          mixBlendMode: blend,
        }}
        {...drag}
      />
    </div>
  );
}
