import { DEFAULT_SETTINGS, type OverlaySettings, type ReferenceImage } from './state';

/**
 * Remembers the overlay for the rest of the session (it survives a window reload) in
 * sessionStorage. Storage can be missing, full or hold anything, so every access is guarded.
 */

export const SETTINGS_KEY = 'design-overlay:v1';
export const IMAGE_KEY = 'design-overlay:v1:image';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string | number>(v: unknown, options: readonly T[]): v is T => options.includes(v as T);

/** Rebuilds settings from untrusted stored JSON, keeping only well-typed fields. */
export function sanitizeSettings(raw: unknown): OverlaySettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const t = (o.toolbar && typeof o.toolbar === 'object' ? o.toolbar : {}) as Record<string, unknown>;
  return {
    active: isBool(o.active) ? o.active : d.active,
    opacity: isNum(o.opacity) ? o.opacity : d.opacity,
    scale: isNum(o.scale) ? o.scale : d.scale,
    x: isNum(o.x) ? o.x : d.x,
    y: isNum(o.y) ? o.y : d.y,
    density: oneOf(o.density, [1, 2, 3] as const) ? o.density : d.density,
    fit: isBool(o.fit) ? o.fit : d.fit,
    visible: isBool(o.visible) ? o.visible : d.visible,
    locked: isBool(o.locked) ? o.locked : d.locked,
    clickThrough: isBool(o.clickThrough) ? o.clickThrough : d.clickThrough,
    blend: oneOf(o.blend, ['normal', 'difference'] as const) ? o.blend : d.blend,
    show: oneOf(o.show, ['overlay', 'design', 'app'] as const) ? o.show : d.show,
    toolbar: {
      x: isNum(t.x) ? t.x : null,
      y: isNum(t.y) ? t.y : null,
      collapsed: isBool(t.collapsed) ? t.collapsed : false,
    },
  };
}

export function loadSettings(): OverlaySettings | null {
  const raw = read(SETTINGS_KEY);
  return raw === null ? null : sanitizeSettings(raw);
}

export function saveSettings(settings: OverlaySettings): boolean {
  return write(SETTINGS_KEY, settings);
}

export function loadImage(): ReferenceImage | null {
  const o = read(IMAGE_KEY) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const { src, name, width, height, bytes } = o;
  if (typeof src !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(src)) return null;
  if (!isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null;
  return { src, name: typeof name === 'string' ? name : 'Reference', width, height, bytes: isNum(bytes) ? bytes : 0 };
}

/** Stores (or with null, forgets) the image. Returns false if it could not be stored (e.g. over quota). */
export function saveImage(image: ReferenceImage | null): boolean {
  const ok = write(IMAGE_KEY, image);
  // Don't leave a previous image behind if the new one did not fit.
  if (!ok && image) write(IMAGE_KEY, null);
  return ok;
}
