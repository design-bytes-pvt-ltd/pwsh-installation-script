import { useLayoutEffect, useRef, useState, type ChangeEvent, type ComponentProps, type ReactNode } from 'react';
import {
  Blend,
  Camera,
  ChevronDown,
  ChevronUp,
  Columns2,
  Diff,
  Eye,
  EyeOff,
  GripVertical,
  ImageUp,
  Lock,
  LockOpen,
  MousePointerClick,
  RotateCcw,
  Scan,
  Trash2,
  X,
} from 'lucide-react';
import { Typography } from '@/components/typography';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { placeToolbar, type Size } from '../geometry';
import { ACCEPT_ATTRIBUTE } from '../image';
import { SCALE_MAX, SCALE_MIN, type Density, type OverlayAction, type OverlayState, type ShowMode } from '../state';
import { usePointerDrag } from '../usePointerDrag';
import { isMacPlatform } from '../useOverlayShortcuts';

export type CompareView = 'side-by-side' | 'diff';

interface OverlayToolbarProps {
  state: OverlayState;
  dispatch: (action: OverlayAction) => void;
  viewport: Size;
  error: string | null;
  notice: string | null;
  busy: boolean;
  canCapture: boolean;
  onFile: (file: File) => void;
  onCapture: () => void;
  onCompare: (view: CompareView) => void;
  onClose: () => void;
}

/** Icon button that shows an on/off state. */
function ToolButton({
  label,
  pressed,
  className,
  children,
  ...props
}: { label: string; pressed?: boolean; children: ReactNode } & ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(pressed && 'bg-accent text-accent-foreground', className)}
      {...props}
    >
      {children}
    </Button>
  );
}

