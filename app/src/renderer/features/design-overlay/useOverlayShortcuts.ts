import { useEffect, useRef } from 'react';
import { OPACITY_STEP } from './state';

export const NUDGE_SMALL = 1;
export const NUDGE_LARGE = 10;

export function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent);
}

/** Cmd on macOS, Ctrl elsewhere, and not the other one. */
function hasMod(e: KeyboardEvent, mac: boolean): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Focus is somewhere that uses arrow keys itself (text fields, sliders, lists...). */
export function usesArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest(
    'input, textarea, select, [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="radiogroup"], [role="tablist"], [role="grid"], [role="tree"]'
  ) != null;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export interface ShortcutContext {
  active: boolean;
  /** An image is shown and unlocked, and no compare panel is open. */
  canNudge: boolean;
  hasImage: boolean;
}

export interface ShortcutHandlers {
  toggleActive: () => void;
  adjustOpacity: (delta: number) => void;
  reset: () => void;
  flipShow: () => void;
  nudge: (dx: number, dy: number) => void;
}

/** Maps a key press to an overlay command; returns false when the key is not ours. */
export function handleOverlayKey(e: KeyboardEvent, ctx: ShortcutContext, h: ShortcutHandlers, mac = isMacPlatform()): boolean {
  if (e.altKey) return false;
  if (hasMod(e, mac) && e.shiftKey) {
    let command: (() => void) | null = null;
    if (e.code === 'KeyD') command = h.toggleActive;
    else if (!ctx.active) command = null;
    else if (e.key === 'ArrowUp') command = () => h.adjustOpacity(OPACITY_STEP);
    else if (e.key === 'ArrowDown') command = () => h.adjustOpacity(-OPACITY_STEP);
    else if (e.code === 'KeyR') command = h.reset;
    else if (e.code === 'KeyB' && ctx.hasImage) command = h.flipShow;
    command?.();
    return command != null;
  }
  const arrow = ARROWS[e.key];
  if (!arrow || e.metaKey || e.ctrlKey || !ctx.active || !ctx.canNudge || usesArrowKeys(e.target)) return false;
  const step = e.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
  h.nudge(arrow[0] * step, arrow[1] * step);
  return true;
}

/**
 * The overlay's keyboard shortcuts: one capture-phase keydown listener on window, added once and
 * removed on unmount. Handled keys are not passed on (so Cmd/Ctrl+Shift+R does not reload, and
 * arrows don't scroll); every other key reaches the app untouched.
 */
export function useOverlayShortcuts(ctx: ShortcutContext, handlers: ShortcutHandlers): void {
  const latest = useRef({ ctx, handlers });
  latest.current = { ctx, handlers };
  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      if (handleOverlayKey(e, latest.current.ctx, latest.current.handlers, mac)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
