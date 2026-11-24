// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IMAGE_KEY, loadImage, loadSettings, saveImage, saveSettings, SETTINGS_KEY } from '../persistence';
import { DEFAULT_SETTINGS } from '../state';

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const image = { src: 'data:image/png;base64,AAAA', name: 'a.png', width: 10, height: 5, bytes: 3 };

describe('persistence', () => {
  test('round-trips settings and the image', () => {
    const settings = { ...DEFAULT_SETTINGS, active: true, opacity: 0.3, x: 12, toolbar: { x: 5, y: 6, collapsed: true } };
    expect(saveSettings(settings)).toBe(true);
    expect(saveImage(image)).toBe(true);
    expect(loadSettings()).toEqual(settings);
    expect(loadImage()).toEqual(image);
  });

  test('nothing stored gives null', () => {
    expect(loadSettings()).toBeNull();
    expect(loadImage()).toBeNull();
  });

  test('corrupt or mistyped data falls back to defaults', () => {
    sessionStorage.setItem(SETTINGS_KEY, '{not json');
    expect(loadSettings()).toBeNull();
    sessionStorage.setItem(SETTINGS_KEY, JSON.stringify({ opacity: 'loud', density: 7, show: 'x', locked: true }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, locked: true });
    sessionStorage.setItem(IMAGE_KEY, JSON.stringify({ ...image, src: 'javascript:alert(1)' }));
    expect(loadImage()).toBeNull();
  });

  test('a full storage does not throw and forgets the previous image', () => {
    saveImage(image);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(saveImage({ ...image, name: 'b.png' })).toBe(false);
    expect(saveSettings(DEFAULT_SETTINGS)).toBe(false);
    setItem.mockRestore();
    expect(loadImage()).toBeNull();
  });
});