/** A row of mutually exclusive text buttons. */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md border border-border p-0.5">
      {options.map((o) => (
        <Button
          key={o.value}
          type="button"
          size="xs"
          variant="ghost"
          title={o.title}
          aria-pressed={value === o.value}
          className={cn('flex-1 px-1.5', value === o.value && 'bg-accent text-accent-foreground')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Typography variant="caption" tone="muted">{label}</Typography>
        <Typography variant="caption" font="secondary">{value}%</Typography>
      </div>
      <Slider thumbLabel={label} min={min} max={max} step={1} value={[value]} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

function PositionInput({ axis, value, disabled, onChange }: { axis: 'X' | 'Y'; value: number; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1">
      <Typography variant="caption" tone="muted">{axis}</Typography>
      <Input
        type="number"
        step={1}
        value={value}
        disabled={disabled}
        aria-label={`Position ${axis}`}
        className="h-7 w-[68px] px-1.5 font-mono text-xs"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const v = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );
}

const DENSITIES: { value: Density; label: string; title: string }[] = [
  { value: 1, label: '1x', title: 'Exported at 1x' },
  { value: 2, label: '2x', title: 'Exported at 2x (shown at half size)' },
  { value: 3, label: '3x', title: 'Exported at 3x (shown at a third)' },
];

const SHOW_OPTIONS: { value: ShowMode; label: string; title: string }[] = [
  { value: 'overlay', label: 'Overlay', title: 'Blend the design over the app' },
  { value: 'design', label: 'Design', title: 'Design only (100%)' },
  { value: 'app', label: 'App', title: 'App only' },
];

/** The floating, draggable developer toolbar. */
export function OverlayToolbar({
  state,
  dispatch,
  viewport,
  error,
  notice,
  busy,
  canCapture,
  onFile,
  onCapture,
  onCompare,
  onClose,
}: OverlayToolbarProps) {
  const panel = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState<Size>({ width: 288, height: 0 });
  // Re-measure after every render: collapsing, errors and the image row change the height.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    if (next.width !== size.width || next.height !== size.height) setSize(next);
  });
  const position = placeToolbar(state.toolbar, size, viewport);
  const drag = usePointerDrag({
    origin: () => position,
    onMove: (x, y) => dispatch({ type: 'setToolbar', patch: placeToolbar({ x, y }, size, viewport) }),
  });

  const set = (patch: Extract<OverlayAction, { type: 'set' }>['patch']) => dispatch({ type: 'set', patch });
  const { image, collapsed } = { image: state.image, collapsed: state.toolbar.collapsed };
  const mod = isMacPlatform() ? '⌘⇧' : 'Ctrl+Shift+';

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear it so picking the same file again still fires `change`.
    e.target.value = '';
    if (file) onFile(file);
  };

  return (
    <div className="dark">
      <div
        ref={panel}
        role="dialog"
        aria-label="Design overlay"
        data-design-overlay-toolbar
        className="fixed z-[2147483001] flex w-[288px] flex-col rounded-xl border border-border bg-popover/95 text-popover-foreground shadow-2xl shadow-black/40 backdrop-blur-sm"
        style={{ left: position.x, top: position.y }}
      >
        {/* Header: drag handle, quick toggles, collapse, close. */}
        <div className="flex items-center gap-1 py-1.5 pr-1.5 pl-1">
          <div
            {...drag}
            title="Drag to move the toolbar"
            className="flex flex-1 cursor-grab items-center gap-1 self-stretch active:cursor-grabbing"
          >
            <GripVertical className="size-4 text-muted-foreground" aria-hidden />
            <Typography variant="caption" className="font-medium select-none">Design overlay</Typography>
          </div>
          {image && (
            <>
              <ToolButton
                label={state.visible ? 'Hide reference' : 'Show reference'}
                pressed={!state.visible}
                onClick={() => set({ visible: !state.visible })}
              >
                {state.visible ? <Eye /> : <EyeOff />}
              </ToolButton>
              <ToolButton label={state.locked ? 'Unlock position' : 'Lock position'} pressed={state.locked} onClick={() => set({ locked: !state.locked })}>
                {state.locked ? <Lock /> : <LockOpen />}
              </ToolButton>
            </>
          )}
          <ToolButton
            label={collapsed ? 'Expand toolbar' : 'Collapse toolbar'}
            onClick={() => dispatch({ type: 'setToolbar', patch: { collapsed: !collapsed } })}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </ToolButton>
          <ToolButton label={`Close overlay (${mod}D)`} onClick={onClose}>
            <X />
          </ToolButton>
        </div>

        {!collapsed && (
          <div className="flex flex-col gap-3 border-t border-border px-3 pt-3 pb-2.5">
            <input ref={fileInput} type="file" accept={ACCEPT_ATTRIBUTE} hidden onChange={pickFile} data-testid="design-overlay-file" />
            {image ? (
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <Typography variant="caption" className="truncate font-medium" title={image.name}>{image.name}</Typography>
                  <Typography variant="caption" font="secondary" tone="muted">
                    {image.width}×{image.height}
                  </Typography>
                </div>
                <ToolButton label="Replace image" onClick={() => fileInput.current?.click()}>
                  <ImageUp />
                </ToolButton>
                <ToolButton label="Remove image" onClick={() => dispatch({ type: 'removeImage' })}>
                  <Trash2 />
                </ToolButton>
              </div>
            ) : (
              <Button type="button" variant="outline" className="h-auto flex-col gap-1 border-dashed py-3" onClick={() => fileInput.current?.click()}>
                <ImageUp className="size-5" />
                <span>Upload reference image</span>
                <Typography variant="caption" tone="muted">PNG or JPEG, or paste from Figma</Typography>
              </Button>
            )}
            {error && (
              <Typography role="alert" variant="caption" className="rounded-md bg-destructive-subtle px-2 py-1 text-destructive">
                {error}
              </Typography>
            )}
            {notice && !error && (
              <Typography variant="caption" tone="muted">{notice}</Typography>
            )}

            {image && (
              <>
                <SliderField label="Opacity" min={0} max={100} value={Math.round(state.opacity * 100)} onChange={(v) => set({ opacity: v / 100, show: 'overlay' })} />
                <SliderField label="Scale" min={SCALE_MIN * 100} max={SCALE_MAX * 100} value={Math.round(state.scale * 100)} onChange={(v) => set({ scale: v / 100 })} />

                <div className="flex items-center justify-between gap-2">
                  <PositionInput axis="X" value={state.x} disabled={state.locked} onChange={(x) => dispatch({ type: 'moveTo', x, y: state.y })} />
                  <PositionInput axis="Y" value={state.y} disabled={state.locked} onChange={(y) => dispatch({ type: 'moveTo', x: state.x, y })} />
                  <ToolButton label="Fit to window" pressed={state.fit} onClick={() => set({ fit: !state.fit })}>
                    <Scan />
                  </ToolButton>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Segmented label="Export density" value={state.density} options={DENSITIES} onChange={(density) => set({ density })} />
                  </div>
                  <ToolButton
                    label="Click-through (interact with the app under the image)"
                    pressed={state.clickThrough}
                    onClick={() => set({ clickThrough: !state.clickThrough })}
                  >
                    <MousePointerClick />
                  </ToolButton>
                  <ToolButton
                    label="Difference blend"
                    pressed={state.blend === 'difference'}
                    onClick={() => set({ blend: state.blend === 'difference' ? 'normal' : 'difference' })}
                  >
                    <Blend />
                  </ToolButton>
                </div>

                <Segmented label={`Show (${mod}B flips design / app)`} value={state.show} options={SHOW_OPTIONS} onChange={(show) => set({ show })} />

                <div className="flex items-center gap-1 border-t border-border pt-2">
                  <ToolButton label="Save a screenshot of the app" disabled={!canCapture || busy} onClick={onCapture}>
                    <Camera />
                  </ToolButton>
                  <ToolButton label="Side by side" disabled={!canCapture || busy} onClick={() => onCompare('side-by-side')}>
                    <Columns2 />
                  </ToolButton>
                  <ToolButton label="Pixel difference" disabled={!canCapture || busy} onClick={() => onCompare('diff')}>
                    <Diff />
                  </ToolButton>
                  <div className="flex-1" />
                  <Button type="button" variant="ghost" size="xs" title={`Reset opacity, scale and position (${mod}R)`} onClick={() => dispatch({ type: 'reset' })}>
                    <RotateCcw /> Reset
                  </Button>
                </div>
              </>
            )}

            <Typography variant="caption" tone="muted" font="secondary" className="text-[11px] leading-tight">
              {mod}D toggle · {mod}↑↓ opacity · arrows move (⇧ ×10)
            </Typography>
          </div>
        )}
      </div>
    </div>
  );
}
