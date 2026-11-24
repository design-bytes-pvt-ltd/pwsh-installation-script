import type { Density, OverlaySettings, ReferenceImage } from './state';

export interface Size {
  width: number;
  height: number;
}

/**
 * The reference image's on-screen size in CSS px. A Figma export at `density`x is shown at
 * 1/density of its pixel size; "fit" then scales it to fit inside the viewport; the scale slider
 * applies last. Width and height use one factor, so the aspect ratio is always preserved.
 */
export function referenceSize(
  image: Pick<ReferenceImage, 'width' | 'height'>,
  settings: Pick<OverlaySettings, 'density' | 'fit' | 'scale'>,
  viewport: Size
): Size {
  const baseWidth = image.width / settings.density;
  const baseHeight = image.height / settings.density;
  const fit =
    settings.fit && baseWidth > 0 && baseHeight > 0
      ? Math.min(viewport.width / baseWidth, viewport.height / baseHeight)
      : 1;
  const factor = fit * settings.scale;
  return { width: baseWidth * factor, height: baseHeight * factor };
}

/** Guesses the export density (@1x/@2x/@3x) from how much wider the image is than the window. */
export function guessDensity(imageWidth: number, viewportWidth: number): Density {
  if (viewportWidth <= 0) return 1;
  const ratio = imageWidth / viewportWidth;
  if (ratio >= 2.5) return 3;
  if (ratio >= 1.5) return 2;
  return 1;
}

/**
 * Keeps a floating panel of `size` fully inside the viewport (with a margin). Unplaced, it goes top-right,
 * clear of the footer where the app's main buttons are.
 */
export function placeToolbar(
  position: { x: number | null; y: number | null },
  size: Size,
  viewport: Size,
  margin = 12
): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  const x = position.x ?? maxX;
  const y = position.y ?? margin;
  return { x: Math.round(Math.min(maxX, Math.max(margin, x))), y: Math.round(Math.min(maxY, Math.max(margin, y))) };
}
