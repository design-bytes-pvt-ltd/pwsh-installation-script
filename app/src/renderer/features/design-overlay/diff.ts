import { decodeImage } from './image';
import type { Size } from './geometry';

export interface PixelDiff {
  /** RGBA pixels of the diff image. */
  data: Uint8ClampedArray<ArrayBuffer>;
  /** Pixels that differ by more than the threshold. */
  mismatched: number;
  /** Pixels that were compared (covered by the reference). */
  compared: number;
  /** mismatched / compared (0 when nothing was compared). */
  ratio: number;
}

/**
 * Compares two RGBA buffers of the same size. A pixel differs when any colour channel differs by
 * more than `threshold` (0–255). Pixels where the reference (`b`) is fully transparent are not
 * compared. Differences are drawn magenta, matches as a faded greyscale of the app (`a`).
 */
export function diffPixels(a: ArrayLike<number>, b: ArrayLike<number>, threshold = 16): PixelDiff {
  if (a.length !== b.length) throw new Error('Images must be the same size.');
  const out = new Uint8ClampedArray(a.length);
  let mismatched = 0;
  let compared = 0;
  for (let i = 0; i < a.length; i += 4) {
    const lum = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const faded = 255 - (255 - lum) * 0.25;
    out[i + 3] = 255;
    if (b[i + 3] === 0) {
      out[i] = out[i + 1] = out[i + 2] = Math.min(255, faded + 10);
      continue;
    }
    compared++;
    const delta = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (delta > threshold) {
      mismatched++;
      out[i] = 255;
      out[i + 1] = 0;
      out[i + 2] = 255;
    } else {
      out[i] = out[i + 1] = out[i + 2] = faded;
    }
  }
  return { data: out, mismatched, compared, ratio: compared ? mismatched / compared : 0 };
}

export interface DiffResult {
  /** PNG data URL of the diff image. */
  src: string;
  mismatched: number;
  compared: number;
  ratio: number;
}

/** Where the reference sits on screen (CSS px), as the overlay draws it. */
export interface ReferenceLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

function canvas(size: Size): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(size.width));
  c.height = Math.max(1, Math.round(size.height));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available.');
  return { canvas: c, ctx };
}

/**
 * Diffs a screenshot of the app against the reference placed exactly as the overlay shows it.
 * Both are drawn at the viewport's CSS size (the screenshot is in device pixels, so it is scaled).
 */
export async function buildDiff(
  screenshotSrc: string,
  referenceSrc: string,
  layout: ReferenceLayout,
  viewport: Size,
  threshold: number
): Promise<DiffResult> {
  const [shot, ref] = await Promise.all([decodeImage(screenshotSrc), decodeImage(referenceSrc)]);
  const app = canvas(viewport);
  app.ctx.drawImage(shot.element, 0, 0, app.canvas.width, app.canvas.height);
  const design = canvas(viewport);
  design.ctx.drawImage(ref.element, layout.x, layout.y, layout.width, layout.height);
  const w = app.canvas.width;
  const h = app.canvas.height;
  const result = diffPixels(app.ctx.getImageData(0, 0, w, h).data, design.ctx.getImageData(0, 0, w, h).data, threshold);
  const out = canvas(viewport);
  out.ctx.putImageData(new ImageData(result.data, w, h), 0, 0);
  return { src: out.canvas.toDataURL('image/png'), mismatched: result.mismatched, compared: result.compared, ratio: result.ratio };
}
