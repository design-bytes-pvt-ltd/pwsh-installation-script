import { devToolsApi } from '@/services/devToolsApi';

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Screenshots the app without the overlay: `hide` must synchronously hide the overlay and toolbar
 * (e.g. with flushSync); two frames later the page is painted without them. `restore` always runs.
 */
export async function captureApp(
  hide: () => void,
  restore: () => void,
  capture: () => Promise<string> = devToolsApi.capturePage
): Promise<string> {
  hide();
  try {
    await nextFrame();
    await nextFrame();
    return await capture();
  } finally {
    restore();
  }
}

/** Saves a data URL through the browser's download flow (Electron shows a Save dialog). */
export function downloadDataUrl(src: string, filename: string): void {
  const a = document.createElement('a');
  a.href = src;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** e.g. "app-2026-11-24-153012.png". */
export function timestampedName(prefix: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.png`;
}
