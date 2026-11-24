import { describe, expect, test } from 'vitest';
import { effectiveOpacity, initialOverlayState, overlayReducer, type OverlayState, type ReferenceImage } from '../state';

const image: ReferenceImage = { src: 'data:image/png;base64,AA', name: 'a.png', width: 100, height: 50, bytes: 10 };
const withImage = (patch: Partial<OverlayState> = {}): OverlayState => ({ ...initialOverlayState, image, active: true, ...patch });

describe('overlayReducer', () => {
  test('defaults: 50% opacity, 100% scale, at the origin, click-through', () => {
    expect(initialOverlayState).toMatchObject({ opacity: 0.5, scale: 1, x: 0, y: 0, clickThrough: true, active: false });
  });

  test('clamps opacity to 0–100% and scale to 50–150%', () => {
    let s = overlayReducer(withImage(), { type: 'set', patch: { opacity: 3, scale: 9 } });
    expect(s).toMatchObject({ opacity: 1, scale: 1.5 });
    s = overlayReducer(s, { type: 'set', patch: { opacity: -1, scale: 0.1 } });
    expect(s).toMatchObject({ opacity: 0, scale: 0.5 });
  });

  test('adjustOpacity steps and switches back to the blended overlay', () => {
    const s = overlayReducer(withImage({ show: 'design', opacity: 0.98 }), { type: 'adjustOpacity', delta: 0.05 });
    expect(s).toMatchObject({ opacity: 1, show: 'overlay' });
  });

  test('nudge moves by whole pixels; moveTo sets the position', () => {
    let s = overlayReducer(withImage(), { type: 'nudge', dx: 10, dy: -1 });
    expect(s).toMatchObject({ x: 10, y: -1 });
    s = overlayReducer(s, { type: 'moveTo', x: 3.6, y: 4.2 });
    expect(s).toMatchObject({ x: 4, y: 4 });
  });

  test('lock blocks nudges and drags', () => {
    const locked = withImage({ locked: true, x: 5, y: 5 });
    expect(overlayReducer(locked, { type: 'nudge', dx: 1, dy: 1 })).toBe(locked);
    expect(overlayReducer(locked, { type: 'moveTo', x: 0, y: 0 })).toBe(locked);
  });

  test('reset restores opacity, scale and position but keeps the image and toggles', () => {
    const s = overlayReducer(withImage({ opacity: 0.2, scale: 1.3, x: 40, y: 9, locked: true, show: 'app' }), { type: 'reset' });
    expect(s).toMatchObject({ opacity: 0.5, scale: 1, x: 0, y: 0, show: 'overlay', locked: true, image });
  });

  test('flipShow alternates design and app; opacity is untouched', () => {
    let s = overlayReducer(withImage({ opacity: 0.3 }), { type: 'flipShow' });
    expect(s.show).toBe('design');
    expect(effectiveOpacity(s)).toBe(1);
    s = overlayReducer(s, { type: 'flipShow' });
    expect(s.show).toBe('app');
    expect(effectiveOpacity(s)).toBe(0);
    s = overlayReducer(s, { type: 'set', patch: { show: 'overlay' } });
    expect(effectiveOpacity(s)).toBe(0.3);
  });

  test('loading an image shows it with the guessed density; removing keeps the settings', () => {
    let s = overlayReducer(withImage({ image: null, visible: false, opacity: 0.7 }), { type: 'loadImage', image, density: 2 });
    expect(s).toMatchObject({ image, density: 2, visible: true, opacity: 0.7 });
    s = overlayReducer(s, { type: 'removeImage' });
    expect(s).toMatchObject({ image: null, opacity: 0.7 });
  });
});
