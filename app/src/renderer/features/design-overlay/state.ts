/** Design overlay state: pure reducer, no React or DOM. */

export type Density = 1 | 2 | 3;
export type BlendMode = 'normal' | 'difference';
/** What the window shows: the blended overlay, the design alone (100%), or the app alone. */
export type ShowMode = 'overlay' | 'design' | 'app';

export interface ReferenceImage {
  /** data: URL (the CSP allows `data:` images, not `blob:`). */
  src: string;
  name: string;
  /** Natural size in image pixels. */
  width: number;
  height: number;
  bytes: number;
}

export interface ToolbarPosition {
  /** Left/top in CSS px; null until placed (defaults to the top-right corner). */
  x: number | null;
  y: number | null;
  collapsed: boolean;
}

export interface OverlaySettings {
  active: boolean;
  /** 0–1. */
  opacity: number;
  /** 0.5–1.5. */
  scale: number;
  x: number;
  y: number;
  density: Density;
  fit: boolean;
  visible: boolean;
  locked: boolean;
  clickThrough: boolean;
  blend: BlendMode;
  show: ShowMode;
  toolbar: ToolbarPosition;
}

export interface OverlayState extends OverlaySettings {
  image: ReferenceImage | null;
}

export const OPACITY_STEP = 0.05;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1.5;
export const POSITION_LIMIT = 10_000;

export const DEFAULT_SETTINGS: OverlaySettings = {
  active: false,
  opacity: 0.5,
  scale: 1,
  x: 0,
  y: 0,
  density: 1,
  fit: false,
  visible: true,
  locked: false,
  clickThrough: true,
  blend: 'normal',
  show: 'overlay',
  toolbar: { x: null, y: null, collapsed: false },
};

export const initialOverlayState: OverlayState = { ...DEFAULT_SETTINGS, image: null };

export type OverlayAction =
  | { type: 'toggleActive' }
  | { type: 'setActive'; active: boolean }
  | { type: 'set'; patch: Partial<Omit<OverlaySettings, 'x' | 'y' | 'toolbar'>> }
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'adjustOpacity'; delta: number }
  | { type: 'reset' }
  | { type: 'flipShow' }
  | { type: 'loadImage'; image: ReferenceImage; density: Density }
  | { type: 'removeImage' }
  | { type: 'setToolbar'; patch: Partial<ToolbarPosition> };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const toPosition = (v: number) => clamp(Math.round(v), -POSITION_LIMIT, POSITION_LIMIT);

export const clampOpacity = (v: number) => round(clamp(v, 0, 1));
export const clampScale = (v: number) => round(clamp(v, SCALE_MIN, SCALE_MAX));

/** Brings every numeric setting back into range (used after patches and when restoring a session). */
export function normalize(state: OverlayState): OverlayState {
  return {
    ...state,
    opacity: clampOpacity(state.opacity),
    scale: clampScale(state.scale),
    x: toPosition(state.x),
    y: toPosition(state.y),
    density: ([1, 2, 3] as const).includes(state.density) ? state.density : 1,
  };
}

export function overlayReducer(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case 'toggleActive':
      return { ...state, active: !state.active };
    case 'setActive':
      return state.active === action.active ? state : { ...state, active: action.active };
    case 'set':
      return normalize({ ...state, ...action.patch });
    case 'moveTo':
      if (state.locked) return state;
      return normalize({ ...state, x: action.x, y: action.y });
    case 'nudge':
      if (state.locked) return state;
      return normalize({ ...state, x: state.x + action.dx, y: state.y + action.dy });
    case 'adjustOpacity':
      // Changing the opacity only makes sense while blending, so it switches back to the overlay.
      return { ...state, show: 'overlay', opacity: clampOpacity(state.opacity + action.delta) };
    case 'reset':
      return {
        ...state,
        opacity: DEFAULT_SETTINGS.opacity,
        scale: DEFAULT_SETTINGS.scale,
        x: DEFAULT_SETTINGS.x,
        y: DEFAULT_SETTINGS.y,
        show: 'overlay',
      };
    case 'flipShow':
      return { ...state, show: state.show === 'design' ? 'app' : 'design' };
    case 'loadImage':
      return { ...state, image: action.image, density: action.density, visible: true };
    case 'removeImage':
      return { ...state, image: null, show: 'overlay' };
    case 'setToolbar':
      return { ...state, toolbar: { ...state.toolbar, ...action.patch } };
  }
}

/** Opacity the reference is drawn with, after the Show mode. */
export function effectiveOpacity(state: Pick<OverlaySettings, 'show' | 'opacity'>): number {
  if (state.show === 'design') return 1;
  if (state.show === 'app') return 0;
  return state.opacity;
}

/** The persisted part of the state (the image is stored separately). */
export function settingsOf(state: OverlayState): OverlaySettings {
  const { image: _image, ...settings } = state;
  return settings;
}
